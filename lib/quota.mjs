// Running out of quota mid-launch is not a failure — it is an interruption.
//
// The overnight batch died exactly this way: the last job hit the 5-hour session limit,
// got marked `error`, and the work was simply lost. Claude's CLI exits 1 and prints
// "You've hit your session limit · resets 1:30pm (Europe/Madrid)", which looks like any
// other crash to anything that only checks the exit code.
//
// So we recognise it, work out when the quota actually comes back, and let the runner
// put the job back in the queue instead of burning it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIMIT_RE = /(hit|reached|exceeded).{0,20}\b(session|usage|rate)\s+limit|limit reached|out of (usage|credits)/i;

/** Did this launch die because the quota ran out (rather than because it broke)? */
export const isQuotaExhausted = (text) => LIMIT_RE.test(String(text ?? ''));

/**
 * The reset time the CLI printed: "resets 1:30pm (Europe/Madrid)", "resets at 08:30",
 * "resets 3am". Returns epoch ms, always in the future — a time that already went by
 * today means tomorrow, and we never hand the runner a wake-up in the past.
 */
export function parseResetAt(text, now = Date.now()) {
  const m = String(text ?? '').match(/resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;

  let hour = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (hour > 23 || min > 59) return null;

  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const at = new Date(now);
  at.setHours(hour, min, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);   // already gone today → tomorrow
  return at.getTime();
}

/**
 * The other half of the answer, from the claude-usage tool: it snapshots the real
 * `rate_limits` block out of the statusline, which carries an exact ISO reset stamp.
 * More trustworthy than parsing prose — when it is fresh.
 */
export function resetFromUsage(file = path.join(os.homedir(), '.claude', 'usage.json')) {
  let usage;
  try { usage = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }

  const stamps = [usage?.five_hour?.resets_at, usage?.seven_day?.resets_at]
    .map((s) => (s ? Date.parse(s) : NaN))
    .filter((t) => Number.isFinite(t) && t > Date.now());

  return stamps.length ? Math.min(...stamps) : null;
}

/**
 * Was the launch cut short by the quota, and when can we try again?
 *
 * The printed message wins over the usage file: it describes *this* launch, whereas
 * usage.json only refreshes when a statusline runs and may be hours stale.
 */
export function quotaVerdict(text, { now = Date.now(), usageFile, graceMs = 60_000 } = {}) {
  if (!isQuotaExhausted(text)) return { exhausted: false, resetsAt: null, source: null };

  const fromText = parseResetAt(text, now);
  if (fromText) return { exhausted: true, resetsAt: fromText + graceMs, source: 'message' };

  const fromFile = usageFile === undefined ? resetFromUsage() : resetFromUsage(usageFile);
  if (fromFile) return { exhausted: true, resetsAt: fromFile + graceMs, source: 'usage' };

  // We know it ran out but not when it comes back: the 5-hour window is the safe guess.
  return { exhausted: true, resetsAt: now + 5 * 3600_000, source: 'fallback' };
}

// A launch that keeps hitting the limit would otherwise bounce between "requeued" and
// "out of quota" forever, so give up after a few honest tries.
export const MAX_QUOTA_RETRIES = 3;

/**
 * What to do with a job whose launch just came back empty-handed.
 *
 * `requeue` deliberately leaves `when` ALONE. That is what preserves the order: the job
 * keeps the time it was scheduled for, so when the quota returns it is still the
 * earliest due job and goes first, and everything behind it stays behind it.
 */
export function planRetry(job, verdict) {
  if (!verdict.exhausted) return { action: 'fail' };

  const tries = (job.quotaRetries ?? 0) + 1;
  if (tries > MAX_QUOTA_RETRIES) {
    return { action: 'fail', reason: `out of quota ${tries} times in a row; giving up` };
  }
  return { action: 'requeue', quotaRetries: tries, waitUntil: verdict.resetsAt };
}
