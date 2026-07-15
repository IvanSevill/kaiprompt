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
import { loadConversation, loadOpenCodeTranscript } from './chat.mjs';
import { readUsage, sessionQuota } from './quota.mjs';
import { runnerStatus } from './runner-status.mjs';
import { nextScheduledAt } from './schedule.mjs';
import { activityState } from './activity.mjs';
import { aggregateUsage } from './usage.mjs';
import { BOOTED_AT, clientList, serverConfig, VERSION } from './server-pair.mjs';
import { isTerminalStatus, liveEvents } from './live-events.mjs';

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

const statusRank = { running: 5, pending: 4, quota: 4, error: 3, done: 2, missed: 1 };
const jobAt = (job) => job.finishedAt ?? job.startedAt ?? job.createdAt ?? 0;
const summaryStatus = (job, now = Date.now()) => (
  job?.status === 'pending' && (job.pausedUntil ?? 0) > now ? 'quota' : (job?.status ?? 'done')
);

/** The most important state wins; recency only breaks ties at the same state. */
export function conversationStatus(jobs, now = Date.now()) {
  return [...jobs].sort((a, b) => {
    const rank = (statusRank[summaryStatus(b, now)] ?? 0) - (statusRank[summaryStatus(a, now)] ?? 0);
    return rank || jobAt(b) - jobAt(a);
  })[0] ?? null;
}

const sessionRecords = (raw) => Object.values(raw?.engines ?? { [raw?.adapter ?? 'claude']: raw }).filter(Boolean);
const metadataTitle = (record) => record?.title ?? record?.name ?? record?.metadata?.title ?? null;

/**
 * Conversation summaries. Legacy fields remain present so older clients keep working.
 * Concepts are never inferred from prompt text: a missing title is localized by the client.
 */
