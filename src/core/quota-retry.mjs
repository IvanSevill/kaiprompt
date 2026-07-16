const LIMIT_RE = /(?:\b(?:hit|reached|exceeded)\b.{0,24}\b(?:session|usage|rate|weekly|week)\s*limit\b|\b(?:session|usage|rate|weekly|week)\s*limit\b.{0,24}\b(?:hit|reached|exceeded)\b|\b429\b.{0,40}(?:too many|rate|quota)?|\bRESOURCE_EXHAUSTED\b|\bquota\s+exceeded\b|\bout of (?:usage|credits)\b)/i;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export const isQuotaExhausted = (text) => LIMIT_RE.test(String(text ?? ''));

export function parseResetAt(text, now = Date.now()) {
  const value = String(text ?? '');
  const relative = value.match(/(?:retry-after\s*:?|retry\s+after|try\s+again\s+in)\s*(\d+)\s*(s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)?\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] || 's').toLowerCase();
    return now + amount * (unit.startsWith('h') ? 3600_000 : unit.startsWith('m') ? 60_000 : 1000);
  }
  const dated = value.match(/resets?\s*(?:at\s*)?(?:(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}))(?:,?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (dated) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthName = dated[2] || dated[3];
    const day = Number(dated[1] || dated[4]);
    const month = months.indexOf(monthName.slice(0, 3).toLowerCase());
    if (month >= 0 && day >= 1 && day <= 31) {
      let hour = Number(dated[5] ?? 0);
      const minute = Number(dated[6] ?? 0);
      const meridiem = dated[7]?.toLowerCase();
      if (hour <= 23 && minute <= 59) {
        if (meridiem === 'pm' && hour < 12) hour += 12;
        if (meridiem === 'am' && hour === 12) hour = 0;
        const at = new Date(now);
        at.setMonth(month, day);
        at.setHours(hour, minute, 0, 0);
        if (at.getTime() <= now) at.setFullYear(at.getFullYear() + 1);
        return at.getTime();
      }
    }
  }
  const match = value.match(/resets?\s*(?:at\s*)?(?:(\w+day)\s*(?:at\s*)?)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (!match || (!match[1] && !match[2])) return null;
  const weekday = match[1] ? DAYS.indexOf(match[1].toLowerCase()) : -1;
  if (match[1] && weekday < 0) return null;
  let hour = match[2] === undefined ? 0 : Number(match[2]);
  const minute = Number(match[3] ?? 0);
  const meridiem = match[4]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (weekday >= 0) {
    let ahead = (weekday - at.getDay() + 7) % 7;
    if (ahead === 0 && at.getTime() <= now) ahead = 7;
    at.setDate(at.getDate() + ahead);
  } else if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

export function quotaVerdict(text, { now = Date.now(), usage = null, graceMs = 60_000 } = {}) {
  if (!isQuotaExhausted(text)) return { exhausted: false, resetsAt: null, source: null };
  const kind = /weekly|week/i.test(String(text)) ? 'weekly'
    : /429|rate|resource_exhausted|quota exceeded/i.test(String(text)) ? 'rate' : 'session';
  const active = [['session', usage?.session], ['weekly', usage?.weekly]].flatMap(
    ([windowKind, window]) => window && window.freePct === 0 && window.resetsAt > now
      ? [{ kind: windowKind, resetsAt: window.resetsAt + graceMs }] : [],
  );
  if (active.length) {
    const next = active.sort((a, b) => a.resetsAt - b.resetsAt)[0];
    return { exhausted: true, resetsAt: next.resetsAt, source: 'usage', kind: next.kind };
  }
  const fromText = parseResetAt(text, now);
  if (fromText) return { exhausted: true, resetsAt: fromText + graceMs, source: 'message', kind };
  const fromUsage = [usage?.session?.resetsAt, usage?.weekly?.resetsAt]
    .filter((at) => Number.isFinite(at) && at > now).sort((a, b) => a - b)[0];
  if (fromUsage) return { exhausted: true, resetsAt: fromUsage + graceMs, source: 'usage', kind };
  const delay = kind === 'weekly' ? 7 * 24 * 3600_000 : kind === 'rate' ? 60_000 : 5 * 3600_000;
  return { exhausted: true, resetsAt: now + delay, source: 'fallback', kind };
}

export const MAX_QUOTA_RETRIES = 3;

export function planRetry(job, verdict) {
  if (!verdict.exhausted) return { action: 'fail' };
  const tries = (job.quotaRetries ?? 0) + 1;
  if (tries > MAX_QUOTA_RETRIES) {
    return { action: 'fail', reason: `out of quota ${tries} times in a row; giving up` };
  }
  return {
    action: 'requeue', quotaRetries: tries, waitUntil: verdict.resetsAt, kind: verdict.kind ?? null,
  };
}
