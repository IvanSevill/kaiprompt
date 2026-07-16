// Time parsing and formatting.

const WEEKDAYS = { dom: 0, sun: 0, lun: 1, mon: 1, mar: 2, tue: 2, 'mié': 3, mie: 3, wed: 3,
                   jue: 4, thu: 4, vie: 5, fri: 5, 'sáb': 6, sab: 6, sat: 6 };

/**
 * "09:00" · "+2h" · "tomorrow 09:00" / "mañana 09:00" · "mon 09:00" / "lun 09:00" ·
 * ISO "2026-07-12T09:00"  →  absolute epoch ms. Empty/null → null (sequential job).
 */
export function parseWhen(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  let m;

  if ((m = s.match(/^\+(\d+)\s*([mhd])$/))) {
    const mult = { m: 60000, h: 3600000, d: 86400000 }[m[2]];
    return Date.now() + Number(m[1]) * mult;
  }

  if ((m = s.match(/^(mañana|manana|tomorrow|hoy|today)\s+(\d{1,2}):(\d{2})$/))) {
    const d = new Date(); d.setSeconds(0, 0); d.setHours(Number(m[2]), Number(m[3]));
    if (!['hoy', 'today'].includes(m[1])) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  if ((m = s.match(/^([a-záé]{3})\s+(\d{1,2}):(\d{2})$/)) && m[1] in WEEKDAYS) {
    const d = new Date(); d.setSeconds(0, 0); d.setHours(Number(m[2]), Number(m[3]));
    let add = (WEEKDAYS[m[1]] - d.getDay() + 7) % 7;
    if (add === 0 && d.getTime() <= Date.now()) add = 7;   // that weekday already passed today
    d.setDate(d.getDate() + add);
    return d.getTime();
  }

  if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) {
    const d = new Date(); d.setSeconds(0, 0); d.setHours(Number(m[1]), Number(m[2]));
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);   // already past → tomorrow
    return d.getTime();
  }

  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    // Every other form rolls forward on its own, so this is the only way to end up with a
    // time in the past — and a past time means "overdue", which fires the moment a runner
    // sees it. That is never what someone typing a date meant. The usual cause is UTC:
    // an ISO string with a "Z" is UTC, one without it is local, and mixing them silently
    // shifts the launch by your whole timezone offset.
    if (t <= Date.now()) {
      throw new Error(`"${input}" is in the past (${new Date(t).toLocaleString()}), so it would `
        + 'launch immediately. Note an ISO time ending in "Z" is UTC, without it, local');
    }
    return t;
  }
  throw new Error(`can't parse time "${input}". Use HH:MM, +30m/+2h/+1d, "tomorrow 09:00", or ISO`);
}

export const fmt = (t) => (t ? new Date(t).toLocaleString() : '—');
export const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString() : '—');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ms → "DD:HH:MM:SS" (clamped at 0). */
export function hhmmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [d, h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * "12 min ago" — how long ago, rounded to the unit a person would say it in.
 *
 * Deliberately coarser than humanDur: "12m 30s ago" is a stopwatch reading, and nobody
 * asked what time it is to the second. They asked how stale this thing is.
 */
export function ago(t, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'a moment ago';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  }
  const d = Math.floor(s / 86400);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

/** ms → "3d 4h" / "2h 15m" / "45s" — compact, for one-liners. */
export function humanDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
