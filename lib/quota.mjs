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

// Both windows can cut a launch off: the 5-hour session AND the 7-day one. They are
// worded differently ("session limit" vs "weekly limit"), and missing the weekly one
// would mean treating a week-long outage as a crash.
const LIMIT_RE = /(?:\b(?:hit|reached|exceeded)\b.{0,24}\b(?:session|usage|rate|weekly|week)\s*limit\b|\b(?:session|usage|rate|weekly|week)\s*limit\b.{0,24}\b(?:hit|reached|exceeded)\b|\b429\b.{0,40}(?:too many|rate|quota)?|\bRESOURCE_EXHAUSTED\b|\bquota\s+exceeded\b|\bout of (?:usage|credits)\b)/i;

/** Did this launch die because the quota ran out (rather than because it broke)? */
export const isQuotaExhausted = (text) => LIMIT_RE.test(String(text ?? ''));

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The reset time the CLI printed. Two shapes, because the two windows differ:
 *   session  "resets 1:30pm (Europe/Madrid)", "resets at 08:30", "resets 3am"  → today/tomorrow
 *   weekly   "resets Thursday at 9am", "resets Sunday"                          → that weekday
 *
 * Always lands in the future: we never hand the runner a wake-up in the past.
 */
export function parseResetAt(text, now = Date.now()) {
  const s = String(text ?? '');
  const relative = s.match(/(?:retry-after\s*:?|retry\s+after|try\s+again\s+in)\s*(\d+)\s*(s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)?\b/i);
  if (relative) {
    const n = Number(relative[1]); const unit = (relative[2] || 's').toLowerCase();
    return now + n * (unit.startsWith('h') ? 3600_000 : unit.startsWith('m') ? 60_000 : 1000);
  }
  const dated = s.match(/resets?\s*(?:at\s*)?(?:(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}))(?:,?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (dated) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const monthName = dated[2] || dated[3]; const day = Number(dated[1] || dated[4]);
    const month = months.indexOf(monthName.slice(0, 3).toLowerCase());
    if (month >= 0 && day >= 1 && day <= 31) {
      let hour = Number(dated[5] ?? 0); const min = Number(dated[6] ?? 0); const ap = dated[7]?.toLowerCase();
      if (hour <= 23 && min <= 59) {
        if (ap === 'pm' && hour < 12) hour += 12;
        if (ap === 'am' && hour === 12) hour = 0;
        const at = new Date(now); at.setMonth(month, day); at.setHours(hour, min, 0, 0);
        if (at.getTime() <= now) at.setFullYear(at.getFullYear() + 1);
        return at.getTime();
      }
    }
  }
  const m = s.match(/resets?\s*(?:at\s*)?(?:(\w+day)\s*(?:at\s*)?)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (!m || (!m[1] && !m[2])) return null;

  const weekday = m[1] ? DAYS.indexOf(m[1].toLowerCase()) : -1;
  if (m[1] && weekday < 0) return null;

  let hour = m[2] === undefined ? 0 : Number(m[2]);
  const min = Number(m[3] ?? 0);
  const ampm = m[4]?.toLowerCase();
  if (hour > 23 || min > 59) return null;

  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const at = new Date(now);
  at.setHours(hour, min, 0, 0);

  if (weekday >= 0) {                                       // weekly: jump to that weekday
    let ahead = (weekday - at.getDay() + 7) % 7;
    if (ahead === 0 && at.getTime() <= now) ahead = 7;      // "today" but already past → next week
    at.setDate(at.getDate() + ahead);
  } else if (at.getTime() <= now) {
    at.setDate(at.getDate() + 1);                           // already gone today → tomorrow
  }
  return at.getTime();
}

export const USAGE_FILE = path.join(os.homedir(), '.claude', 'usage.json');

/** `resets_at` comes as epoch SECONDS from the statusline; older dumps used ISO. Take both. */
function stamp(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
}

/**
 * The two rate-limit windows, as the claude-usage tool last snapshotted them out of the
 * statusline. That is the ONLY place Claude Code exposes them, and it only refreshes on
 * an API response — so a reading can be stale, and the caller has to care.
 */
export function readUsage(file = USAGE_FILE) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }

  const limits = raw?.rate_limits ?? raw;          // tolerate a bare rate_limits dump
  const win = (w) => {
    const used = Number(limits?.[w]?.used_percentage);
    const at = stamp(limits?.[w]?.resets_at);
    if (!Number.isFinite(used) && !at) return null;
    return {
      usedPct: Number.isFinite(used) ? used : null,
      freePct: Number.isFinite(used) ? Math.max(0, 100 - used) : null,
      resetsAt: at,
    };
  };
  return { session: win('five_hour'), weekly: win('seven_day'), updatedAt: stamp(raw?.updatedAt) };
}

/**
 * The 5-hour window — the one that actually cuts a launch off mid-flight.
 * `renewed` means the clock already went past its reset, so the reading is spent: the
 * quota is back but nothing has called the statusline yet to prove it.
 */
export function sessionQuota(file = USAGE_FILE, now = Date.now()) {
  const u = readUsage(file);
  if (!u?.session) return null;
  const renewed = Boolean(u.session.resetsAt && now >= u.session.resetsAt);
  return {
    ...u.session,
    renewed,
    freePct: renewed ? 100 : u.session.freePct,
    usedPct: renewed ? 0 : u.session.usedPct,
  };
}

/** When does quota come back, per the usage file? Earliest window still in the future. */
export function resetFromUsage(file = USAGE_FILE) {
  const u = readUsage(file);
  const stamps = [u?.session?.resetsAt, u?.weekly?.resetsAt]
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
  const kind = /weekly|week/i.test(String(text)) ? 'weekly' : /429|rate|resource_exhausted|quota exceeded/i.test(String(text)) ? 'rate' : 'session';

  const fromText = parseResetAt(text, now);
  if (fromText) return { exhausted: true, resetsAt: fromText + graceMs, source: 'message', kind };

  const fromFile = usageFile === undefined ? resetFromUsage() : resetFromUsage(usageFile);
  if (fromFile) return { exhausted: true, resetsAt: fromFile + graceMs, source: 'usage', kind };

  // We know it ran out but not when it comes back: the 5-hour window is the safe guess.
  return { exhausted: true, resetsAt: now + (kind === 'weekly' ? 7 * 24 * 3600_000 : kind === 'rate' ? 60_000 : 5 * 3600_000), source: 'fallback', kind };
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
  return { action: 'requeue', quotaRetries: tries, waitUntil: verdict.resetsAt, kind: verdict.kind ?? null };
}
