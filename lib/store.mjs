// Data layer: queue, sessions, projects and the /programar inbox.
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
export const HOME = process.env.PROGRAM_PROMPT_HOME || ROOT;
export const DATA = path.join(HOME, 'data');
export const OUT = path.join(HOME, 'out');

const QUEUE = path.join(DATA, 'queue.json');
const SESSIONS = path.join(DATA, 'sessions.json');
const PROG = path.join(HOME, 'programados.jsonl');          // fed by the /programar hook
const PROG_STATE = path.join(DATA, 'programados.state.json');
const PROJECTS = path.join(HOME, 'projects.json');

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

export const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');

export const loadQueue = () => readJSON(QUEUE, []);
export const saveQueue = (q) => writeJSON(QUEUE, q);
export const loadSessions = () => readJSON(SESSIONS, {});
export const saveSessions = (s) => writeJSON(SESSIONS, s);
export const loadProjects = () => readJSON(PROJECTS, {});
export const saveProjects = (p) => writeJSON(PROJECTS, p);

export const outPath = (id) => path.join(OUT, `${id}.txt`);
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
  return raw;
}

/**
 * Import new launches scheduled from the chat (/programar writes programados.jsonl)
 * into the queue — each one only once (ids tracked in programados.state.json).
 */
export function importProgramados() {
  if (!fs.existsSync(PROG)) return 0;
  const lines = fs.readFileSync(PROG, 'utf8').split('\n').filter((l) => l.trim());
  const state = readJSON(PROG_STATE, { imported: [] });
  const seen = new Set(state.imported);
  const q = loadQueue();
  const have = new Set(q.map((j) => j.id));
  let n = 0;
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e.id || seen.has(e.id) || have.has(e.id)) continue;
    q.push({
      id: e.id, prompt: e.prompt, target: e.target || null,
      adapter: e.adapter || 'claude', when: e.when || null,
      dir: e.dir || null, permMode: e.permMode || null,
      status: 'pending', createdAt: e.createdAt || nowMs(),
      sessionId: null, output: null, prog: true,
    });
    seen.add(e.id); n++;
  }
  if (n) { saveQueue(q); writeJSON(PROG_STATE, { imported: [...seen] }); }
  return n;
}
