// The unattended path: Task Scheduler, a pipe, and the background daemon.
//
// No TTY means no full-screen anything — just a timestamped log. That path must never
// break: the 3am batch nobody is watching is exactly the one that runs here.
//
//   loop:false  drain what's runnable and exit (the old behaviour)
//   loop:true   never exit — this is the daemon: sleep, re-read the queue (jobs
//               scheduled from the chat land there while we sleep) and fire on time

import { importProgramados, nowMs } from './store.mjs';
import { fmt, sleep } from './time.mjs';
import { IDLE_POLL_MS, nextUp, pendingJobs, reapMissed } from './schedule.mjs';
import { commit, launch, logLine, markRunning, startedLine } from './launch.mjs';

export async function runPlain({ once, scheduledOnly = false, loop = false, watch = false, pollMs = 15_000 }) {
  loop = loop || watch;                             // --watch is "stay up and keep listening"
  if (loop) logLine(`daemon up (pid ${process.pid}) · ${scheduledOnly ? 'scheduled jobs only' : 'scheduled + sequential'}`);

  for (;;) {
    importProgramados();                    // /programar wrote to the inbox while we slept
    const missed = reapMissed();            // and time passed: some of it may be too old now
    if (missed) logLine(`${missed} launch(es) too overdue to fire; marked as missed`);

    const pending = pendingJobs();
    const { job } = nextUp(pending, nowMs(), { scheduledOnly });

    if (!job) {
      const times = pending.filter((j) => j.when).map((j) => j.when);
      const next = times.length ? Math.min(...times) : null;

      if (once) {
        if (pending.length) logLine(`${pending.length} pending (next: ${fmt(next)}); --once won't wait.`);
        else logLine('empty queue; nothing pending.');
        return;
      }
      if (!loop) {
        if (!next) { logLine('empty queue; nothing pending.'); return; }
        logLine(`waiting for the next scheduled launch: ${fmt(next)}`);
      }
      // Sleep until the next launch, but wake up regularly anyway: a new job may have
      // been scheduled for *sooner* than the one we're waiting on — or for right now.
      const wait = next
        ? Math.max(1000, Math.min(next - nowMs(), pollMs))
        : IDLE_POLL_MS;                     // nothing at all queued: just listen, briskly
      await sleep(wait);
      continue;
    }

    markRunning(job);
    logLine(startedLine(job));

    const { res, end } = await launch(job);

    // Out of quota is an interruption, not a failure: put the job back where it was and
    // sleep until the reset. This is the whole reason the overnight batch lost its last
    // phase — it was marked `error` and nothing ever picked it up again.
    await commit(job, end);

    if (end.action === 'requeue') {
      logLine(`  ⏸ out of quota; ${job.id} back in the queue, resuming ${fmt(end.waitUntil)}`);
      if (once) return;
      await sleep(Math.max(1000, end.waitUntil - nowMs()));
      continue;                                   // same job, same place in the queue
    }

    logLine(res.ok
      ? `  ✓ done → ${job.output}${job.sessionId ? '  (session ' + String(job.sessionId).slice(0, 8) + '…)' : ''}`
      : `  ✗ error: ${end.reason ?? res.error}`);
  }
}
