// Explicit data migrations: persisted queues are user work, never something to rewrite on boot.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadQueue, loadSessions, saveQueue, saveSessions } from './store.mjs';
import { normalizeSelection } from './engines.mjs';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function inspectEngineMigration() {
  const jobs = loadQueue(); const sessions = loadSessions(); const issues = [];
  for (const job of jobs) {
    try { normalizeSelection(job, { required: true }); }
    catch (e) { issues.push({ type: 'job', id: job.id, message: e.message }); }
  }
  for (const [target, value] of Object.entries(sessions)) {
    if (!value?.engines && value?.sessionId) issues.push({ type: 'session', target, message: 'legacy single-engine session' });
  }
  return { jobs: jobs.length, sessions: Object.keys(sessions).length, issues };
}

export function applyEngineMigration() {
  const report = inspectEngineMigration();
  if (loadQueue().some((job) => job.status === 'running')) throw new Error('cannot migrate while a job is running');
  const queueFile = path.join(DATA, 'queue.json'); const sessionsFile = path.join(DATA, 'sessions.json');
  const backup = `${stamp()}`;
  if (fs.existsSync(queueFile)) fs.copyFileSync(queueFile, path.join(DATA, `queue.${backup}.bak.json`));
  if (fs.existsSync(sessionsFile)) fs.copyFileSync(sessionsFile, path.join(DATA, `sessions.${backup}.bak.json`));
  const sessions = loadSessions();
  for (const [target, value] of Object.entries(sessions)) {
    if (value?.engines || !value?.sessionId) continue;
    sessions[target] = { ...value, engines: { [value.adapter || 'claude']: { ...value, adapter: value.adapter || 'claude' } } };
  }
  saveSessions(sessions);
  const queue = loadQueue().map((job) => {
    try { normalizeSelection(job, { required: true }); return { ...job, selectionVersion: 2 }; }
    catch { return job; }
  });
  saveQueue(queue);
  return { ...report, backup };
}
