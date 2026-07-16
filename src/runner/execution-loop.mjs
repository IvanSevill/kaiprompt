import { loadQueue, nowMs } from '../storage/repositories.mjs';
import { sleep } from '../core/time.mjs';
import {
  IDLE_POLL_MS, isPriority, laneOf, reapMissed, startable,
} from '../core/schedule.mjs';
import { commit, launch, markRunning } from './lifecycle.mjs';

const pendingJobs = () => loadQueue().filter((job) => job.status === 'pending');

function eligible(jobs, scheduledOnly) {
  return scheduledOnly
    ? jobs.filter((job) => job.when || isPriority(job))
    : jobs;
}

function nextWake(jobs) {
  const times = jobs.map((job) => Math.max(job.when || 0, job.pausedUntil || 0)).filter(Boolean);
  return times.length ? Math.min(...times) : null;
}

/** One scheduling/lifecycle loop; capacity and presentation are its only mode differences. */
export async function runExecutionLoop({
  capacity = 1, once = false, loop = false, watch = false, scheduledOnly = false,
  pollMs = 15_000, presentation = {},
}) {
  const active = [];
  const stayOpen = loop || watch;
  const waiting = () => pendingJobs().filter((job) => !active.some((entry) => entry.job.id === job.id));

  const start = (job) => {
    markRunning(job);
    const entry = { job, ...(presentation.createEntry?.(job) ?? {}) };
    presentation.started?.(entry, waiting);
    entry.done = (async () => {
      const { res, end } = await launch(job, {
        onEvent: (event) => presentation.event?.(entry, event, waiting),
      });
      await commit(job, end);
      await presentation.finished?.(entry, res, end, waiting);
      active.splice(active.indexOf(entry), 1);
      return { res, end };
    })();
    active.push(entry);
  };

  presentation.begin?.(active, waiting);
  try {
    for (;;) {
      const missed = reapMissed();
      if (missed) presentation.missed?.(missed);

      const pending = pendingJobs();
      const candidates = eligible(pending, scheduledOnly);
      const busy = active.map((entry) => laneOf(entry.job));
      for (const job of startable(candidates, busy, capacity - active.length)) start(job);
      presentation.draw?.(active, waiting());

      if (active.length) {
        await Promise.race(active.map((entry) => entry.done));
        continue;
      }

      const next = nextWake(candidates);
      presentation.idle?.({ pending, candidates, next, once, stayOpen });
      if (once || (!next && !stayOpen)) break;

      const waitMs = next
        ? Math.max(1000, Math.min(next - nowMs(), pollMs))
        : IDLE_POLL_MS;
      if (presentation.wait) await presentation.wait({ pending, next, waitMs });
      else await sleep(waitMs);
    }
    await Promise.all(active.map((entry) => entry.done));
  } finally {
    presentation.end?.();
  }
  presentation.drained?.();
}
