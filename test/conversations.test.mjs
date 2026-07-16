import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kaip-conversations-'));
process.env.KAIP_HOME = TMP;

const {
  loadHiddenConversations, loadQueue, loadSessions, saveQueue, saveSessions,
} = await import('../src/storage/repositories.mjs');
const { DATA } = await import('../src/storage/paths.mjs');
const { addJob } = await import('../src/core/jobs.mjs');
const { hideFinishedConversations, targetsDTO } = await import('../lib/server-dto.mjs');
const { applyConversationMigration, inspectConversationMigration } = await import('../lib/migrate.mjs');

test('new jobs reuse conversation ID only within the same target and adapter lane', () => {
  saveQueue([]); saveSessions({});
  const a = addJob({ prompt: 'a', target: 'same', adapter: 'claude' });
  const b = addJob({ prompt: 'b', target: 'same', adapter: 'claude' });
  const c = addJob({ prompt: 'c', target: 'same', adapter: 'codex' });
  assert.equal(a.conversationId, b.conversationId);
  assert.notEqual(a.conversationId, c.conversationId);
});

test('legacy duplicate refs get deterministic unique aliases across targets and engines', () => {
  saveQueue([
    { id: 'a', prompt: 'a', status: 'done', adapter: 'claude', target: 'one', sessionId: 'shared', createdAt: 1 },
    { id: 'b', prompt: 'b', status: 'done', adapter: 'claude', target: 'two', sessionId: 'shared', createdAt: 2 },
    { id: 'c', prompt: 'c', status: 'done', adapter: 'codex', target: 'one', sessionId: 'shared', createdAt: 3 },
  ]);
  saveSessions({
    one: { sessionId: 'shared', adapter: 'codex', engines: {
      claude: { sessionId: 'shared', adapter: 'claude', updatedAt: 1 },
      codex: { sessionId: 'shared', adapter: 'codex', updatedAt: 3 },
    } },
    two: { sessionId: 'shared', adapter: 'claude', updatedAt: 2 },
  });
  const first = targetsDTO();
  const second = targetsDTO();
  assert.equal(new Set(first.map((row) => row.conversationId)).size, first.length);
  assert.deepEqual(first.map((row) => row.conversationId), second.map((row) => row.conversationId));
  assert.ok(first.filter((row) => row.sessionId === 'shared').length >= 3);
});

test('hide finished retains active conversations and survives a fresh store read', () => {
  saveQueue([]); saveSessions({});
  const done = addJob({ prompt: 'done', target: 'done', adapter: 'claude' });
  const pending = addJob({ prompt: 'pending', target: 'active', adapter: 'claude' });
  saveQueue(loadQueue().map((job) => job.id === done.id ? { ...job, status: 'done', finishedAt: 2 } : job));
  const result = hideFinishedConversations();
  assert.equal(result.hidden, 1);
  assert.equal(result.activeRetained, 1);
  assert.ok(loadQueue().some((job) => job.id === done.id), 'hiding does not delete jobs');
  assert.ok(loadQueue().some((job) => job.id === pending.id));
  const hidden = new Set(loadHiddenConversations().conversationIds);
  assert.ok(hidden.has(targetsDTO().find((row) => row.target === 'done').conversationId));
  assert.equal(targetsDTO().find((row) => row.target === 'active').hidden, false);
  saveQueue(loadQueue().map((job) => job.id === done.id ? { ...job, status: 'pending' } : job));
  assert.equal(targetsDTO().find((row) => row.target === 'done').hidden, false, 'active work is visible even if it was hidden before retry');
});

test('conversation migration is dry-run first, preserves unknown fields, backs up and validates counts', () => {
  saveQueue([{ id: 'legacy', adapter: 'claude', target: 'x', sessionId: 's', status: 'done', unknown: { keep: true } }]);
  saveSessions({ x: { sessionId: 's', adapter: 'claude', mystery: 7 } });
  const dry = inspectConversationMigration();
  assert.equal(dry.changedJobs, 1);
  assert.equal(loadQueue()[0].conversationId, undefined);
  const applied = applyConversationMigration();
  assert.equal(applied.jobs, 1);
  assert.equal(loadQueue()[0].unknown.keep, true);
  assert.equal(loadSessions().x.mystery, 7);
  assert.equal(loadQueue()[0].conversationId, loadSessions().x.conversationId);
  assert.ok(fs.existsSync(path.join(DATA, `queue.${applied.backup}.bak.json`)));
  assert.ok(fs.existsSync(path.join(DATA, `sessions.${applied.backup}.bak.json`)));
});

test('conversation migration refuses a running job', () => {
  saveQueue([{ id: 'running', adapter: 'claude', status: 'running' }]);
  assert.throws(() => applyConversationMigration(), /runner or a job is active/);
});
