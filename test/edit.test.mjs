import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-edit-'));
process.env.KAIP_HOME = TMP;
const { loadQueue, nid, saveProjects, saveQueue } = await import('../lib/store.mjs');
const { applyEdits, editJob } = await import('../lib/edit.mjs');

const job = (over = {}) => ({
  id: nid(), prompt: 'do something', target: null, adapter: 'mock', when: null,
  dir: 'C:/old', permMode: null, status: 'pending', createdAt: Date.now(),
  sessionId: null, output: null, ...over,
});

const only = (over) => { const j = job(over); saveQueue([j]); return j; };

// --- what can change ---------------------------------------------------------
test('edit: changes and persists the prompt', () => {
  const j = only({});
  const { changes } = editJob(j.id, { prompt: 'something else' });
  assert.deepEqual(changes, ['prompt']);
  assert.equal(loadQueue()[0].prompt, 'something else');
});

test('edit: --at reschedules (reuses parseWhen)', () => {
  const j = only({});
  const { job: n } = editJob(j.id, { at: '+2h' });
  const expected = Date.now() + 2 * 3600_000;
  assert.ok(Math.abs(n.when - expected) < 5000, 'must be within 2h');
  assert.ok(loadQueue()[0].when, 'and saved');
});

test('edit: --at none restores sequential execution', () => {
  const j = only({ when: Date.now() + 3600_000 });
  const { job: n } = editJob(j.id, { at: 'none' });
  assert.equal(n.when, null);
});

test('edit: --model changes the model of a job that has not launched yet', () => {
  const j = only({ model: 'haiku' });
  const { job: n, changes } = editJob(j.id, { model: 'opus' });
  assert.deepEqual(changes, ['model']);
  assert.equal(n.model, 'opus');
  assert.equal(loadQueue()[0].model, 'opus');
});

test('edit: --model none restores the engine default', () => {
  const j = only({ model: 'opus' });
  const { job: n } = editJob(j.id, { model: 'none' });
  assert.equal(n.model, null);
});

test('edit: --dir resolves an alias/project like add', () => {
  saveProjects({ myalias: 'C:/some/place/MyApp' });
  const j = only({});
  const { job: n } = editJob(j.id, { dir: 'myalias' });
  assert.equal(n.dir, 'C:/some/place/MyApp');
});

test('edit: several flags at once', () => {
  const j = only({});
  const { job: n, changes } = editJob(j.id, { target: 'fixes', perm: 'acceptEdits', adapter: 'claude' });
  assert.equal(n.target, 'fixes');
  assert.equal(n.permMode, 'acceptEdits');
  assert.equal(n.adapter, 'claude');
  assert.equal(changes.length, 3);
});

test('edit: --target none removes the target', () => {
  const j = only({ target: 'fixes' });
  assert.equal(editJob(j.id, { target: 'none' }).job.target, null);
});

test('edit: does not touch what was not requested', () => {
  const j = only({ target: 'fixes', when: 123, permMode: 'acceptEdits' });
  const { job: n } = editJob(j.id, { prompt: 'new' });
  assert.equal(n.target, 'fixes');
  assert.equal(n.when, 123);
  assert.equal(n.permMode, 'acceptEdits');
  assert.equal(n.id, j.id, 'and the id stays the same');
});

test('edit: edits only that job, leaving the rest of the queue intact', () => {
  const a = job(), b = job();
  saveQueue([a, b]);
  editJob(b.id, { prompt: 'changed' });
  const q = loadQueue();
  assert.equal(q.length, 2);
  assert.equal(q.find((x) => x.id === a.id).prompt, 'do something');
  assert.equal(q.find((x) => x.id === b.id).prompt, 'changed');
});

// --- what must be rejected ---------------------------------------------------
test('edit: a done job is NOT edited (rewriting the past corrupts the queue)', () => {
  const j = only({ status: 'done' });
  assert.throws(() => editJob(j.id, { prompt: 'x' }), /is done: only pending/);
  assert.equal(loadQueue()[0].prompt, 'do something', 'nothing changed');
});

test('edit: neither is a running job (it is already in the adapter\'s hands)', () => {
  const j = only({ status: 'running' });
  assert.throws(() => editJob(j.id, { prompt: 'x' }), /is running: only pending/);
});

test('edit: missing id -> clear error', () => {
  saveQueue([]);
  assert.throws(() => editJob('nope', { prompt: 'x' }), /no job found/);
});

test('edit: without flags -> says what can change', () => {
  const j = only({});
  assert.throws(() => editJob(j.id, {}), /nothing to change/);
});

test('edit: missing adapter -> error (otherwise the job would fail on launch)', () => {
  const j = only({});
  assert.throws(() => editJob(j.id, { adapter: 'no-existe' }), /unknown adapter/);
  assert.equal(loadQueue()[0].adapter, 'mock', 'and the queue stays healthy');
});

test('edit: --perm accepts only known modes', () => {
  const j = only({});
  assert.throws(() => editJob(j.id, { perm: 'anything-goes' }), /unknown --perm/);
});

test('edit: --at with an unparseable time -> parseWhen error', () => {
  const j = only({});
  assert.throws(() => editJob(j.id, { at: 'whenever' }), /can't parse time/);
});

test('edit: a flag without a value does not silently delete', () => {
  const j = only({ target: 'fixes' });
  assert.throws(() => editJob(j.id, { target: true }), /--target needs a value/);
  assert.equal(loadQueue()[0].target, 'fixes');
});

test('edit: an empty prompt is rejected', () => {
  const j = only({});
  assert.throws(() => editJob(j.id, { prompt: '   ' }), /--prompt cannot be empty/);
});

// --- applyEdits (pure) -------------------------------------------------------
test('applyEdits: does not mutate the original job', () => {
  const j = job({ prompt: 'original' });
  const { job: n } = applyEdits(j, { prompt: 'copy' });
  assert.equal(j.prompt, 'original');
  assert.equal(n.prompt, 'copy');
});
