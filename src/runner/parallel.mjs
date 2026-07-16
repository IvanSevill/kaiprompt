import { fmt } from '../core/time.mjs';
import { eventLines, multiFrame } from '../../lib/frames.mjs';
import { altEnter, installCleanup, isTTY, paint, size } from '../../lib/ui.mjs';
import { logLine, startedLine } from './lifecycle.mjs';
import { runExecutionLoop } from './execution-loop.mjs';

const SPIN_MS = 200;

export async function runParallel({ once, max, scheduledOnly = false, pollMs = 15_000, tty = isTTY(), watch = false }) {
  const log = (line) => { if (!tty) logLine(line); };
  const restore = tty ? installCleanup() : () => {};
  let tick = 0;
  let activeRef = [];
  let waitingRef = () => [];
  const draw = () => {
    if (tty && activeRef.length) paint(multiFrame(activeRef, waitingRef(), tick));
  };
  if (tty) altEnter();
  const spinner = tty ? setInterval(() => { tick++; draw(); }, SPIN_MS) : null;
  try {
    await runExecutionLoop({
      capacity: max, once, watch, scheduledOnly, pollMs,
      presentation: {
        begin: (active, waiting) => { activeRef = active; waitingRef = waiting; },
        createEntry: () => ({ lines: [] }),
        started: ({ job }) => log(startedLine(job)),
        event: (entry, event) => {
          entry.lines.push(...eventLines(event, size().cols - 4));
        },
        finished: ({ job }, res, end) => log(end.action === 'requeue'
          ? `  ⏸ ${job.id} out of quota; back in the queue, resumes ${fmt(end.waitUntil)}`
          : (res.ok ? `  ✓ ${job.id} done → ${job.output}` : `  ✗ ${job.id} error: ${end.reason ?? res.error}`)),
        draw: () => draw(),
      },
    });
  } finally {
    if (spinner) clearInterval(spinner);
    restore();
  }
  console.log('queue drained.');
}
