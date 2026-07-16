import { nowMs } from '../storage/repositories.mjs';
import { fmt, sleep } from '../core/time.mjs';
import { logLine, startedLine } from './lifecycle.mjs';
import { runExecutionLoop } from './execution-loop.mjs';

export function runPlain({ once, scheduledOnly = false, loop = false, watch = false, pollMs = 15_000 }) {
  const staysUp = loop || watch;
  return runExecutionLoop({
    capacity: 1, once, loop, watch, scheduledOnly, pollMs,
    presentation: {
      begin: () => {
        if (staysUp) logLine(`daemon up (pid ${process.pid}) · ${scheduledOnly ? 'scheduled jobs only' : 'scheduled + sequential'}`);
      },
      missed: (count) => logLine(`${count} launch(es) too overdue to fire; marked as missed`),
      started: ({ job }) => logLine(startedLine(job)),
      finished: async ({ job }, res, end) => {
        if (end.action === 'requeue') {
          logLine(`  ⏸ out of quota; ${job.id} back in the queue, resuming ${fmt(end.waitUntil)}`);
          if (!once) await sleep(Math.max(1000, end.waitUntil - nowMs()));
          return;
        }
        logLine(res.ok
          ? `  ✓ done → ${job.output}${job.sessionId ? '  (session ' + String(job.sessionId).slice(0, 8) + '…)' : ''}`
          : `  ✗ error: ${end.reason ?? res.error}`);
      },
      idle: ({ pending, next }) => {
        if (once) {
          if (pending.length) logLine(`${pending.length} pending (next: ${fmt(next)}); --once won't wait.`);
          else logLine('empty queue; nothing pending.');
        } else if (!staysUp && next) {
          logLine(`waiting for the next scheduled launch: ${fmt(next)}`);
        } else if (!staysUp && !next) logLine('empty queue; nothing pending.');
      },
    },
  });
}
