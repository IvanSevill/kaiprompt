// Job operations shared by the CLI and the GUI: create, remove, clear, describe.
// Both front-ends go through here, so a job created from the GUI is byte-for-byte
// the same thing `add` creates.

import {
  loadQueue, loadSessions, nid, nowMs, saveQueue, saveSessions, resolveDir,
} from './store.mjs';
import { fmt, parseWhen } from './time.mjs';

/** Create a pending job and push it onto the queue. `at`/`dir` take the same input as `add`. */
export function addJob({
  prompt, target = null, at = null, dir = null, perm = null,
  adapter = 'claude', session = null, cwd = process.cwd(),
} = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('missing prompt');

  const job = {
    id: nid(),
    prompt: text,
    target: target || null,
    adapter: adapter || 'claude',
    when: parseWhen(at || null),
    dir: resolveDir(dir || null, cwd),
    permMode: perm || null,                 // null → bypass
    status: 'pending',
    createdAt: nowMs(),
    sessionId: session || null,
    output: null,
  };

  const q = loadQueue(); q.push(job); saveQueue(q);

  // With a session + a target, that target now points at this session.
  if (job.sessionId && job.target) {
    const sessions = loadSessions();
    sessions[job.target] = { sessionId: job.sessionId, adapter: job.adapter, updatedAt: nowMs() };
    saveSessions(sessions);
  }
  return job;
}

/** Drop jobs by id. Returns how many actually went. */
export function removeJobs(ids) {
  const set = new Set(ids);
  const q = loadQueue();
  const kept = q.filter((j) => !set.has(j.id));
  saveQueue(kept);
  return q.length - kept.length;
}

/** Drop everything that already ran (done/error), keep pending and running. */
export function clearFinished() {
  const q = loadQueue();
  const kept = q.filter((j) => j.status === 'pending' || j.status === 'running');
  saveQueue(kept);
  return q.length - kept.length;
}

/** One job, spelled out — used by `show`, `list --full`, `edit` and the GUI's detail view. */
export function jobDetails(job) {
  const rows = [
    ['id', job.id],
    ['status', job.status],
    ['time', job.when ? '@ ' + fmt(job.when) : 'sequential'],
    ['adapter', job.adapter],
    ['target', job.target || '—'],
    ['folder', job.dir || '—'],
    ['perm', job.permMode || 'bypass'],
    ['session', job.sessionId || '—'],
    ['created', fmt(job.createdAt)],
  ];
  if (job.startedAt) rows.push(['started', fmt(job.startedAt)]);
  if (job.finishedAt) rows.push(['finished', fmt(job.finishedAt)]);
  const out = [`── ${job.id} ──`, ...rows.map(([k, v]) => `  ${(k + ':').padEnd(10)}${v}`)];
  out.push(`  prompt:\n${(job.prompt || '').replace(/^/gm, '    ')}`);
  return out.join('\n');
}
