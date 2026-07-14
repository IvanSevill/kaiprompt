// What the API answers with: the queue, a job, a conversation, an output — as the phone
// sees them.
//
// Shapes only. Nothing here opens a socket, and nothing here decides who is allowed to ask;
// that is the HTTP layer's job. Which means every one of these can be tested by calling it.
//
// The rule that matters: these read the SAME lib/ the CLI reads. The phone is a second
// front-end, never a second implementation — that is what stops it from quietly disagreeing
// with the terminal about what this machine is doing.

import fs from 'node:fs';
import os from 'node:os';

import { loadQueue, loadSessions, outPath } from './store.mjs';
import { jobPreview, resolvePrompt } from './prompt.mjs';
import { findTranscript, parseTranscript, resolveRef } from './chat.mjs';
import { readUsage, sessionQuota } from './quota.mjs';
import { runnerStatus } from './runner-status.mjs';
import { nextScheduledAt } from './schedule.mjs';
import { activityState } from './activity.mjs';
import { aggregateUsage } from './usage.mjs';
import { BOOTED_AT, clientList, serverConfig, VERSION } from './server-pair.mjs';
import { cursorFor, liveEvents } from './live-events.mjs';

/** A job, as the phone sees it. The prompt is resolved (a --from job reads its file). */
function jobDTO(job) {
  let prompt;
  try { prompt = resolvePrompt(job); }
  catch (e) { prompt = null; job = { ...job, promptError: e.message.split('\n')[0] }; }

  return {
    id: job.id,
    status: job.status,
    prompt,                                   // the FULL prompt: nothing to hide, nothing leaves the machine
    promptFile: job.promptFile ?? null,
    promptError: job.promptError ?? null,
    preview: jobPreview(job, 80),
    target: job.target ?? null,
    sessionId: job.sessionId ?? null,
    adapter: job.adapter,
    provider: job.provider ?? null,
    model: job.model ?? null,
    dir: job.dir ?? null,
    when: job.when ?? null,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    // Written by the runner when the quota cut this job short and put it back in the queue.
    // It is the difference, from a phone, between "it is broken" and "it is waiting" — the
    // two states that look identical and mean opposite things.
    pausedUntil: job.pausedUntil ?? null,
    error: job.error ?? null,
    hasOutput: Boolean(job.output),
  };
}

/** Everything the main screen needs, in one call. */
export function stateDTO() {
  const queue = loadQueue();
  const r = runnerStatus();
  const q = sessionQuota();
  const usage = readUsage();
  const jobs = queue.map(jobDTO);

  return {
    host: os.hostname(),
    now: Date.now(),
    jobs,
    counts: ['pending', 'running', 'done', 'error', 'missed'].reduce((acc, s) => {
      acc[s] = queue.filter((j) => j.status === s).length;
      return acc;
    }, {}),
    // "Will anything actually fire?" is the question the phone most needs answered.
    // The phone kept showing a red "the daemon is off, nothing will fire" while a `kaip run`
    // in a terminal was about to fire it. The question is not whether the daemon exists —
    // it is whether ANYONE is processing the queue. So it is asked in exactly one place, and
    // the phone, the GUI and the goodbye screen all read the same answer.
    daemon: {
      running: Boolean(r.willFire),           // "will my scheduled work go out?"
      kind: r.kind,                           // 'daemon' | 'run' | null
      durable: r.durable,                     // a `run` dies with its window; the daemon does not
      pid: r.pid ?? null,
      next: nextScheduledAt(queue),           // when the next scheduled job is due
      since: r.since ?? null,                 // when that runner took over
    },
    quota: (q || usage?.weekly) ? {
      freePct: q?.freePct ?? null,
      resetsAt: q?.resetsAt ?? null,
      renewed: q?.renewed ?? false,
      weekly: usage?.weekly ? {
        freePct: usage.weekly.freePct,
        resetsAt: usage.weekly.resetsAt,
      } : null,
    } : null,

    // The one line at the top of the phone. Derived here so the terminal panel and the phone
    // cannot disagree about what this machine is doing.
    activity: activityState({ jobs, willFire: Boolean(r.willFire) }),

    // Diagnosis. Not what you look at every time — which is exactly why it lives behind
    // Settings in the app rather than shouting from the main screen.
    server: {
      version: VERSION,
      startedAt: BOOTED_AT,
      tunnel: serverConfig().publicUrl ?? null,
      clients: clientList(),
      devices: (serverConfig().devices ?? []).map((x) => ({ name: x.name, pairedAt: x.pairedAt })),
    },
  };
}

