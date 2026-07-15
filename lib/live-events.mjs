import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DATA, patchJob, rememberSession } from './store.mjs';

const DIR = path.join(DATA, 'live');
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_EVENTS = 1500;
const listeners = new Set();
const sequences = new Map();

export const TERMINAL_STATUSES = new Set(['done', 'error', 'missed']);
export const isTerminalStatus = (status) => TERMINAL_STATUSES.has(String(status ?? '').toLowerCase());

const fileFor = (jobId) => path.join(DIR, `${jobId}.jsonl`);

export const newAttemptId = () => randomUUID();

export function liveEvents(jobId) {
  try {
    return fs.readFileSync(fileFor(jobId), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function cursorFor(jobId) {
  return liveEvents(jobId).at(-1)?.id ?? null;
}

export function replayLive(jobId, after = null) {
  const events = liveEvents(jobId);
  if (!after) return events;
  const index = events.findIndex((event) => event.id === after);
  return index < 0 ? null : events.slice(index + 1);
}

export function subscribeLive(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitLive(job, event) {
  const attemptId = job.attemptId || `job-${job.id}`;
  const key = `${job.id}:${attemptId}`;
  const seq = (sequences.get(key) ?? liveEvents(job.id).filter((x) => x.attemptId === attemptId).at(-1)?.seq ?? 0) + 1;
  sequences.set(key, seq);
  const record = {
    id: `${attemptId}:${seq}`, jobId: job.id, attemptId, seq, at: Date.now(),
    sessionId: job.sessionId ?? null, target: job.target ?? null, ...event,
  };
  fs.mkdirSync(DIR, { recursive: true });
  const file = fileFor(job.id);
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  if (fs.statSync(file).size > MAX_BYTES) {
    const kept = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-KEEP_EVENTS);
    fs.writeFileSync(file, kept.join('\n') + '\n');
  }
  for (const listener of listeners) {
    try { listener(record); } catch { /* a display cannot stop a launch */ }
  }
  return record;
}

/** Convert the shared Claude-shaped adapter event into durable semantic records. */
export function recordAdapterEvent(job, event) {
  if (event?.session_id && !job.sessionId) {
    job.sessionId = event.session_id;
    patchJob(job);
    if (job.target) rememberSession(job.target, job.sessionId, job.adapter, {
      provider: job.provider ?? null,
      model: job.model ?? null,
      dir: job.dir ?? null,
    });
  }
  if (event?.type !== 'assistant') return [];
  return (event.message?.content ?? []).flatMap((block) => {
    if (block.type === 'text' && block.text) return [emitLive(job, { kind: 'text', text: block.text })];
    if (block.type === 'thinking' && block.thinking) return [emitLive(job, { kind: 'thinking', text: block.thinking })];
    if (block.type !== 'tool_use') return [];
    const input = block.input ?? {};
    if (block.name === 'TodoWrite') return [emitLive(job, { kind: 'todos', todos: Array.isArray(input.todos) ? input.todos : [] })];
    const compact = Object.fromEntries(['file_path', 'command', 'pattern', 'path', 'url', 'query']
      .filter((key) => input[key] != null)
      .map((key) => [key, String(input[key]).slice(0, 4000)]));
    return [emitLive(job, { kind: 'tool', name: block.name ?? 'tool', input: compact })];
  });
}

export function clearLive(jobId) {
  try { fs.rmSync(fileFor(jobId), { force: true }); } catch { /* best effort */ }
}
