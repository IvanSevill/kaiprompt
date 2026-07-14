// One job, end to end: run it, work out what its ending means, and write that down.
//
// The three runners (plain, TUI, parallel) differ only in what they *show* while this
// happens. The lifecycle itself is the same everywhere, so it lives here once — that is
// what stops the quota rescue from being right in two loops and subtly wrong in the third.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ADAPTERS, HOME, historyPath, nowMs, outPath, patchJob, rememberSession, sessionFor,
} from './store.mjs';
import { fmt } from './time.mjs';
import { planRetry, quotaVerdict } from './quota.mjs';
import { CONTINUATION, isContinuation, jobPreview, resolvePrompt } from './prompt.mjs';

export async function loadAdapter(name) {
  const p = path.join(ADAPTERS, `${name || 'claude'}.mjs`);
  if (!fs.existsSync(p)) throw new Error(`unknown adapter: "${name}" (check the adapters/ folder)`);
  return import(pathToFileURL(p).href);
}

/**
 * A launch ended: tell whoever is listening.
 *
 * The phone's notification comes from here — the PC knocks on it directly, over the tunnel,
 * with nothing in the cloud in between. Best-effort on purpose: a phone that is off or out
 * of signal simply misses it, and the app's catch-up poll picks it up later. A launch must
 * never be reported as failed because a notification could not be delivered.
 */
async function announce(job) {
  try {
    const { notifyFinished } = await import('./notify.mjs');
    await notifyFinished(job);
  } catch { /* nobody is listening, and that is fine */ }
}

/** Run one job through its adapter, persist the output, the status and the session. */
export async function executeJob(job, { dryRun = false, onEvent } = {}) {
  const key = job.target;
  // Read the session id and let the file go. Holding the whole map across the launch —
  // which is minutes, or hours — and writing it back at the end is what erased the other
  // lanes' sessions. See rememberSession.
  const sid = job.sessionId || (key && sessionFor(key, job.adapter)?.sessionId) || null;
  const adapter = await loadAdapter(job.adapter);

  // Read the prompt NOW, not when it was queued. For a linked job (--from) that is the
  // whole point: whatever the file says at launch time is what goes out, so you can keep
  // sharpening it until the last second. If the file is gone or blank this throws, and
  // nothing is launched — an unattended run with full autonomy must never get a blank
  // instruction and improvise.
  //
  // Unless it is coming back from a quota cut-off with its session intact: then the brief
  // has already been read and half the work may be done, so it gets told to continue rather
  // than handed the whole thing again.
  const prompt = (isContinuation(job) && sid) ? CONTINUATION : resolvePrompt(job);

  const startedAt = nowMs();
  fs.appendFileSync(historyPath(job.id), JSON.stringify({ type: 'attempt-start', at: startedAt, engine: job.adapter, provider: job.provider ?? null, model: job.model ?? null }) + '\n');
  const res = await adapter.run({
    prompt, sessionId: sid, dryRun, dir: job.dir || null,
    permMode: job.permMode || null, model: job.model || null, provider: job.provider || null, onEvent,
  });

  const file = outPath(job.id);
  fs.writeFileSync(file, (res.output ?? '') + (res.error ? `\n\n[ERROR] ${res.error}` : '') + '\n');
  job.status = res.ok ? 'done' : 'error';
  job.finishedAt = nowMs();
  job.output = path.relative(HOME, file).replace(/\\/g, '/');   // "out/<id>.txt", wherever HOME is
  if (res.sessionId) {
    job.sessionId = res.sessionId;
    if (key) rememberSession(key, res.sessionId, job.adapter, { provider: job.provider ?? null, model: job.model ?? null });
  }
  fs.appendFileSync(historyPath(job.id), JSON.stringify({ type: 'attempt-end', at: nowMs(), ok: res.ok, durationMs: nowMs() - startedAt, engine: job.adapter, provider: job.provider ?? null, model: job.model ?? null, target: job.target ?? null, sessionId: res.sessionId ?? null, usage: res.usage ?? null, cost: res.cost ?? null, error: res.ok ? null : String(res.error ?? '').slice(0, 1000) }) + '\n');
  return res;
}

// --- how a launch ended ------------------------------------------------------
/**
 * A launch came back empty-handed. Was it broken — or just cut off because the quota
 * ran out? That third case is what lost the overnight batch: Claude prints "you've hit
 * your session limit" and exits 1, which to anything watching the exit code looks
 * exactly like a crash. So we tell them apart and put the job BACK in the queue.
 */
export function settle(job, res) {
  if (res.ok) return { action: 'done' };

  const plan = planRetry(job, quotaVerdict(`${res.output ?? ''}\n${res.error ?? ''}`, { adapter: job.adapter }));
  if (plan.action !== 'requeue') return { action: 'fail', reason: plan.reason ?? res.error };
  return { action: 'requeue', waitUntil: plan.waitUntil, quotaRetries: plan.quotaRetries, kind: plan.kind };
}

/**
 * Put a quota-killed job back exactly where it was.
 *
 * `when` is deliberately left ALONE: it is what preserves the order. The job keeps the
 * time it was scheduled for, so when the quota comes back it is still the earliest job
 * due and goes first, and everything behind it stays behind it.
 */
export function requeue(job, plan) {
  job.status = 'pending';
  job.startedAt = null;
  job.finishedAt = null;
  job.quotaRetries = plan.quotaRetries;
  job.quotaKind = plan.kind ?? null;
  job.pausedUntil = plan.waitUntil;

  // A session means the launch really started: it read the project, made a plan, maybe
  // wrote half of it. Coming back it must be told to CONTINUE — handing it the brief again
  // makes it start from the top, pay for all that context a second time, and quite possibly
  // undo the work it had already done.
  job.continuation = Boolean(job.sessionId);

  job.error = `out of ${plan.kind || 'quota'}; back in the queue, resumes ${fmt(plan.waitUntil)}`
    + (job.continuation ? ' — continuing, not restarting' : '');
  patchJob(job);
  return job;
}

// --- the lifecycle every runner shares ---------------------------------------
/** Claim the job: this runner's pid is what lets `reapStale` tell "running" from "abandoned". */
export function markRunning(job) {
  job.status = 'running';
  job.startedAt = nowMs();
  job.runnerPid = process.pid;
  patchJob(job);
  return job;
}

/**
 * Run it, and say what its ending was. Never throws: an adapter that blows up is just
 * another way for a launch to end, and the queue still has to be told about it.
 */
export async function launch(job, { onEvent } = {}) {
  let res;
  try {
    res = await executeJob(job, { onEvent });
  } catch (e) {
    job.status = 'error';
    job.finishedAt = nowMs();
    res = { ok: false, error: e.message };
  }
  return { res, end: settle(job, res) };
}

/**
 * Write the ending down. Out of quota goes back in the queue (as `pending`, not `error`)
 * and nobody is notified — the launch is not over, it is paused. Anything else is final:
 * persist it and knock on the phone.
 *
 * `executeJob` (or `launch`'s catch) has already set status and finishedAt by now, so
 * this only has to commit them.
 */
export async function commit(job, end) {
  if (end.action === 'requeue') return requeue(job, end);
  patchJob(job);
  await announce(job);
  return job;
}

// --- what a runner without a screen says --------------------------------------
export const logLine = (s) => console.log(`[${new Date().toISOString()}] ${s}`);
export const startedLine = (job) =>
  `▶ ${job.id} [${job.adapter}${job.target ? '/' + job.target : ''}] ${jobPreview(job)}`;