export function targetsDTO({ openCodeRun } = {}) {
  const sessions = loadSessions();
  const queue = loadQueue();
  const groups = [];
  const used = new Set();

  for (const [target, raw] of Object.entries(sessions)) {
    const records = sessionRecords(raw);
    for (const record of records) {
      const jobs = queue.filter((job) => job.sessionId === record.sessionId
        || (job.target === target && (records.length === 1 || job.adapter === record.adapter)));
      jobs.forEach((job) => used.add(job.id));
      groups.push({ target, record, jobs });
    }
  }

  for (const job of queue) {
    if (used.has(job.id)) continue;
    const jobs = queue.filter((candidate) => !used.has(candidate.id) && candidate.adapter === job.adapter && (
      (job.target && candidate.target === job.target)
      || (!job.target && job.sessionId && candidate.sessionId === job.sessionId)
      || (!job.target && !job.sessionId && candidate.id === job.id)
    ));
    jobs.forEach((candidate) => used.add(candidate.id));
    groups.push({ target: job.target ?? null, record: null, jobs });
  }

  return groups.map(({ target, record, jobs }) => {
    const current = conversationStatus(jobs);
    const sessionId = record?.sessionId ?? current?.sessionId ?? jobs.find((job) => job.sessionId)?.sessionId ?? null;
    const adapter = record?.adapter ?? current?.adapter ?? jobs.at(-1)?.adapter ?? null;
    let concept = target || metadataTitle(record);
    if (!concept && adapter === 'opencode' && sessionId) {
      concept = loadOpenCodeTranscript(sessionId, { ...(openCodeRun ? { run: openCodeRun } : {}) })?.title ?? null;
    }
    const running = jobs.filter((job) => job.status === 'running').sort((a, b) => jobAt(b) - jobAt(a))[0] ?? null;
    const updatedAt = Math.max(record?.updatedAt ?? 0, ...jobs.map(jobAt));
    const external = ['opencode', 'codex'].includes(adapter);
    return {
      ref: sessionId ?? target ?? jobs[0]?.id,
      concept,
      status: summaryStatus(current),
      adapter,
      provider: record?.provider ?? current?.provider ?? null,
      model: record?.model ?? current?.model ?? null,
      currentJobId: current?.id ?? null,
      runningJobId: running?.id ?? null,
      updatedAt,
      chatAvailable: external || Boolean(sessionId),
      jobs: jobs.map((job) => job.id),
      // Backwards-compatible /api/targets fields.
      target,
      sessionId,
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
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

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
};

const liveBlock = (event) => {
  if (event.kind === 'text') return { type: 'text', text: event.text, eventId: event.id };
  if (event.kind === 'thinking') return { type: 'thinking', text: event.text, eventId: event.id };
  if (event.kind === 'tool') return { type: 'tool', name: event.name, input: event.input, eventId: event.id };
  if (event.kind === 'todos') return { type: 'todos', todos: event.todos, eventId: event.id };
  return null;
};

const blockKey = (block) => {
  if (block.type === 'text' || block.type === 'thinking') return `${block.type}:${block.text ?? ''}`;
  if (block.type === 'tool') {
    const input = block.input ?? {};
    const compact = Object.fromEntries(['file_path', 'command', 'pattern', 'path', 'url', 'query']
      .filter((key) => input[key] != null).map((key) => [key, input[key]]));
    return `tool:${block.name ?? 'tool'}:${JSON.stringify(stable(Object.keys(compact).length ? compact : input))}`;
  }
  if (block.type === 'todos') return `todos:${JSON.stringify(stable(block.todos ?? []))}`;
  return null;
};

/** Attach durable event IDs to transcript blocks and append only events absent from it. */
function withLiveEvents(base, jobs, streamJob) {
  const turns = base.turns.map((turn) => ({ ...turn, blocks: turn.blocks.map((block) => ({ ...block })) }));
  const available = new Map();
  for (const turn of turns) for (const block of turn.blocks) {
    const key = blockKey(block);
    if (key) available.set(key, [...(available.get(key) ?? []), block]);
  }

  const events = jobs.flatMap((job) => liveEvents(job.id)).sort((a, b) => a.at - b.at || a.seq - b.seq);
  const consumed = new Set();
  for (const job of jobs) {
    const chunks = events.filter((event) => event.jobId === job.id && event.kind === 'text' && event.text);
    if (chunks.length < 2) continue;
    const match = available.get(`text:${chunks.map((event) => event.text).join('')}`)?.shift();
    if (!match) continue;
    match.eventId = chunks.at(-1).id;
    chunks.forEach((event) => consumed.add(event.id));
  }
  const unmatched = [];
  for (const event of events) {
    if (consumed.has(event.id)) continue;
    const block = liveBlock(event);
    if (!block) continue;
    const match = available.get(blockKey(block))?.shift();
    if (match) match.eventId = event.id;
    else unmatched.push({ event, block });
  }
  if (unmatched.length) turns.push({
    role: 'assistant', at: new Date(unmatched[0].event.at).toISOString(),
    toolResult: false, sidechain: false, live: true, blocks: unmatched.map((item) => item.block), diffs: [],
  });

  const streamEvents = streamJob ? liveEvents(streamJob.id) : [];
  const eventIds = events.map((event) => event.id);
  return {
    ...base, turns, eventIds,
    cursor: streamEvents.at(-1)?.id ?? null,
    status: streamJob?.status ?? null,
    terminal: isTerminalStatus(streamJob?.status),
  };
}

/**
 * The WHOLE conversation, as structured turns. No truncation: this is the payoff of not
 * using a cloud relay — the transcript never leaves your machine, so there is nothing to
 * be careful about.
 */
export function chatDTO(ref, { openCodeRun } = {}) {
  const queue = loadQueue();
  const direct = queue.find((job) => job.id === ref);
  const { resolved, chat } = loadConversation(ref, { openCodeRun, pendingExternal: true });
  const { sessionId, target, jobs } = resolved;
  const engineJob = direct ?? jobs.find((job) => job.sessionId === sessionId) ?? jobs.at(-1);
  const adapter = resolved.adapter ?? engineJob?.adapter ?? null;
  if (!chat) throw Object.assign(new Error(`no transcript for session ${sessionId}`), { status: 404 });
  const base = {
      sessionId,
      target,
      adapter: adapter ?? 'claude',
      provider: resolved.provider ?? engineJob?.provider ?? null,
      model: resolved.model ?? engineJob?.model ?? null,
      dir: chat.cwd || resolved.dir || jobs.find((job) => job.dir)?.dir || null,
      jobs: jobs.map((j) => j.id),
      first: chat.first,
      last: chat.last,
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
  return withLiveEvents(base, jobs, direct ?? conversationStatus(jobs));
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

