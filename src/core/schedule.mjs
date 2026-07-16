// What runs now — and what never ran and now never will.
//
// Nothing here launches anything or paints anything: it only looks at the queue and
// answers "which job is up?". Every runner (plain, TUI, parallel) asks the same
// questions, so they all ask them here.

import { alive } from '../storage/json.mjs';
import { loadQueue, mutateQueue, nowMs } from '../storage/repositories.mjs';
import { fmt, humanDur } from './time.mjs';

/** Everything still waiting, read fresh off disk — not a snapshot. */
export const pendingJobs = () => loadQueue().filter((j) => j.status === 'pending');

// How often an idle runner looks for new work. It is one small file read, so it can be
// brisk: a prompt queued from another terminal should start in a couple of seconds, not
// sit there while you wonder whether the thing is even listening.
export const IDLE_POLL_MS = 2000;

/**
 * Jumping the queue, without lying about the time.
 *
 * "First" cannot be done by giving a job an earlier `when` — that is the one thing `requeue`
 * refuses to do, because the scheduled times ARE the order, and moving one moves the meaning
 * of every job behind it. So priority is its own field, and it is read here.
 *
 * What earns it: work already started, whose context has already been paid for, that was cut
 * off with minutes left. Finishing that before beginning anything new is not a favour to it —
 * it is the cheapest thing in the queue and the only one already half-done.
 */
export const isPriority = (job) => Boolean(job?.priority);

/**
 * The jobs that could go right now, in the order they should go: priority first (oldest
 * first, so they cannot starve each other), then scheduled jobs whose time has come
 * (earliest first), then sequential ones.
 */
function runnable(pending, t) {
  const eligible = pending.filter((j) => !j.pausedUntil || j.pausedUntil <= t);
  return {
    prio: eligible.filter(isPriority).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
    due: eligible.filter((j) => !isPriority(j) && j.when && j.when <= t).sort((a, b) => a.when - b.when),
    seq: eligible.filter((j) => !isPriority(j) && !j.when),
  };
}

/**
 * Pick what runs next: priority jobs, then due scheduled jobs (earliest), then sequential.
 *
 * `scheduledOnly` is what keeps the background daemon honest. A sequential job (no time)
 * means "run it on my next manual run" — if the daemon took those too, adding a job would
 * fire it seconds later, which is exactly the surprise we're avoiding.
 *
 * A priority job is NOT that surprise, so the daemon takes it even though it has no time.
 * It only exists because someone was shown one specific unfinished conversation and said
 * yes, finish that one as soon as the quota is back. That answer IS the instruction to fire
 * unattended — and a daemon that skipped it would leave the offer accepted and nothing ever
 * running, which is the same silent lie as scheduling work that nothing will fire.
 */
export function nextUp(pending, t = nowMs(), { scheduledOnly = false } = {}) {
  const { prio, due, seq } = runnable(pending, t);
  const usable = scheduledOnly ? [] : seq;
  return { job: prio[0] || due[0] || usable[0], prio, due, seq: usable };
}

/**
 * When does the next scheduled job fire — null if nothing is scheduled.
 *
 * "The soonest `when` among the pending" was being worked out with a bare `Math.min(…)` in
 * five places: the daemon's status, the goodbye screen, the dry-run summary and twice inside
 * the countdown. Every copy had to remember the same two things — skip jobs with no time, and
 * an empty list is `null`, not `Infinity` — and a single one getting it wrong shows up as a
 * clock counting down to 1970.
 *
 * Takes any list of jobs (a whole queue or a pre-filtered slice) and only ever considers the
 * pending ones with a time.
 */
export function nextScheduledAt(jobs = loadQueue()) {
  const times = jobs.filter((j) => j.status === 'pending' && j.when).map((j) => j.when);
  return times.length ? Math.min(...times) : null;
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
  const { prio, due, seq } = runnable(pending, t);
  const out = [];
  const taken = new Set(busyLanes);
  for (const j of [...prio, ...due, ...seq]) {
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
  let n = 0;
  mutateQueue((q) => {
    for (const j of q) {
      if (j.status !== 'pending' || !j.when || j.when > t - graceMs) continue;
      j.status = 'missed';
      j.finishedAt = t;
      j.error = `missed: its time (${fmt(j.when)}) passed more than ${humanDur(graceMs)} ago; `
        + 'nothing was running then. Reschedule it with "edit" if you still want it';
      n++;
    }
    return q;
  });
  return n;
}

/**
 * A job left `running` by a runner that died (killed daemon, closed terminal, reboot)
 * would sit there forever and block nothing — but it lies in `list` and its output is
 * never written. On every start we close those out as errors.
 */
export function reapStale() {
  let n = 0;
  mutateQueue((q) => {
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
    return q;
  });
  return n;
}
