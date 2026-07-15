// The single-runner lock.
//
// Two runners racing on the same queue would execute a job twice (both read it as
// "pending" before either marks it "running"). The lock makes it safe to have a
// background runner AND a scheduled task as a fallback: the second one just exits.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { alive, DATA } from './store.mjs';

export const LOCK = path.join(DATA, 'runner.lock');
const ACQUIRE = `${LOCK}.acquire`;
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
    const { pid, at, startedAt, heartbeatAt, owner } = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    const heartbeat = heartbeatAt ?? at;
    const beating = Date.now() - heartbeat < LOCK_STALE_MS;
    return {
      held: beating && alive(pid),
      pid: pid ?? null,
      at: startedAt ?? at ?? null,
      heartbeatAt: heartbeat ?? null,
      owner: owner ?? null,
    };
  } catch {
    return { held: false, pid: null, at: null, heartbeatAt: null, owner: null };
  }
}

/** Take the lock, or null if someone else holds it. Returns the release function. */
export function acquireLock() {
  const owner = randomUUID();
  const startedAt = Date.now();
  const record = () => ({ pid: process.pid, at: startedAt, startedAt, heartbeatAt: Date.now(), owner });

  // The short-lived guard serializes stale-lock cleanup as well as exclusive creation. Without
  // it, one contender could remove the fresh lock another contender created after inspecting
  // the same stale file.
  try {
    fs.writeFileSync(ACQUIRE, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      try {
        const existing = JSON.parse(fs.readFileSync(ACQUIRE, 'utf8'));
        if (alive(existing.pid)) return null;
        fs.rmSync(ACQUIRE);
        return acquireLock();
      } catch {
        return null;
      }
    }
    throw error;
  }

  try {
    if (lockIsHeld()) return null;
    fs.rmSync(LOCK, { force: true });
    try {
      fs.writeFileSync(LOCK, JSON.stringify(record()), { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') return null;
      throw error;
    }
  } finally {
    fs.rmSync(ACQUIRE, { force: true });
  }

  const beat = () => {
    try {
      const current = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      if (current.owner !== owner) return;
      fs.writeFileSync(LOCK, JSON.stringify(record()));
    }
    catch { /* best effort */ }
  };
  const timer = setInterval(beat, BEAT_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    try {
      const current = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      if (current.owner === owner) fs.rmSync(LOCK);
    } catch { /* already gone or replaced */ }
  };
}
