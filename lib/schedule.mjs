// What runs now — and what never ran and now never will.
//
// Nothing here launches anything or paints anything: it only looks at the queue and
// answers "which job is up?". Every runner (plain, TUI, parallel) asks the same
// questions, so they all ask them here.

import { alive, loadQueue, nowMs, saveQueue } from './store.mjs';
import { fmt, humanDur } from './time.mjs';

/** Everything still waiting, read fresh off disk — not a snapshot. */
export const pendingJobs = () => loadQueue().filter((j) => j.status === 'pending');

// How often an idle runner looks for new work. It is one small file read, so it can be
// brisk: a prompt queued from another terminal should start in a couple of seconds, not
// sit there while you wonder whether the thing is even listening.
export const IDLE_POLL_MS = 2000;

/**
 * The jobs that could go right now, in the order they should go: scheduled jobs whose
 * time has come (earliest first), then sequential ones.
 */
function runnable(pending, t) {
  return {
    due: pending.filter((j) => j.when && j.when <= t).sort((a, b) => a.when - b.when),
    seq: pending.filter((j) => !j.when),
  };
}

/**
 * Pick what runs next: due scheduled jobs first (earliest), then sequential ones.
 *
 * `scheduledOnly` is what keeps the background daemon honest. A sequential job (no
 * time) means "run it on my next manual run" — if the daemon took those too, adding
 * a job would fire it seconds later, which is exactly the surprise we're avoiding.
 */
export function nextUp(pending, t = nowMs(), { scheduledOnly = false } = {}) {
  const { due, seq } = runnable(pending, t);
  const usable = scheduledOnly ? [] : seq;
  return { job: due[0] || usable[0], due, seq: usable };
}

// --- lanes -------------------------------------------------------------------
/**
 * Which jobs may NOT overlap. Two jobs on the same target share one conversation, and
 * resuming a session twice at once corrupts it — so a target is a lane, and a lane runs
 * one job at a time. Jobs with no target can't collide with anything, so each is its own
 * lane and they all go at once.
 *
 * That is the whole answer to "why should a prompt for one chat wait for another chat's".
 */
export const laneOf = (job) => job.target || `job:${job.id}`;

/** The jobs we can start right now: runnable, and not on a lane that is already busy. */
export function startable(pending, busyLanes, room, t = nowMs()) {
  const { due, seq } = runnable(pending, t);
  const out = [];
  const taken = new Set(busyLanes);
  for (const j of [...due, ...seq]) {
    if (out.length >= room) break;
    const lane = laneOf(j);
    if (taken.has(lane)) continue;                  // its conversation is already busy
    taken.add(lane);
    out.push(j);
  }
  return out;
}

// --- closing out what never ran ----------------------------------------------
// How late a launch can be and still go. Inside the window, being late is normal and
// catching up is the whole point: the daemon was off at 03:00, you turn the machine on
// at 09:00, the job runs. Past it, "overdue" stops meaning "run me now" — a job from
// last week must not wake up and fire the moment a runner appears. That resurrection is
// the same surprise as launching on the spot, just delayed.
export const GRACE_MS = 12 * 60 * 60 * 1000;

/** Jobs so overdue that firing them would be a surprise, not a catch-up. */
export function reapMissed(graceMs = GRACE_MS, t = nowMs()) {
  const q = loadQueue();
  let n = 0;
  for (const j of q) {
    if (j.status !== 'pending' || !j.when || j.when > t - graceMs) continue;
    j.status = 'missed';
    j.finishedAt = t;
    j.error = `missed: its time (${fmt(j.when)}) passed more than ${humanDur(graceMs)} ago; `
      + 'nothing was running then. Reschedule it with "edit" if you still want it';
    n++;
  }
  if (n) saveQueue(q);
  return n;
}

/**
 * A job left `running` by a runner that died (killed daemon, closed terminal, reboot)
 * would sit there forever and block nothing — but it lies in `list` and its output is
 * never written. On every start we close those out as errors.
 */
export function reapStale() {
  const q = loadQueue();
  let n = 0;
  for (const j of q) {
    if (j.status !== 'running') continue;
    // No pid at all means nobody can ever vouch for it: either it predates runnerPid, or
    // it was killed before the field was written. Left alone it sits at `running`
    // forever — which is exactly what happened to the launch that got cancelled.
    if (j.runnerPid && alive(j.runnerPid)) continue;
    j.status = 'error';
    j.finishedAt = nowMs();
    j.error = 'interrupted: the runner died while this was running';
    n++;
  }
  if (n) saveQueue(q);
  return n;
}
