import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-queue-'));
process.env.KAIP_HOME = TMP;
const { loadQueue, loadSessions, saveProjects, saveQueue, saveSessions } = await import('../lib/store.mjs');
const {
  addJob, clearFinished, jobDetails, removeJobs, suggestDirs, suggestTargets,
} = await import('../lib/queue.mjs');

// --- suggested conversations --------------------------------------------------
// Reusing a target is the biggest token saving in the tool: the launch picks up a session that
// ALREADY has the context loaded. Which is why the wizard offers them instead of making you
// remember the name.

test('suggestTargets: offers the sessions that already exist, most recent first', () => {
  saveQueue([]);
  saveSessions({
    old: { sessionId: 's-old', adapter: 'claude', updatedAt: 1000 },
    recent: { sessionId: 's-recent', adapter: 'claude', updatedAt: 9000 },
  });

  const s = suggestTargets();
  assert.deepEqual(s.map((x) => x.target), ['recent', 'old']);
  assert.equal(s[0].sessionId, 's-recent');
  assert.equal(s[0].upcoming, false);
});

test('suggestTargets: includes targets that have not run yet, marked "upcoming"', () => {
  // Chaining work onto a launch that has not gone out yet is a real case.
  saveSessions({});
  saveQueue([{
    id: 'j1', target: 'tomorrow', prompt: 'x', status: 'pending',
    createdAt: 5000, sessionId: null, adapter: 'claude',
  }]);

  const [s] = suggestTargets();
  assert.equal(s.target, 'tomorrow');
  assert.equal(s.upcoming, true, 'it has no session yet');
  assert.equal(s.jobs, 1);
});

test('suggestTargets: a target with a session AND jobs appears once, not twice', () => {
  saveSessions({ fixes: { sessionId: 's-fixes', adapter: 'claude', updatedAt: 1000 } });
  saveQueue([
    { id: 'j1', target: 'fixes', status: 'done', createdAt: 2000, finishedAt: 3000, sessionId: 's-fixes', adapter: 'claude', prompt: 'a' },
    { id: 'j2', target: 'fixes', status: 'pending', createdAt: 4000, sessionId: null, adapter: 'claude', prompt: 'b' },
  ]);

  const s = suggestTargets();
  assert.equal(s.length, 1);
  assert.equal(s[0].jobs, 2);
  assert.equal(s[0].sessionId, 's-fixes');
  assert.equal(s[0].upcoming, false);
});

test('suggestTargets: with nothing there, an empty list (it does not blow up)', () => {
  saveSessions({}); saveQueue([]);
  assert.deepEqual(suggestTargets(), []);
});

test('suggestDirs: merges the project aliases and the folders already used, without repeats', () => {
  saveProjects({ _base: 'C:/base', myapp: 'C:/base/MyApp' });
  saveQueue([
    { id: 'j1', dir: 'C:/base/MyApp', status: 'done', createdAt: 5000, adapter: 'claude', prompt: 'a' },
    { id: 'j2', dir: 'C:/other', status: 'done', createdAt: 9000, adapter: 'claude', prompt: 'b' },
  ]);

  const dirs = suggestDirs();
  assert.equal(dirs.filter((d) => d.dir === 'C:/base/MyApp').length, 1, 'no duplicates');
  assert.equal(dirs[0].dir, 'C:/other', 'the most recent one first');
  assert.equal(dirs.find((d) => d.dir === 'C:/base/MyApp').label, 'myapp', 'it keeps the alias');
});

test('addJob: creates a pending job and puts it in the queue', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'do something', adapter: 'mock' });

  assert.equal(j.status, 'pending');
  assert.equal(j.prompt, 'do something');
  assert.equal(j.when, null, 'with no --at it is sequential');
  assert.ok(j.createdAt);
  assert.deepEqual(loadQueue().map((x) => x.id), [j.id], 'and it is saved');
});

test('addJob: --at goes through parseWhen and --dir through resolveDir (as in the CLI)', () => {
  saveQueue([]);
  saveProjects({ myalias: 'C:/some/where/MyApp' });
  const j = addJob({ prompt: 'x', at: '+2h', dir: 'myalias' });

  assert.ok(Math.abs(j.when - (Date.now() + 2 * 3600_000)) < 5000);
  assert.equal(j.dir, 'C:/some/where/MyApp');
});