/** The conversations, grouped by target — several jobs share one chat, and that is the point. */
export function targetsDTO() {
  const sessions = loadSessions();
  const queue = loadQueue();

  return Object.entries(sessions).flatMap(([target, raw]) => Object.values(raw?.engines ?? { [raw?.adapter ?? 'claude']: raw }).filter(Boolean).map((s) => ({
    target,
    sessionId: s.sessionId,
    adapter: s.adapter,
    updatedAt: s.updatedAt,
    jobs: queue.filter((j) => j.target === target).map((j) => j.id),
  }))).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Historical usage, separately requested so it never delays the live queue screen. */
export function usageDTO() {
  const all = aggregateUsage();
  const providers = [...new Set(all.sessions
    .filter((row) => row.engine === 'opencode' && row.provider)
    .map((row) => row.provider))].sort();
  const scopes = [
    { key: 'claude', engine: 'claude', provider: null },
    { key: 'codex', engine: 'codex', provider: null },
    ...providers.map((provider) => ({ key: `opencode:${provider}`, engine: 'opencode', provider })),
  ];
  return {
    scopes: scopes.map((scope) => ({ ...scope, ...aggregateUsage(scope) })),
  };
}

// OpenCode and Codex keep their transcripts outside Claude Code's JSONL store. The queue is
// still an honest local record of what we sent and what came back, so expose that conversation
// rather than telling the phone the launch never existed.
function adapterChatDTO({ sessionId, target, jobs, engineJob = jobs.at(-1) }) {
  const turns = [];
  for (const job of jobs) {
    let prompt = null;
    try { prompt = resolvePrompt(job); } catch { /* the job card already carries the file error */ }
    if (prompt) turns.push({
      role: 'user', at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      toolResult: false, sidechain: false, blocks: [{ type: 'text', text: prompt }],
    });
    let output = '';
    try { output = fs.readFileSync(outPath(job.id), 'utf8').trim(); } catch { /* no result yet */ }
    if (output || job.error) turns.push({
      role: 'assistant', at: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      toolResult: false, sidechain: false,
      blocks: [{ type: 'text', text: output || String(job.error) }],
    });
    if (!output && job.status === 'running') {
      const events = liveEvents(job.id);
      const blocks = events.flatMap((event) => {
        if (event.kind === 'text') return [{ type: 'text', text: event.text, eventId: event.id }];
        if (event.kind === 'tool') return [{ type: 'tool', name: event.name, input: event.input, eventId: event.id }];
        if (event.kind === 'todos') return [{ type: 'todos', todos: event.todos, eventId: event.id }];
        return [];
      });
      if (blocks.length) turns.push({
        role: 'assistant', at: events[0]?.at ? new Date(events[0].at).toISOString() : null,
        toolResult: false, sidechain: false, live: true, blocks,
      });
    }
  }
  return {
    sessionId, target, dir: jobs[0]?.dir ?? null, jobs: jobs.map((j) => j.id),
    adapter: engineJob?.adapter ?? null,
    provider: engineJob?.provider ?? null,
    model: engineJob?.model ?? null,
    first: turns[0]?.at ?? null, last: turns.at(-1)?.at ?? null,
    cursor: jobs.map((job) => cursorFor(job.id)).filter(Boolean).at(-1) ?? null, turns,
  };
}

/**
 * The WHOLE conversation, as structured turns. No truncation: this is the payoff of not
 * using a cloud relay — the transcript never leaves your machine, so there is nothing to
 * be careful about.
 */
export function chatDTO(ref) {
  const queue = loadQueue();
  const direct = queue.find((job) => job.id === ref);
  const fallback = direct && ['opencode', 'codex'].includes(direct.adapter)
    ? {
        sessionId: direct.sessionId ?? `job:${direct.id}`,
        target: direct.target ?? null,
        jobs: direct.sessionId
          ? queue.filter((job) => job.adapter === direct.adapter && job.sessionId === direct.sessionId)
          : [direct],
      }
    : null;
  const { sessionId, target, jobs } = fallback || resolveRef(ref);
  const engineJob = direct ?? jobs.find((job) => job.sessionId === sessionId) ?? jobs.at(-1);
  const dirs = [...new Set(jobs.map((j) => j.dir).filter(Boolean))];
  const external = jobs.some((job) => ['opencode', 'codex'].includes(job.adapter));
  const file = external ? null : findTranscript(sessionId, dirs);
  if (!file) {
    if (external) {
      return adapterChatDTO({ sessionId, target, jobs, engineJob });
    }
    throw Object.assign(new Error(`no transcript for session ${sessionId}`), { status: 404 });
  }

  const chat = parseTranscript(file);
  return {
    sessionId,
    target,
    adapter: engineJob?.adapter ?? 'claude',
    provider: engineJob?.provider ?? null,
    model: engineJob?.model ?? null,
    dir: chat.cwd || dirs[0] || null,
    jobs: jobs.map((j) => j.id),
    first: chat.first,
    last: chat.last,
    cursor: jobs.map((job) => cursorFor(job.id)).filter(Boolean).at(-1) ?? null,
    turns: chat.turns.map((t) => ({
      role: t.role,
      at: t.timestamp,
      toolResult: t.toolResult,
      sidechain: t.sidechain,
      diffs: diffsFromTurn(t),
      blocks: t.blocks.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'thinking') return { type: 'thinking', text: b.thinking };
        if (b.type === 'tool_use') return { type: 'tool', name: b.name, input: b.input };
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string'
            ? b.content
            : (Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '');
          return { type: 'tool_result', text };
        }
        return { type: b.type };
      }),
    })),
  };
}

/**
 * Claude's Edit and Write tool calls carry the exact change and its file. Keeping this beside
 * the turn is more accurate than attributing one repository-wide git diff to every reply.
 */
function diffsFromTurn(turn) {
  return turn.blocks.flatMap((block) => {
    if (block.type !== 'tool_use' || !['Edit', 'Write'].includes(block.name)) return [];
    const input = block.input || {};
    const file = input.file_path || input.path;
    if (!file) return [];

    const oldLines = typeof input.old_string === 'string' ? input.old_string.split('\n') : [];
    const newText = typeof input.new_string === 'string' ? input.new_string : input.content;
    const newLines = typeof newText === 'string' ? newText.split('\n') : [];
    if (!oldLines.length && !newLines.length) return [];

    return [{
      file: String(file),
      added: newLines.length,
      removed: oldLines.length,
      diff: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join('\n'),
    }];
  });
}

export function outputDTO(id) {
  const job = loadQueue().find((j) => j.id === id);
  if (!job) throw Object.assign(new Error(`no job ${id}`), { status: 404 });
  const file = outPath(id);
  return {
    ...jobDTO(job),
    output: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
  };
}

