// Data layer: queue, sessions and projects.
// Everything lives inside the tool folder, so the whole thing stays relocatable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ADAPTERS = path.join(ROOT, 'adapters');        // code always lives next to us

// User data can live elsewhere (tests point it at a temp dir; an install can point
// it outside the repo). Defaults to the tool folder, so nothing changes by default.
// Paths we store in the queue are relative to HOME — never to ROOT, or moving the data
// out of the repo would leave "../../../AppData/..." written in every job.
// PROGRAM_PROMPT_HOME is what this was called before the rename. Anyone with it already
// exported in a shell profile or a scheduled task should not silently lose their data.
export const HOME = process.env.KAIP_HOME
  || process.env.PROMPTHEUS_HOME || process.env.PROGRAM_PROMPT_HOME   // names it had before
  || ROOT;
export const DATA = path.join(HOME, 'data');
export const OUT = path.join(HOME, 'out');
export const HISTORY = path.join(DATA, 'history');

const QUEUE = path.join(DATA, 'queue.json');
const SESSIONS = path.join(DATA, 'sessions.json');
const PROJECTS = path.join(HOME, 'projects.json');

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(HISTORY, { recursive: true });

export const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');

export const loadQueue = () => readJSON(QUEUE, []);
export const saveQueue = (q) => writeJSON(QUEUE, q);
export const loadSessions = () => readJSON(SESSIONS, {});
export const saveSessions = (s) => writeJSON(SESSIONS, s);
export const loadProjects = () => readJSON(PROJECTS, {});
export const saveProjects = (p) => writeJSON(PROJECTS, p);

export const outPath = (id) => path.join(OUT, `${id}.txt`);
export const historyPath = (id) => path.join(HISTORY, `${id}.jsonl`);
export const nowMs = () => Date.now();

/**
 * Is that process still there? Signal 0 doesn't kill anything, it just asks.
 * EPERM means it exists but belongs to someone else — still alive.
 */
export const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Ids: time + a monotonic counter. The counter (not randomness) is what guarantees
// uniqueness — ids minted inside the same millisecond used to collide, and two jobs
// sharing an id would corrupt the queue (rm/show/patch would hit the wrong one).
// The random *start* keeps separate processes from lining up.
let idSeq = Math.floor(Math.random() * 46656);
export const nid = (p = 'j') => {
  idSeq = (idSeq + 1) % 46656;
  return p + Date.now().toString(36).slice(-5) + idSeq.toString(36).padStart(3, '0');
};

/** First line of a prompt, truncated — for list/preview rows. */
export const preview = (s, n = 48) => {
  const l = String(s ?? '').split('\n')[0];
  return l.length > n ? l.slice(0, n - 1) + '…' : l;
};

/** Update one job in the queue, re-reading first so we don't clobber concurrent writes. */
export function patchJob(job) {
  saveQueue(loadQueue().map((j) => (j.id === job.id ? job : j)));
}

/**
 * Record a target's session, re-reading first — the same rule as patchJob, and for the same
 * reason.
 *
 * A launch used to load sessions.json when it STARTED and write it back when it FINISHED,
 * with a whole launch in between. Anything written into that gap was silently erased on the
 * way out. `run --parallel` lives in that gap by design: three lanes start together, each
 * holding the file as it was before any of them ran, and the last one to finish wins. The
 * other two targets lost their session id, so their next job opened a brand-new conversation
 * and paid again for the context it already had — which is the one saving `--target` exists
 * to give you.
 *
 * Read late, write once, keep everyone else's keys.
 */
/** Read a target session only when it belongs to the engine that will resume it. */
export function sessionFor(target, adapter = 'claude') {
  const entry = loadSessions()[target];
  if (!entry) return null;
  if (entry.engines) return entry.engines[adapter] ?? null;
  return entry.adapter === adapter ? entry : null; // persisted v1 data
}

export function rememberSession(target, sessionId, adapter = 'claude', extra = {}) {
  const sessions = loadSessions();
  const previous = sessions[target];
  const engines = previous?.engines ? { ...previous.engines } : {};
  // Lift the legacy entry into its named engine before adding another one.
  if (!previous?.engines && previous?.sessionId && previous?.adapter) engines[previous.adapter] = previous;
  const record = { sessionId, adapter, updatedAt: nowMs(), ...extra };
  engines[adapter] = record;
  // Keep the newest record at the legacy top level while consumers migrate to `engines`.
  // This preserves external scripts that only display sessionId; resume logic uses engines.
  sessions[target] = { ...record, engines };
  saveSessions(sessions);
  return sessions;
}

/**
 * Resolve a launch folder. In order: explicit alias in projects.json →
 * subfolder of `_base` matched by name (case-insensitive) → literal path.
 * Falls back to `fallback` when there is no value.
 */
export function resolveDir(v, fallback) {
  if (!v || typeof v !== 'string') return fallback ?? null;
  const raw = v.trim();
  const map = loadProjects();
  const alias = Object.entries(map).find(([k]) => k !== '_base' && k.toLowerCase() === raw.toLowerCase());
  if (alias) return alias[1];
  if (map._base) {
    try {
      const hit = fs.readdirSync(map._base, { withFileTypes: true })
        .find((d) => d.isDirectory() && d.name.toLowerCase() === raw.toLowerCase());
      if (hit) return String(map._base).replace(/[\\/]+$/, '') + '/' + hit.name;
    } catch { /* _base not reachable */ }
  }

  // A name that matches no alias and no project used to fall through as a LITERAL path —
  // so `--dir kaiprompt`, meaning a folder that is not under _base, quietly became the
  // relative path "kaiprompt". The job then runs in whatever folder the runner happened to
  // start in, which is not a failure you find out about until it has already done the work
  // somewhere it should not have. Better to refuse now, while a person is watching.
  if (!fs.existsSync(raw)) {
    const known = Object.keys(map).filter((k) => k !== '_base');
    throw new Error(
      `no such folder: "${raw}"\n`
      + '  it is not an alias, not a project under your base folder, and not a path that exists.\n'
      + (known.length ? `  aliases: ${known.join(', ')}\n` : '')
      + `  register it:  kaip projects ${raw} <full/path>`
    );
  }
  return raw;
}
