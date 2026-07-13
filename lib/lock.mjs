// The single-runner lock.
//
// Two runners racing on the same queue would execute a job twice (both read it as
// "pending" before either marks it "running"). The lock makes it safe to have a
// background runner AND a scheduled task as a fallback: the second one just exits.

import fs from 'node:fs';
import path from 'node:path';

import { DATA } from './store.mjs';

const LOCK = path.join(DATA, 'runner.lock');
const LOCK_STALE_MS = 120_000;          // heartbeat older than this ⇒ the runner died
const BEAT_MS = 30_000;

export function lockIsHeld() {
  return lockInfo().held;
}

/** Who holds the lock, if anyone. The pid is what lets us tell a daemon from a live `run`. */
export function lockInfo() {
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    return { held: Date.now() - at < LOCK_STALE_MS, pid: pid ?? null, at: at ?? null };
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
