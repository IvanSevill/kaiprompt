import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const USAGE_FILE = path.join(os.homedir(), '.claude', 'usage.json');

function stamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : null;
}

export function readUsage(file = USAGE_FILE) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const limits = raw?.rate_limits ?? raw;
  const window = (name) => {
    const used = Number(limits?.[name]?.used_percentage);
    const resetsAt = stamp(limits?.[name]?.resets_at);
    if (!Number.isFinite(used) && !resetsAt) return null;
    return {
      usedPct: Number.isFinite(used) ? used : null,
      freePct: Number.isFinite(used) ? Math.max(0, 100 - used) : null,
      resetsAt,
    };
  };
  return {
    session: window('five_hour'), weekly: window('seven_day'), updatedAt: stamp(raw?.updatedAt),
  };
}

export function sessionQuota(file = USAGE_FILE, now = Date.now()) {
  const usage = readUsage(file);
  if (!usage?.session) return null;
  const renewed = Boolean(usage.session.resetsAt && now >= usage.session.resetsAt);
  return {
    ...usage.session,
    renewed,
    freePct: renewed ? 100 : usage.session.freePct,
    usedPct: renewed ? 0 : usage.session.usedPct,
  };
}

export function resetFromUsage(file = USAGE_FILE, now = Date.now()) {
  const usage = readUsage(file);
  const stamps = [usage?.session?.resetsAt, usage?.weekly?.resetsAt]
    .filter((at) => Number.isFinite(at) && at > now);
  return stamps.length ? Math.min(...stamps) : null;
}
