// Explicit data migrations: persisted queues are user work, never something to rewrite on boot.
import fs from 'node:fs';
import path from 'node:path';
import { loadQueue, loadSessions } from '../src/storage/repositories.mjs';
import { DATA, DATA_FILES } from '../src/storage/paths.mjs';
import { withMutationLocks, writeJSON } from '../src/storage/json.mjs';
import { normalizeSelection } from '../src/core/engines.mjs';
import { compatibilityConversationId } from '../src/core/conversations.mjs';
import { lockIsHeld } from '../src/runner/lock.mjs';
import { runnerStatus } from '../src/runner/coordination.mjs';

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

const recordsOf = (value) => Object.entries(value?.engines ?? {
  [value?.adapter || 'claude']: value,
}).filter(([, record]) => record?.sessionId);

function conversationMigrationData(queue, sessions) {
  const groups = new Map();
  const add = (key, item) => groups.set(key, [...(groups.get(key) ?? []), item]);

  for (const [target, value] of Object.entries(sessions)) {
    for (const [engine, record] of recordsOf(value)) {
      const adapter = record.adapter || engine || 'claude';
      const key = record.sessionId
        ? `session:${adapter}:${record.sessionId}`
        : `target:${adapter}:${target}`;
      add(key, { type: 'session', target, engine, record });
    }
  }
  for (const job of queue) {
    const adapter = job.adapter || 'claude';
    const key = job.sessionId ? `session:${adapter}:${job.sessionId}`
      : job.target ? `target:${adapter}:${job.target}` : `job:${job.id}`;
    add(key, { type: 'job', job });
  }

  const ids = new Map();
  for (const [key, items] of groups) {
    const existing = items.map((item) => item.type === 'job'
      ? item.job.conversationId : item.record.conversationId).filter(Boolean).sort()[0];
    ids.set(key, existing || compatibilityConversationId(key));
  }
  const migratedQueue = queue.map((job) => {
    const adapter = job.adapter || 'claude';
    const key = job.sessionId ? `session:${adapter}:${job.sessionId}`
      : job.target ? `target:${adapter}:${job.target}` : `job:${job.id}`;
    return job.conversationId ? job : { ...job, conversationId: ids.get(key) };
  });
  const migratedSessions = Object.fromEntries(Object.entries(sessions).map(([target, value]) => {
    if (!value?.engines) {
      if (!value?.sessionId || value.conversationId) return [target, value];
      const adapter = value.adapter || 'claude';
      return [target, { ...value, conversationId: ids.get(`session:${adapter}:${value.sessionId}`) }];
    }
    const engines = Object.fromEntries(Object.entries(value.engines).map(([engine, record]) => {
      if (!record?.sessionId || record.conversationId) return [engine, record];
      const adapter = record.adapter || engine;
      return [engine, { ...record, conversationId: ids.get(`session:${adapter}:${record.sessionId}`) }];
    }));
    const topEngine = value.adapter || Object.keys(engines)[0];
    const top = engines[topEngine];
    return [target, { ...value, ...(top?.conversationId ? { conversationId: top.conversationId } : {}), engines }];
  }));
  const changedJobs = migratedQueue.filter((job, index) => job.conversationId !== queue[index].conversationId).length;
  const beforeRecords = Object.values(sessions).reduce((n, value) => n + recordsOf(value).length, 0);
  const afterRecords = Object.values(migratedSessions).reduce((n, value) => n + recordsOf(value).length, 0);
  if (migratedQueue.length !== queue.length || Object.keys(migratedSessions).length !== Object.keys(sessions).length
    || beforeRecords !== afterRecords) throw new Error('conversation migration validation failed: record counts changed');
  return {
    queue: migratedQueue, sessions: migratedSessions, groups: groups.size, changedJobs,
    changedSessions: [...groups.values()].flat().filter((item) => item.type === 'session' && !item.record.conversationId).length,
    counts: { jobs: queue.length, targets: Object.keys(sessions).length, sessionRecords: beforeRecords },
  };
}

export function inspectConversationMigration() {
  const data = conversationMigrationData(loadQueue(), loadSessions());
  return {
    ...data.counts, groups: data.groups, changedJobs: data.changedJobs,
    changedSessions: data.changedSessions, apply: false,
  };
}

export function applyConversationMigration() {
  if (lockIsHeld() || runnerStatus().willFire || loadQueue().some((job) => job.status === 'running')) {
    throw new Error('cannot migrate conversations while the runner or a job is active');
  }
  return withMutationLocks([DATA_FILES.queue, DATA_FILES.sessions], () => {
    const queue = loadQueue();
    if (queue.some((job) => job.status === 'running') || lockIsHeld() || runnerStatus().willFire) {
      throw new Error('cannot migrate conversations while the runner or a job is active');
    }
    const sessions = loadSessions();
    const data = conversationMigrationData(queue, sessions);
    const backup = stamp();
    if (fs.existsSync(DATA_FILES.queue)) fs.copyFileSync(DATA_FILES.queue, path.join(DATA, `queue.${backup}.bak.json`));
    if (fs.existsSync(DATA_FILES.sessions)) fs.copyFileSync(DATA_FILES.sessions, path.join(DATA, `sessions.${backup}.bak.json`));
    writeJSON(DATA_FILES.queue, data.queue);
    writeJSON(DATA_FILES.sessions, data.sessions);
    return {
      ...data.counts, groups: data.groups, changedJobs: data.changedJobs,
      changedSessions: data.changedSessions, backup, apply: true,
    };
  });
}
