// Job operations shared by the CLI and the GUI: create, remove, clear, describe.
// Both front-ends go through here, so a job created from the GUI is byte-for-byte
// the same thing `add` creates.

import {
  loadProjects, loadQueue, loadSessions, nid, nowMs, saveQueue, saveSessions, resolveDir,
} from './store.mjs';
import { fmt, parseWhen } from './time.mjs';
import { isLinked, linkPrompt, resolvePrompt } from './prompt.mjs';

/**
 * Create a pending job and push it onto the queue. `at`/`dir` take the same input as `add`.
 *
 * `from` links the job to a FILE instead of storing the text: the file is read when the
 * launch actually goes out, so the prompt can keep being edited until then.
 *
 * `priority` jumps the queue without touching anyone's `when` — see schedule.mjs.
 * `continuation` + a session means "resume that conversation", and the prompt is never sent:
 * `executeJob` swaps it for CONTINUATION.
 */
export function addJob({
  prompt, from = null, target = null, at = null, dir = null, perm = null,
  adapter = 'claude', model = null, session = null, cwd = process.cwd(),
  priority = false, continuation = false,
} = {}) {
  const promptFile = from ? linkPrompt(from) : null;
  const text = String(prompt ?? '').trim();
  const selectedModel = model == null ? null : String(model).trim();
  if (!promptFile && !text) throw new Error('missing prompt');
  if (model != null && !selectedModel) throw new Error('model cannot be empty');

  const job = {
    id: nid(),
    prompt: promptFile ? null : text,
    promptFile,                             // set ⇒ the text is read from here at launch
    target: target || null,
    adapter: adapter || 'claude',
    model: selectedModel,
    when: parseWhen(at || null),
    dir: resolveDir(dir || null, cwd),
    permMode: perm || null,                 // null → bypass
    status: 'pending',
    createdAt: nowMs(),
    sessionId: session || null,
    output: null,
    ...(priority ? { priority: true } : {}),
    ...(continuation ? { continuation: true } : {}),
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

/**
 * The conversations worth continuing, best first.
 *
 * Reusing a target is the single biggest token saving in the tool: the launch resumes a
 * session that already has the context loaded, instead of paying to read the project
 * again from scratch. So when someone is writing a new job we put the existing
 * conversations in front of them rather than making them remember the names.
 *
 * Ranked by most recently touched. Targets that only exist on queued jobs (no session
 * yet) come too, flagged `upcoming`: joining one is how you chain work onto a launch
 * that hasn't run yet.
 */
export function suggestTargets() {
  const sessions = loadSessions();
  const queue = loadQueue();
  const byName = new Map();

  for (const [name, s] of Object.entries(sessions)) {
    byName.set(name, {
      target: name, sessionId: s?.sessionId ?? null, upcoming: false,
      lastAt: s?.updatedAt ?? 0, jobs: 0,
    });
  }
  for (const j of queue) {
    if (!j.target) continue;
    const e = byName.get(j.target) ?? {
      target: j.target, sessionId: j.sessionId ?? null, upcoming: true, lastAt: 0, jobs: 0,
    };
    e.jobs++;
    e.lastAt = Math.max(e.lastAt, j.finishedAt || j.startedAt || j.createdAt || 0);
    if (j.sessionId) { e.sessionId = j.sessionId; e.upcoming = false; }
    byName.set(j.target, e);
  }

  return [...byName.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** The folders already in play — same idea, so nobody has to retype a path. */
export function suggestDirs() {
  const projects = loadProjects();
  const seen = new Map();

  for (const [alias, p] of Object.entries(projects)) {
    if (alias !== '_base') seen.set(p, { dir: p, label: alias, lastAt: 0 });
  }
  for (const j of loadQueue()) {
    if (!j.dir) continue;
    const e = seen.get(j.dir) ?? { dir: j.dir, label: null, lastAt: 0 };
    e.lastAt = Math.max(e.lastAt, j.createdAt || 0);
    seen.set(j.dir, e);
  }

  return [...seen.values()].sort((a, b) => b.lastAt - a.lastAt);
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
    ['time', job.when ? '@ ' + fmt(job.when)
      : job.priority ? 'PRIMERO — en cuanto haya cupo'
        : 'sequential'],
    ['adapter', job.adapter],
    ['model', job.model || 'engine default'],
    ['target', job.target || '—'],
    ['folder', job.dir || '—'],
    ['perm', job.permMode || 'bypass'],
    ['session', job.sessionId || '—'],
    ['created', fmt(job.createdAt)],
  ];
  if (job.continuation) rows.push(['resume', 'continúa la conversación; no reenvía el prompt']);
  if (job.startedAt) rows.push(['started', fmt(job.startedAt)]);
  if (job.finishedAt) rows.push(['finished', fmt(job.finishedAt)]);
  if (isLinked(job)) rows.push(['from', job.promptFile]);

  const out = [`── ${job.id} ──`, ...rows.map(([k, v]) => `  ${(k + ':').padEnd(10)}${v}`)];

  // For a linked job show what the file says RIGHT NOW — that, not some copy taken when
  // it was queued, is what will actually be sent.
  let text;
  try { text = resolvePrompt(job); }
  catch (e) { text = `⚠ ${e.message.split('\n')[0]}`; }

  out.push(`  prompt${isLinked(job) ? ' (del archivo, ahora mismo)' : ''}:\n${text.replace(/^/gm, '    ')}`);
  return out.join('\n');
}
