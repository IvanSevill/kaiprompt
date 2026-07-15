// Knocking on the phone when a launch finishes.
//
// This is the half of the notification story that lives on the PC, and without it the
// phone's listener sits there waiting for a knock that never comes. There is no cloud in
// the middle: the PC POSTs straight to the phone, over the same tunnel, and the phone's
// foreground service turns that into a notification — with the app closed, at 3am.
//
// It is best-effort by design. A phone that is off, out of signal, or whose service Android
// killed simply does not answer, and that is FINE: the app's catch-up poll will find the
// finished job on its next wake-up. Trying to make this reliable would mean a queue, retries
// and persistence — a lot of machinery to duplicate a safety net that already exists.

import { loadQueue } from './store.mjs';
import { jobPreview } from './prompt.mjs';

const TIMEOUT_MS = 4000;

/**
 * Tell every paired phone that a job ended.
 *
 * Never throws: a launch must not be reported as failed because a notification could not be
 * delivered. The work happened; the phone just missed the news.
 */
export async function notifyFinished(job) {
  const { serverConfig, publish } = await import('./server.mjs');

  // The live stream gets it too, so a phone with the app open sees the change at once
  // rather than waiting for the notification it does not need.
  publish(jobEvent(job));

  // A device may be registered with no callback url: it told us its name but could not work
  // out its own LAN address to be knocked on (mobile data, no wifi). There is nowhere to
  // knock, so we skip it — its catch-up poll will find the finished job on the next wake-up.
  const devices = (serverConfig().devices ?? []).filter((d) => d.url);
  if (!devices.length) return { sent: 0, dropped: 0 };

  const body = JSON.stringify({
    id: job.id,
    status: job.status,
    preview: jobPreview(job, 90),
    target: job.target ?? null,
    error: job.error ?? null,
    finishedAt: job.finishedAt ?? Date.now(),
  });

  let sent = 0;
  const dead = [];

  await Promise.all(devices.map(async (d) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      await fetch(d.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      sent++;
      dead.push(null);
    } catch {
      // Count the misses, but do not forget the phone on the first one: it is probably just
      // asleep, and dropping it here would silently unpair someone for going through a
      // tunnel on the motorway.
      dead.push(d.url);
    } finally {
      clearTimeout(timer);
    }
  }));

  const misses = dead.filter(Boolean).length;
  return { sent, dropped: misses };
}

/**
 * A job's state changed. This is what the live view in the app is fed from — and it is the
 * same event the SSE stream carries, so the phone sees exactly what the terminal sees.
 */
export function jobEvent(job) {
  return {
    type: 'job',
    id: job.id,
    status: job.status,
    preview: jobPreview(job, 90),
    target: job.target ?? null,
    error: job.error ?? null,
  };
}

/** Everything still waiting, for the app's queue view and external status consumers. */
export const pendingCount = () => loadQueue().filter((j) => j.status === 'pending').length;