test('addJob: with no --dir it falls back to the current folder', () => {
  const j = addJob({ prompt: 'x', cwd: 'C:/where/i/am' });
  assert.equal(j.dir, 'C:/where/i/am');
});

test('addJob: an empty prompt is refused (a job with no prompt launches nothing)', () => {
  assert.throws(() => addJob({ prompt: '   ' }), /missing prompt/);
});

test('addJob: with session + target, the target points at that session', () => {
  saveQueue([]);
  addJob({ prompt: 'x', target: 'fixes', session: 'session-123', adapter: 'mock' });
  assert.equal(loadSessions().fixes.sessionId, 'session-123');
});

test('addJob: a time it cannot make sense of → a parseWhen error, and the queue untouched', () => {
  saveQueue([]);
  assert.throws(() => addJob({ prompt: 'x', at: 'whenever' }), /can't parse time/);
  assert.equal(loadQueue().length, 0);
});

// --- the model is SAVED on the job --------------------------------------------
// This is where it fell over: the CLI parsed --model, validated it and passed it to addJob,
// which did not store it. The job went out with no model and the launch used the default.
// Accepting a flag and doing nothing with it is worse than not having it: you believe you
// chose.

test('addJob: it stores the chosen model', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x', model: 'sonnet', adapter: 'mock' });
  assert.equal(j.model, 'sonnet');
  assert.equal(loadQueue()[0].model, 'sonnet', 'and it survives the disk');
});

test('addJob: with no --model the job pins none (the engine default wins)', () => {
  saveQueue([]);
  assert.equal(addJob({ prompt: 'x', adapter: 'mock' }).model, null);
});

test('addJob: an empty --model is refused, not swallowed in silence', () => {
  saveQueue([]);
  assert.throws(() => addJob({ prompt: 'x', model: '  ' }), /model cannot be empty/);
  assert.equal(loadQueue().length, 0);
});

test('removeJobs: removes the ones asked for and returns how many', () => {
  saveQueue([]);
  const a = addJob({ prompt: 'a' }), b = addJob({ prompt: 'b' }), cc = addJob({ prompt: 'c' });
  assert.equal(removeJobs([a.id, cc.id]), 2);
  assert.deepEqual(loadQueue().map((j) => j.id), [b.id]);
});

test('removeJobs: an id that does not exist deletes nothing', () => {
  saveQueue([]);
  addJob({ prompt: 'a' });
  assert.equal(removeJobs(['nope']), 0);
  assert.equal(loadQueue().length, 1);
});

test('clearFinished: takes done/error and leaves pending/running alone', () => {
  saveQueue([]);
  const keep = addJob({ prompt: 'pending' });
  const run = addJob({ prompt: 'running' });
  const old = addJob({ prompt: 'finished' });
  saveQueue(loadQueue().map((j) => {
    if (j.id === run.id) return { ...j, status: 'running' };
    if (j.id === old.id) return { ...j, status: 'done' };
    return j;
  }));

  assert.equal(clearFinished(), 1);
  const ids = loadQueue().map((j) => j.id);
  assert.ok(ids.includes(keep.id) && ids.includes(run.id));
  assert.ok(!ids.includes(old.id));
});

test('jobDetails: shows what matters about the job', () => {
  const j = addJob({ prompt: 'review the PR', target: 'review', perm: 'acceptEdits', adapter: 'mock' });
  const out = jobDetails(j);
  assert.match(out, new RegExp(j.id));
  assert.match(out, /status:\s+pending/);
  assert.match(out, /target:\s+review/);
  assert.match(out, /perm:\s+acceptEdits/);
  assert.match(out, /review the PR/);
});

test('jobDetails: with no target/session it does not break (it paints —)', () => {
  const out = jobDetails(addJob({ prompt: 'x' }));
  assert.match(out, /target:\s+—/);
  assert.match(out, /perm:\s+bypass/, 'with no permMode, bypass');
});
