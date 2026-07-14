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
import { sessionQuota } from './quota.mjs';
import { runnerStatus } from './runner-status.mjs';
import { nextScheduledAt } from './schedule.mjs';
import { activityState } from './activity.mjs';
import { BOOTED_AT, clientList, serverConfig, VERSION } from './server-pair.mjs';

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
    quota: q ? { freePct: q.freePct, resetsAt: q.resetsAt, renewed: q.renewed } : null,

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

  return Object.entries(sessions).map(([target, s]) => ({
    target,
    sessionId: s.sessionId,
    adapter: s.adapter,
    updatedAt: s.updatedAt,
    jobs: queue.filter((j) => j.target === target).map((j) => j.id),
  })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * The WHOLE conversation, as structured turns. No truncation: this is the payoff of not
 * using a cloud relay — the transcript never leaves your machine, so there is nothing to
 * be careful about.
 */
export function chatDTO(ref) {
  const { sessionId, target, jobs } = resolveRef(ref);
  const dirs = [...new Set(jobs.map((j) => j.dir).filter(Boolean))];
  const file = findTranscript(sessionId, dirs);
  if (!file) throw Object.assign(new Error(`no transcript for session ${sessionId}`), { status: 404 });

  const chat = parseTranscript(file);
  return {
    sessionId,
    target,
    dir: chat.cwd || dirs[0] || null,
    jobs: jobs.map((j) => j.id),
    first: chat.first,
    last: chat.last,
    turns: chat.turns.map((t) => ({
      role: t.role,
      at: t.timestamp,
      toolResult: t.toolResult,
      sidechain: t.sidechain,
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

export function outputDTO(id) {
  const job = loadQueue().find((j) => j.id === id);
  if (!job) throw Object.assign(new Error(`no job ${id}`), { status: 404 });
  const file = outPath(id);
  return {
    ...jobDTO(job),
    output: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
  };
}

