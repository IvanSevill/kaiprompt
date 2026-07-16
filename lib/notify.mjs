// Knocking on the phone when a launch finishes.
//
// This is the half of the notification story that lives on the PC, and without it the
// phone's listener sits there waiting for a knock that never comes. There is no cloud in
// the middle: while the app is foregrounded, the PC POSTs straight to the phone. WorkManager
// catch-up is the durable background path.
//
// It is best-effort by design. A phone that is off, out of signal, or whose service Android
// killed simply does not answer, and that is FINE: the app's catch-up poll will find the
// finished job on its next wake-up. Trying to make this reliable would mean a queue, retries
// and persistence — a lot of machinery to duplicate a safety net that already exists.

import { loadQueue } from '../src/storage/repositories.mjs';
import { jobPreview } from '../src/core/prompt.mjs';
import { seal } from './crypto.mjs';

const TIMEOUT_MS = 4000;

/**
 * Tell every paired phone that a job ended.
 *
 * Never throws: a launch must not be reported as failed because a notification could not be
 * delivered. The work happened; the phone just missed the news.
 */
export async function notifyFinished(job, { fetchImpl = fetch } = {}) {
  const { serverConfig, publish } = await import('./server.mjs');

  // The live stream gets it too, so a phone with the app open sees the change at once
  // rather than waiting for the notification it does not need.
  publish(jobEvent(job));

  // A device may be registered with no callback url: it told us its name but could not work
  // out its own LAN address to be knocked on (mobile data, no wifi). There is nowhere to
  // knock, so we skip it — its catch-up poll will find the finished job on the next wake-up.
  const conf = serverConfig();
  const devices = (conf.devices ?? []).filter((d) => d.url);
  if (!devices.length) return { sent: 0, dropped: 0 };

  const body = JSON.stringify(seal({
    id: job.id,
    status: job.status,
    preview: jobPreview(job, 90),
    target: job.target ?? null,
    error: job.error ?? null,
    finishedAt: job.finishedAt ?? Date.now(),
  }, conf.key));

  let sent = 0;
  const dead = [];

  await Promise.all(devices.map(async (d) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(d.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${conf.token}`,
          'content-type': 'application/json; charset=utf-8',
          'x-kaip-enc': '1',
        },
        body,
        signal: ctrl.signal,
      });
      if (!response.ok) throw new Error(`callback HTTP ${response.status}`);
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
