// Best-effort release checks. A failed network request must never affect the CLI.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { DATA } from './store.mjs';

const LATEST_URL = 'https://api.github.com/repos/IvanSevill/kaiprompt/releases/latest';
const CACHE = path.join(DATA, 'update.json');
const HOUR = 60 * 60 * 1000;
let checking = null;

const versionParts = (v) => String(v ?? '').replace(/^v/i, '').split('.').map((n) => Number(n) || 0);
const newer = (latest, current) => {
  const a = versionParts(latest); const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
};

function cached() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}

function writeCache(value) {
  let temp;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    temp = `${CACHE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, CACHE);
  } catch {
    if (temp) try { fs.rmSync(temp, { force: true }); } catch { /* cache is optional */ }
  }
}

export function cachedVersion() {
  const value = cached();
  return value?.checkedAt && Date.now() - value.checkedAt < HOUR ? value.update ?? null : null;
}

/** Return a newer public GitHub release, or null. Results (including up-to-date) last an hour. */
export function checkVersion({ fetcher = globalThis.fetch } = {}) {
  const old = cached();
  if (old?.checkedAt && Date.now() - old.checkedAt < HOUR) return Promise.resolve(old.update ?? null);
  if (checking) return checking;
  if (typeof fetcher !== 'function') return Promise.resolve(null);

  checking = Promise.resolve(fetcher(LATEST_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kaiprompt' } }))
    .then((response) => response?.ok ? response.json() : null)
    .then(async (release) => {
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      const latest = String(release?.tag_name ?? '').replace(/^v/i, '');
      const update = latest && newer(latest, pkg.version)
        ? { current: pkg.version, latest, url: release.html_url ?? release.url ?? LATEST_URL, notes: release.body ?? '' }
        : null;
      writeCache({ checkedAt: Date.now(), update });
      return update;
    })
    .catch(() => null)
    .finally(() => { checking = null; });
  return checking;
}

export function openRelease(url, { spawnImpl = spawn, platform = process.platform } = {}) {
  const target = new URL(String(url));
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('release URL must use http or https');
  const spec = platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', target.href] }
    : platform === 'darwin'
      ? { command: 'open', args: [target.href] }
      : { command: 'xdg-open', args: [target.href] };
  const child = spawnImpl(spec.command, spec.args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref?.();
  return target.href;
}
