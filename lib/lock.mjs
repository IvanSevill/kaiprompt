// The single-runner lock.
//
// Two runners racing on the same queue would execute a job twice (both read it as
// "pending" before either marks it "running"). The lock makes it safe to have a
// background runner AND a scheduled task as a fallback: the second one just exits.

import fs from 'node:fs';
import path from 'node:path';

import { alive, DATA } from './store.mjs';

export const LOCK = path.join(DATA, 'runner.lock');
const LOCK_STALE_MS = 120_000;          // heartbeat older than this ⇒ the runner is wedged
const BEAT_MS = 30_000;

export function lockIsHeld() {
  return lockInfo().held;
}

/**
 * Who holds the lock, if anyone. The pid is what lets us tell a daemon from a live `run`.
 *
 * Held means BOTH: the process is still there, and it is still beating.
 *
 * Asking the clock alone was the bug. Kill a `kaip run` in a way that skips its cleanup —
 * closing the window, a hard Ctrl+C, a crash — and the lock file outlives it. For the next
 * two minutes the tool went on insisting someone was draining the queue: `daemon start`
 * refused to start, and every screen reported a runner that no longer existed. It came back
 * on its own eventually, which is exactly what made it so annoying — you could not tell it
 * apart from the tool just being slow.
 *
 * The pid answers it instantly, so we ask that first. The heartbeat stays as the second
 * condition, and it still earns its place: it covers the runner that is alive but wedged,
 * and the pid that got recycled by an unrelated process after the runner died.
 */
export function lockInfo() {
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    const beating = Date.now() - at < LOCK_STALE_MS;
    return { held: beating && alive(pid), pid: pid ?? null, at: at ?? null };
  } catch {
    return { held: false, pid: null, at: null };
  }
}

/** Take the lock, or null if someone else holds it. Returns the release function. */
export function acquireLock() {
  if (lockIsHeld()) return null;
  const beat = () => {
    try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() })); }
    catch { /* best effort */ }
  };
  beat();
  const timer = setInterval(beat, BEAT_MS);
  timer.unref?.();
  return () => { clearInterval(timer); try { fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ } };
}
