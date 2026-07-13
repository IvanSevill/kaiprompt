// The full-screen runner: the big countdown while it waits, the live feed while it runs.
//
// This is the one you sit in front of. Everything it draws comes from frames.mjs; what
// lives here is the loop, the keys, and knowing which of the two states we are in.

import { importProgramados, nowMs } from './store.mjs';
import { sleep, fmt, humanDur } from './time.mjs';
import { nextUp, pendingJobs } from './schedule.mjs';
import { commit, launch, markRunning } from './launch.mjs';
import { clockFrame, eventLines, idleFrame, quotaWaitFrame, runningFrame } from './frames.mjs';
import { goodbye } from './goodbye.mjs';
import { altEnter, c, installCleanup, paint, size } from './ui.mjs';

const SPIN_MS = 150;

/** Arrow keys, `i`, Ctrl+C — the live view is something you read, not just watch. */
function attachKeys(view, redraw) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};

  const onData = (data) => {
    const s = String(data);
    if (s === '\x03') { process.kill(process.pid, 'SIGINT'); return; }
    if (s === '\x1b[A') view.scroll += 1;                       // up: back through the feed
    else if (s === '\x1b[B') view.scroll = Math.max(0, view.scroll - 1);
    else if (s === '\x1b[5~') view.scroll += 10;                // page up
    else if (s === '\x1b[6~') view.scroll = Math.max(0, view.scroll - 10);
    else if (s === '\x1b[F' || s === 'g') view.scroll = 0;      // end: follow the tail again
    else if (s === 'i') view.expanded = !view.expanded;
    else return;
    redraw();
  };

  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.on('data', onData);
  return () => {
    stdin.removeListener('data', onData);
    try { stdin.setRawMode?.(false); } catch { /* already closed */ }
    stdin.pause();
  };
}

/** Count down to the quota coming back. Same job, same place in the queue, no input needed. */
async function waitForQuota(until, job, view, setRepaint) {
  const start = nowMs();
  const paused = { ...job };
  const draw = () => paint(quotaWaitFrame(paused, until, pendingJobs(), start, view));
  setRepaint(draw);
  while (nowMs() < until) { draw(); await sleep(1000); }
}

export async function runTUI({ once, watch = false }) {
  const view = { scroll: 0, expanded: false };
  let repaint = () => {};

  // Ctrl+C lands here too: the terminal goes back to normal AND we say goodbye, instead
  // of dumping you back onto the wreckage of a half-painted full-screen frame.
  const detachKeys = attachKeys(view, () => repaint());
  const restore = installCleanup(() => { detachKeys(); goodbye(); });

  altEnter();
  try {
    for (;;) {
      importProgramados();
      const pending = pendingJobs();

      // With --watch the runner stays up on an empty queue instead of exiting: leave it
      // running and anything added later — from another terminal, from /programar — gets
      // picked up on its own. That is the point: queue the work, walk away.
      if (!pending.length) {
        if (!watch || once) break;
        repaint = () => paint(idleFrame());
        repaint();
        await sleep(2000);
        continue;
      }

      const { job } = nextUp(pending);

      if (!job) {                                   // only future scheduled jobs left
        if (once) break;
        let next = Math.min(...pending.map((j) => j.when));
        let upcoming = pending.find((j) => j.when === next);
        const waitStart = nowMs();
        repaint = () => paint(clockFrame(upcoming, next, pendingJobs(), waitStart, view));

        while (nowMs() < next) {                    // 1-second countdown tick
          repaint();
          await sleep(1000);

          // Re-read every tick. A prompt added WHILE we are counting down — possibly for
          // sooner than the one we are waiting on — must not be ignored until this one
          // fires; the whole point of leaving a run up is that you can feed it.
          const fresh = pendingJobs();
          const { job: dueNow } = nextUp(fresh);
          if (dueNow) break;                        // something is runnable right now
          const soonest = Math.min(...fresh.map((j) => j.when));
          if (soonest < next) {                     // someone queued something earlier
            next = soonest;
            upcoming = fresh.find((j) => j.when === soonest);
          }
        }
        continue;
      }

      // --- run it, streaming what Claude does ---
      markRunning(job);
      view.scroll = 0;

      const { cols } = size();
      const behind = () => pendingJobs().filter((j) => j.id !== job.id);
      const lines = [];
      let tick = 0;
      repaint = () => paint(runningFrame(job, lines, job.startedAt, tick, { ...view, pending: behind() }));
      repaint();
      const spinner = setInterval(() => { tick++; repaint(); }, SPIN_MS);

      let res, end;
      try {
        ({ res, end } = await launch(job, { onEvent: (e) => { lines.push(...eventLines(e, cols)); } }));
      } finally {
        clearInterval(spinner);
      }

      await commit(job, end);

      // Out of quota is not a failure: hold the job, wait for the reset, carry on.
      if (end.action === 'requeue') {
        lines.push('', c.warn('⏸ out of quota') + c.muted(` · resumes ${fmt(end.waitUntil)}`));
        repaint();
        await sleep(1500);
        if (once) break;
        await waitForQuota(end.waitUntil, job, view, (f) => { repaint = f; });
        continue;                                   // same job, same place in the queue
      }

      lines.push('', res.ok
        ? c.ok('✓ done') + c.muted(` · ${humanDur(nowMs() - job.startedAt)} · out/${job.id}.txt`)
        : c.err('✗ error') + c.muted(` · ${end.reason ?? res.error}`));
      repaint();
      await sleep(1200);                            // let the result be read
    }
  } finally {
    restore();          // restores the terminal, detaches the keys, and says goodbye
  }
}
