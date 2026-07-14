// The runner: decides who is allowed to run, cleans up after whoever ran last, and hands
// the queue to one of the three loops.
//
// The work itself lives next door:
//   lock.mjs          one runner at a time
//   schedule.mjs      what runs now, the lanes, and closing out what never ran
//   launch.mjs        one job end to end (execute → settle → requeue or finish)
//   frames.mjs        everything that gets painted
//   run-plain.mjs     the unattended loop (daemon, Task Scheduler, pipes)
//   run-tui.mjs       the full-screen loop
//   run-parallel.mjs  the lane loop
//
// Non-TTY (Task Scheduler, background, piped output) → plain log, no TUI.
// That path must never break: the unattended 3am batch depends on it.

import { loadQueue, loadSessions, nowMs } from './store.mjs';
import { fmt, sleep } from './time.mjs';
import { acquireLock } from './lock.mjs';
import { nextUp, reapMissed, reapStale } from './schedule.mjs';
import { loadAdapter } from './launch.mjs';
import { runPlain } from './run-plain.mjs';
import { runTUI } from './run-tui.mjs';
import { runParallel } from './run-parallel.mjs';
import { isTTY } from './ui.mjs';

// The surface the CLI, the TUI and the tests import from here. The code moved; the door
// did not.
export { lockIsHeld } from './lock.mjs';
export { GRACE_MS, laneOf, reapMissed, reapStale, startable } from './schedule.mjs';
export { executeJob, requeue, settle } from './launch.mjs';

// --- dry run ------------------------------------------------------------------
async function dryRunPreview() {
  const pending = loadQueue().filter((j) => j.status === 'pending');
  if (!pending.length) return console.log('(nothing pending)');
  console.log('— dry-run: nothing will actually execute —');
  const t = nowMs();
  const { due, seq } = nextUp(pending, t);
  for (const job of [...due, ...seq]) {
    const sid = job.sessionId || loadSessions()[job.target]?.sessionId || null;
    const adapter = await loadAdapter(job.adapter);
    const res = await adapter.run({
      prompt: job.prompt, sessionId: sid, dryRun: true,
      dir: job.dir || null, permMode: job.permMode || null,
    });
    console.log(`▶ ${job.id} [${job.adapter}${job.target ? '/' + job.target : ''}]`);
    console.log('   ' + String(res.output || '').replace(/\n/g, '\n   '));
  }
  const future = pending.filter((j) => j.when && j.when > t);
  if (future.length) {
    console.log(`(+${future.length} scheduled: next ${fmt(Math.min(...future.map((j) => j.when)))})`);
  }
}

/**
 * Process the queue. One runner at a time, enforced by the lock: the daemon and a
 * manual `run` would otherwise both grab the same pending job and launch it twice.
 *
 *   loop           never exit (the daemon). Implies the plain view.
 *   scheduledOnly  only jobs with a time — sequential ones wait for a manual run.
 *   parallel       how many launches may run at once. Never two on the same target:
 *                  they share a conversation and resuming it twice would corrupt it.
 *   plain          force the plain log even on a terminal — for servers and CI, where
 *                  a full-screen TUI is just noise in the logs.
 */
export async function runQueue({
  once = false, dryRun = false, loop = false, scheduledOnly = false,
  pollMs = 15_000, parallel = 1, plain = false, watch = false,
} = {}) {
  if (dryRun) return dryRunPreview();

  const reaped = reapStale();
  if (reaped) console.log(`(${reaped} job(s) left running by a dead runner marked as error)`);
  const missed = reapMissed();
  if (missed) console.log(`(${missed} launch(es) too overdue to fire; marked as missed)`);

  // The daemon holds the lock whenever it is armed — and it usually is, because queueing
  // a scheduled job arms it. A person who just typed `run` should not be told "no" by a
  // background process they never see: at the terminal, the human wins. So we take the
  // daemon's shift, run in the foreground, and hand it back on the way out.
  let resumeDaemon = false;
  let release = acquireLock();

  if (!release && !loop) {
    const daemon = await import('./daemon.mjs');
    const st = daemon.status();
    if (st.running) {
      daemon.stop();
      resumeDaemon = true;
      console.log(`(took over from the daemon, pid ${st.pid} — it will be restarted on exit)`);
      await sleep(300);                     // let it drop the lock
      release = acquireLock();
    }
  }

  if (!release) {
    console.log('another runner is already active; nothing to do.');
    return;
  }

  const max = Math.max(1, Number(parallel) || 1);
  const tui = isTTY() && !loop && !plain;

  try {
    if (max > 1) return await runParallel({ once, max, scheduledOnly, pollMs, tty: tui, watch });
    return tui
      ? await runTUI({ once, watch })
      : await runPlain({ once, loop, watch, scheduledOnly, pollMs });
  } finally {
    release();
    if (resumeDaemon) {
      const daemon = await import('./daemon.mjs');
      const r = daemon.start();
      console.log(`(daemon back up, pid ${r.pid})`);
    }
  }
}
