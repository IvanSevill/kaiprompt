// What is happening RIGHT NOW — in one word.
//
// From a phone you cannot see the terminal, so the queue alone is not enough: a job sitting
// at `pending` can mean four completely different things, and two of them need you to get up
// and do something while the other two do not. Telling them apart is the whole job here.
//
// The one that matters most is `quota` vs `stalled`. Both look identical from the outside —
// nothing is moving — and they are opposites:
//
//   quota    it IS going to run. Sit down. It resumes by itself at 15:42.
//   stalled  it is NOT going to run. Ever. Nobody is draining the queue.
//
// Without this distinction the phone shows "nothing is happening" for both, and you learn to
// read that as "broken", which means the day it really IS broken you shrug at it.
//
// Derived here, once, and sent down the wire — so the terminal panel and the phone cannot
// drift into disagreeing about what the machine is doing.

/**
 * `pausedUntil` is the key, and it is a FACT, not a guess: launch.mjs writes it on the job
 * when a launch comes back out of quota, along with putting the job back to `pending`. So we
 * are reading the runner's own note to itself about when it will pick this up again, rather
 * than inferring a wait from usage.json — which is refreshed by a statusline and can be
 * hours stale.
 *
 * The order of the checks is the argument:
 *
 *   1. running   something is executing. Nothing else competes with that.
 *   2. stalled   there is work and NOBODY will fire it — checked BEFORE quota, because a job
 *                paused for quota whose runner has since died is not waiting, it is stranded.
 *                The note on the job says "resumes at 15:42"; nothing is coming at 15:42.
 *   3. quota     cut short, and the runner that cut it is still there, sleeping until reset.
 *   4. queued    work, and someone to do it, but not yet its turn.
 *   5. idle      nothing pending.
 */
export function activityState({ jobs = [], willFire = false, now = Date.now() } = {}) {
  const running = jobs.find((j) => j.status === 'running');
  if (running) {
    return {
      state: 'running',
      jobId: running.id,
      preview: running.preview ?? null,
      since: running.startedAt ?? null,
      pending: jobs.filter((j) => j.status === 'pending').length,
    };
  }

  const pending = jobs.filter((j) => j.status === 'pending');
  if (!pending.length) return { state: 'idle', pending: 0 };

  // Nobody is draining the queue. Whatever the jobs say about themselves, none of it happens.
  if (!willFire) {
    const scheduled = pending.filter((j) => j.when != null).length;
    return { state: 'stalled', pending: pending.length, scheduled };
  }

  // A runner IS there, holding the lock, asleep until the quota comes back. The job it was
  // running went back in the queue with the time written on it.
  const paused = pending
    .filter((j) => Number.isFinite(j.pausedUntil) && j.pausedUntil > now)
    .sort((a, b) => a.pausedUntil - b.pausedUntil)[0];

  if (paused) {
    return {
      state: 'quota',
      jobId: paused.id,
      preview: paused.preview ?? null,
      until: paused.pausedUntil,
      pending: pending.length,
    };
  }

  // The soonest thing due. A job with no `when` waits for a run and has no time to show.
  const next = pending
    .map((j) => j.when)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0] ?? null;

  return { state: 'queued', pending: pending.length, next };
}
