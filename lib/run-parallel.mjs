// Several launches at once, one per lane. Used when --parallel > 1.
//
// The lane rule (a target is a lane — see schedule.mjs) is what makes this safe: two jobs
// on the same target share one conversation, and resuming a session twice at once would
// corrupt it.
//
// Works with or without a terminal: with one it paints the stacked live view, without one
// it just logs, so the daemon can use it too.

import { importProgramados, loadQueue, nowMs } from './store.mjs';
import { fmt, sleep } from './time.mjs';
import { IDLE_POLL_MS, isPriority, laneOf, reapMissed, startable } from './schedule.mjs';
import { commit, launch, logLine, markRunning, startedLine } from './launch.mjs';
import { eventLines, multiFrame } from './frames.mjs';
import { altEnter, installCleanup, isTTY, paint, size } from './ui.mjs';

const SPIN_MS = 200;

export async function runParallel({ once, max, scheduledOnly = false, pollMs = 15_000, tty = isTTY(), watch = false }) {
  const log = (s) => { if (!tty) logLine(s); };
  const restore = tty ? installCleanup() : () => {};
  if (tty) altEnter();

  const actives = [];                               // { job, lines, done }
  let tick = 0;
  const waiting = () => loadQueue().filter((j) => j.status === 'pending'
    && !actives.some((a) => a.job.id === j.id));
  const draw = () => { if (tty && actives.length) paint(multiFrame(actives, waiting(), tick)); };

  const spinner = tty ? setInterval(() => { tick++; draw(); }, SPIN_MS) : null;

  const start = (job) => {
    markRunning(job);
    log(startedLine(job));

    const entry = { job, lines: [] };
    const { cols } = size();
    entry.done = launch(job, { onEvent: (e) => { entry.lines.push(...eventLines(e, cols - 4)); } })
      .then(async ({ res, end }) => {
        await commit(job, end);
        log(end.action === 'requeue'
          ? `  ⏸ ${job.id} out of quota; back in the queue, resumes ${fmt(end.waitUntil)}`
          : (res.ok ? `  ✓ ${job.id} done → ${job.output}` : `  ✗ ${job.id} error: ${end.reason ?? res.error}`));
        actives.splice(actives.indexOf(entry), 1);
        return res;
      });
    actives.push(entry);
  };

  try {
    for (;;) {
      importProgramados();
      reapMissed();

      const pending = loadQueue().filter((j) => j.status === 'pending'
        && !(j.pausedUntil && j.pausedUntil > nowMs())     // waiting for its quota to come back
        // The daemon leaves sequential jobs for a manual run — but a priority job is not one
        // of those: it was accepted, by name, to run as soon as the quota returns. Dropping
        // it here would strand it in the queue forever with nothing willing to take it.
        && !(scheduledOnly && !j.when && !isPriority(j)));

      const busy = actives.map((a) => laneOf(a.job));
      for (const j of startable(pending, busy, max - actives.length)) start(j);
      draw();

      if (actives.length) { await Promise.race(actives.map((a) => a.done)); continue; }
      if (once) break;

      const times = loadQueue()
        .filter((j) => j.status === 'pending')
        .map((j) => Math.max(j.when || 0, j.pausedUntil || 0))
        .filter(Boolean);
      if (!times.length) {
        if (!watch) break;                          // nothing running, nothing coming
        await sleep(IDLE_POLL_MS);                  // --watch: stay up, wait to be fed
        continue;
      }
      await sleep(Math.max(1000, Math.min(Math.min(...times) - nowMs(), pollMs)));
    }
    await Promise.all(actives.map((a) => a.done));
  } finally {
    if (spinner) clearInterval(spinner);
    restore();
  }
  console.log('queue drained.');
}
