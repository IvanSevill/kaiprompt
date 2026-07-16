import fs from 'node:fs';

import {
  HIDDEN_CONVERSATIONS, LAUNCH_DEFAULTS, PROJECTS, QUEUE, SESSIONS,
} from './paths.mjs';
import { mutateJSON, readJSON, writeJSON } from './json.mjs';

export const loadQueue = () => readJSON(QUEUE, []);
export const saveQueue = (queue) => writeJSON(QUEUE, queue);
export const mutateQueue = (update) => mutateJSON(QUEUE, [], update);
export const loadSessions = () => readJSON(SESSIONS, {});
export const saveSessions = (sessions) => writeJSON(SESSIONS, sessions);
export const mutateSessions = (update) => mutateJSON(SESSIONS, {}, update);
export const loadHiddenConversations = () => readJSON(HIDDEN_CONVERSATIONS, { conversationIds: [] });
export const mutateHiddenConversations = (update) => mutateJSON(
  HIDDEN_CONVERSATIONS, { conversationIds: [] }, update,
);
export const loadLaunchDefaults = () => readJSON(LAUNCH_DEFAULTS, {});
export const saveLaunchDefaults = ({ engine, provider, model, perm } = {}) => writeJSON(LAUNCH_DEFAULTS, {
  engine: engine || 'claude',
  provider: provider || null,
  model: model || null,
  perm: perm || 'bypass',
});
export const loadProjects = () => readJSON(PROJECTS, {});
export const saveProjects = (projects) => writeJSON(PROJECTS, projects);

export const nowMs = () => Date.now();

export function patchJob(job) {
  mutateQueue((queue) => queue.map((candidate) => (candidate.id === job.id ? job : candidate)));
}

export function sessionFor(target, adapter = 'claude') {
  const entry = loadSessions()[target];
  if (!entry) return null;
  if (entry.engines) return entry.engines[adapter] ?? null;
  return entry.adapter === adapter ? entry : null;
}

export function rememberSession(target, sessionId, adapter = 'claude', extra = {}) {
  return mutateSessions((sessions) => {
    const previous = sessions[target];
    const engines = previous?.engines ? { ...previous.engines } : {};
    if (!previous?.engines && previous?.sessionId && previous?.adapter) engines[previous.adapter] = previous;
    const record = { sessionId, adapter, updatedAt: nowMs(), ...extra };
    engines[adapter] = record;
    sessions[target] = { ...record, engines };
    return sessions;
  });
}

export function resolveDir(value, fallback) {
  if (!value || typeof value !== 'string') return fallback ?? null;
  const raw = value.trim();
  const map = loadProjects();
  const alias = Object.entries(map).find(([key]) => key !== '_base' && key.toLowerCase() === raw.toLowerCase());
  if (alias) return alias[1];
  if (map._base) {
    try {
      const hit = fs.readdirSync(map._base, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && entry.name.toLowerCase() === raw.toLowerCase());
      if (hit) return String(map._base).replace(/[\\/]+$/, '') + '/' + hit.name;
    } catch { /* _base not reachable */ }
  }
  if (!fs.existsSync(raw)) {
    const known = Object.keys(map).filter((key) => key !== '_base');
    throw new Error(
      `no such folder: "${raw}"\n`
      + '  it is not an alias, not a project under your base folder, and not a path that exists.\n'
      + (known.length ? `  aliases: ${known.join(', ')}\n` : '')
      + `  register it:  kaip projects ${raw} <full/path>`,
    );
  }
  return raw;
}
