import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-run-'));
process.env.KAIP_HOME = TMP;
const { nid } = await import('../src/core/identity.mjs');
const { outPath } = await import('../src/storage/paths.mjs');
const { loadQueue, loadSessions, rememberSession, saveQueue, saveSessions } = await import('../src/storage/repositories.mjs');
const { executeJob, requeue, runQueue, settle } = await import('../src/runner/index.mjs');
const { liveEvents, recordAdapterEvent } = await import('../src/events/live.mjs');

const job = (over = {}) => ({
  id: nid(), prompt: 'do something', target: null, adapter: 'mock', when: null,
  dir: null, permMode: null, status: 'pending', createdAt: Date.now(),
  sessionId: null, output: null, ...over,
});

// --- running out of quota is not a failure -----------------------------------
// The overnight batch lost its last stage right here: Claude prints "you've hit your session
// limit" and exits 1, which from the outside looks exactly like a crash. It got marked
// `error` and nobody ever picked it up again.

const LIMIT = "You've hit your session limit · resets 1:30pm (Europe/Madrid)";
const WEEKLY_LIMIT = "You've hit your weekly limit · resets Jul 18, 11pm (Europe/Madrid)";

test('settle: a launch that went fine is simply done', () => {
  assert.deepEqual(settle(job(), { ok: true }), { action: 'done' });
});

test('settle: cut off by the quota → back in the queue, NOT marked as an error', () => {
  const s = settle(job(), { ok: false, output: LIMIT, error: 'claude exited with code 1' });
  assert.equal(s.action, 'requeue');
  assert.ok(s.waitUntil > Date.now(), 'with a resume time in the future');
});

test('settle: preserves the weekly quota kind so the waiting UI identifies it', () => {
  const s = settle(job(), { ok: false, output: WEEKLY_LIMIT, error: 'claude exited with code 1' });
  assert.equal(s.action, 'requeue');
  assert.equal(s.kind, 'weekly');
});

test('settle: a REAL failure is still an error (it is not retried forever)', () => {
  const s = settle(job(), { ok: false, output: 'TypeError: boom', error: 'crashed' });
  assert.equal(s.action, 'fail');
});

test('settle: it gives up if the quota knocks it out again and again', () => {
  const s = settle(job({ quotaRetries: 3 }), { ok: false, output: LIMIT, error: 'x' });
  assert.equal(s.action, 'fail');
  assert.match(s.reason, /giving up/);
});

test('requeue: back to pending, and it does NOT touch "when" — that is what keeps the ORDER', () => {
  // What you asked for: when the quota comes back, it is still in the place it was.
  const first = job({ when: 1000 });
  const second = job({ when: 2000 });
  saveQueue([first, second]);

  const s = settle(first, { ok: false, output: LIMIT, error: 'x' });
  requeue(first, s);

  const q = loadQueue();
  const back = q.find((j) => j.id === first.id);
  assert.equal(back.status, 'pending', 'back in the queue');
  assert.equal(back.when, 1000, 'its time does NOT change');
  assert.equal(back.quotaRetries, 1);
  assert.ok(['session', 'weekly'].includes(back.quotaKind), 'an active usage window may be more limiting than the error text');
  assert.ok(back.pausedUntil > Date.now());
  assert.equal(back.finishedAt, null, 'it does not count as finished');

  // And it is still the oldest pending one: when the quota returns, it goes first again.
  const pending = q.filter((j) => j.status === 'pending').sort((a, b) => a.when - b.when);
  assert.equal(pending[0].id, first.id);
  assert.equal(pending[1].id, second.id);
});

test('requeue: keeps the weekly pause and its quota kind', () => {
  const j = job();
  saveQueue([j]);

  const s = settle(j, { ok: false, output: WEEKLY_LIMIT, error: 'x' });
  requeue(j, s);

  const back = loadQueue().find((queued) => queued.id === j.id);
  assert.equal(back.status, 'pending');
  assert.equal(back.quotaKind, 'weekly');
  assert.ok(back.pausedUntil > Date.now());
});

test('executeJob: marks it done, writes the output and saves the target session', async () => {
  const j = job({ target: 'fixes' });
  saveQueue([j]);

  const res = await executeJob(j);

  assert.equal(res.ok, true);
  assert.equal(j.status, 'done');
  assert.ok(j.finishedAt);
  assert.ok(fs.existsSync(outPath(j.id)), 'it must write out/<id>.txt');
  assert.match(fs.readFileSync(outPath(j.id), 'utf8'), /\[mock\]/);
  assert.ok(j.sessionId, 'it must capture the session id');
  assert.equal(loadSessions().fixes.sessionId, j.sessionId, 'and tie it to the target');
});

test('executeJob: resumes the session saved for the target', async () => {
  saveSessions({ resumes: { sessionId: 'earlier-session', adapter: 'mock', updatedAt: 1 } });
  const j = job({ target: 'resumes' });
  await executeJob(j);
  assert.equal(j.sessionId, 'earlier-session', 'it reuses the session, it does not create another');
});

test('executeJob: an adapter that does not exist → a controlled error', async () => {
  const j = job({ adapter: 'does-not-exist' });
  await assert.rejects(() => executeJob(j), /unknown adapter/);
});

// --- sessions.json: the lost write ---------------------------------------------
// executeJob loaded sessions.json when it STARTED and saved it when it FINISHED, with a whole
// launch in between. Anything written in that gap disappeared on the way out. And `--parallel`
// lives inside that gap by design: the lanes start together, each with the file exactly as it
// was BEFORE any of them ran, and the last one to finish wins.
//
// The real cost: the target that lost its sessionId opens a fresh conversation next time and
// pays again for the context it already had. That is precisely the saving `--target` promises.

test('sessions.json: two lanes at once do NOT wipe each other\'s session', async () => {
  saveSessions({});
  const a = job({ target: 'alpha' });
  const b = job({ target: 'beta' });
  saveQueue([a, b]);

  // This is what `kaip run --parallel 2` does: two lanes, at the same time.
  await Promise.all([executeJob(a), executeJob(b)]);

  const s = loadSessions();
  assert.ok(s.alpha?.sessionId, 'alpha saved its session');
  assert.ok(s.beta?.sessionId, 'beta too — the last one to finish used to wipe the other');
  assert.notEqual(s.alpha.sessionId, s.beta.sessionId, 'and they are different conversations');
});

test('sessions.json: what gets written DURING the launch survives', async () => {
  saveSessions({ old: { sessionId: 'was-here-already', adapter: 'mock', updatedAt: 1 } });

  const j = job({ target: 'new' });
  const running = executeJob(j);

  // Somebody else writes while the launch is in flight: another lane, the GUI, a
  // `kaip sessions set`. The launch may not take that with it when it finishes.
  rememberSession('in-between', 'written-midway', 'mock');
  await running;

  const s = loadSessions();
  assert.equal(s['in-between']?.sessionId, 'written-midway', 'the write in the middle, which used to be lost');
  assert.equal(s.old?.sessionId, 'was-here-already', 'and what was already there is still there');
  assert.ok(s.new?.sessionId, 'along with the job\'s own session');
});

test('executeJob: emits live events when onEvent is passed', async () => {
  const seen = [];
  const j = job();
  await executeJob(j, { onEvent: (e) => seen.push(e.type) });

  assert.ok(seen.includes('system'), 'the init event');
  assert.ok(seen.includes('assistant'), 'the working events');
  assert.ok(seen.includes('result'), 'the final event');
});

test('executeJob: persists live events even when no terminal renderer is attached', async () => {
  const j = job();
  const res = await executeJob(j);
  assert.equal(res.ok, true);
  assert.ok(liveEvents(j.id).some((event) => event.kind === 'text'));
});

test('the first observed session is durable with engine metadata before the adapter returns', () => {
  const j = job({
    adapter: 'opencode', target: 'durable', provider: 'openai', model: 'gpt-5', dir: TMP,
  });
  saveQueue([j]); saveSessions({});
  recordAdapterEvent(j, { type: 'system', session_id: 'ses-durable' });
  const first = loadSessions().durable;

  assert.equal(loadQueue()[0].sessionId, 'ses-durable');
  assert.deepEqual({
    adapter: first.adapter, provider: first.provider, model: first.model, dir: first.dir,
  }, { adapter: 'opencode', provider: 'openai', model: 'gpt-5', dir: TMP });
  recordAdapterEvent(j, { type: 'assistant', session_id: 'ses-durable', message: { content: [] } });
  assert.equal(loadSessions().durable.updatedAt, first.updatedAt, 'later events do not rewrite the session');
});

test('runQueue (with no TTY): processes the sequential ones in order', async () => {
  const a = job({ prompt: 'first' });
  const b = job({ prompt: 'second' });
  saveQueue([a, b]);

  await runQueue({ once: true });

  const q = loadQueue();
  assert.equal(q.length, 2);
  assert.ok(q.every((j) => j.status === 'done'), 'both must end up done');
  assert.ok(q[0].finishedAt <= q[1].finishedAt, 'and in order: the 2nd after the 1st');
});

test('runQueue parallel trace overlaps independent lanes but serializes one target', async () => {
  const first = job({ prompt: 'alpha first', target: 'alpha' });
  const second = job({ prompt: 'alpha second', target: 'alpha' });
  const independent = job({ prompt: 'beta', target: 'beta' });
  saveQueue([first, second, independent]);

  await runQueue({ once: true, parallel: 2, plain: true });

  const [alphaFirst, alphaSecond, beta] = loadQueue();
  assert.ok([alphaFirst, alphaSecond, beta].every((entry) => entry.status === 'done'));
  assert.ok(beta.startedAt < alphaFirst.finishedAt, 'the independent lane overlaps the first lane');
  assert.ok(alphaSecond.startedAt >= alphaFirst.finishedAt, 'one target never resumes twice at once');
});

test('runQueue --once: does NOT wait for jobs scheduled in the future', async () => {
  const future = job({ when: Date.now() + 3600_000 });
  saveQueue([future]);

  const t0 = Date.now();
  await runQueue({ once: true });

  assert.ok(Date.now() - t0 < 3000, 'it must come straight back, not wait an hour');
  assert.equal(loadQueue()[0].status, 'pending', 'and leave it pending');
});

test('runQueue --dry-run: runs nothing', async () => {
  const j = job();
  saveQueue([j]);
  await runQueue({ dryRun: true });
  assert.equal(loadQueue()[0].status, 'pending', 'still pending: nothing was launched');
  assert.ok(!fs.existsSync(outPath(j.id)), 'and it writes no output');
});

test('runQueue --dry-run passes OpenCode provider and model to the adapter', async () => {
  const j = job({ adapter: 'opencode', provider: 'google', model: 'gemini-2.5-flash' });
  saveQueue([j]);
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await runQueue({ dryRun: true }); } finally { console.log = original; }
  assert.match(lines.join('\n'), /-m google\/gemini-2\.5-flash/);
});

test('runQueue: an empty queue does not break it', async () => {
  saveQueue([]);
  await runQueue({ once: true });
  assert.deepEqual(loadQueue(), []);
});

// --- the lock: it stops two runners running the same job twice ----------------
test('lock: a second runner does nothing while another one is active', async () => {
  const { lockIsHeld } = await import('../src/runner/index.mjs');
  const lock = path.join(TMP, 'data', 'runner.lock');

  // A LIVE runner. This test used to fake one with pid 999999, which does not exist: the lock
  // only looked at the clock, so it got away with it. An active runner is a process that is
  // really there, and the only one this test can guarantee is there is itself.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(lockIsHeld(), true, 'live process + fresh heartbeat = there is a runner');

  const j = job();
  saveQueue([j]);
  await runQueue({ once: true });
  assert.equal(loadQueue()[0].status, 'pending', 'it must not touch the queue: another runner is up');

  fs.rmSync(lock, { force: true });
});

test('a DEAD runner\'s lock is ignored: you can launch NOW, without waiting for the heartbeat', async () => {
  // What it felt like: you close a `kaip run` and for two minutes the daemon refuses to start
  // because "somebody is already there". Nobody was — only its lock, still warm.
  const { lockIsHeld } = await import('../src/runner/index.mjs');
  const lock = path.join(TMP, 'data', 'runner.lock');

  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() }));   // a BRAND NEW heartbeat
  assert.equal(lockIsHeld(), false, 'the process does not exist: however fresh the heartbeat is');

  saveQueue([job()]);
  await runQueue({ once: true });
  assert.equal(loadQueue()[0].status, 'done', 'it must be able to run straight away');
});

test('an expired lock (live runner, but hung) is ignored too', async () => {
  // The heartbeat is still needed: it covers the runner that exists but no longer processes
  // anything.
  const { lockIsHeld } = await import('../src/runner/index.mjs');
  const lock = path.join(TMP, 'data', 'runner.lock');

  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - 10 * 60_000 }));
  assert.equal(lockIsHeld(), false, 'no heartbeat for 10 min: that runner is processing nothing');

  saveQueue([job()]);
  await runQueue({ once: true });
  assert.equal(loadQueue()[0].status, 'done', 'it must be able to run all the same');
});

test('lock: it is released on the way out', async () => {
  saveQueue([]);
  await runQueue({ once: true });
  assert.equal(fs.existsSync(path.join(TMP, 'data', 'runner.lock')), false, 'it must not be left hanging');
});

test('lock: acquisition is exclusive and release cannot delete another owner', async () => {
  const { acquireLock } = await import('../src/runner/lock.mjs');
  const lock = path.join(TMP, 'data', 'runner.lock');
  fs.rmSync(lock, { force: true });

  const release = acquireLock();
  assert.equal(typeof release, 'function');
  assert.equal(acquireLock(), null, 'exclusive creation permits only one owner');

  const replacement = { pid: process.pid, at: Date.now(), owner: 'replacement' };
  fs.writeFileSync(lock, JSON.stringify(replacement));
  release();
  assert.equal(fs.existsSync(lock), true, 'the old owner must not remove a replacement lock');
  fs.rmSync(lock, { force: true });
});

// --- jobs left hanging in "running" ------------------------------------------
test('reapStale: a job with NO runnerPid (from an older version) is closed out too', async () => {
  // Otherwise it stays "running" forever: nobody can confirm it died.
  // That is exactly what happened to the launch that was cancelled halfway.
  const { reapStale } = await import('../src/runner/index.mjs');
  const hung = job({ status: 'running', startedAt: Date.now() - 3600_000 });
  delete hung.runnerPid;
  saveQueue([hung]);

  assert.equal(reapStale(), 1);
  assert.equal(loadQueue()[0].status, 'error');
  assert.match(loadQueue()[0].error, /interrupted/);
});

test('reapStale: a job from a LIVE runner is left alone', async () => {
  const { reapStale } = await import('../src/runner/index.mjs');
  saveQueue([job({ status: 'running', runnerPid: process.pid })]);   // this process exists
  assert.equal(reapStale(), 0);
  assert.equal(loadQueue()[0].status, 'running');
});

// --- feeding a run that is already going -------------------------------------
// The real case: you leave a "run" up and, before you run out of tokens, you queue what is
// left from another terminal. It has to pick that up on its own.

test('a run in progress picks up prompts added AFTER it started', async () => {
  const { addJob } = await import('../src/core/jobs.mjs');
  saveQueue([]);
  const first = job({ prompt: 'the first one' });
  saveQueue([first]);

  // While the runner works, another process puts a new job into the queue.
  const addAnother = new Promise((r) => setTimeout(() => {
    addJob({ prompt: 'slipped in halfway', adapter: 'mock' });
    r();
  }, 50));

  await addAnother;
  await runQueue({ once: true });

  const q = loadQueue();
  assert.equal(q.length, 2);
  assert.ok(q.every((j) => j.status === 'done'), 'BOTH must run, not just the first');
  assert.ok(q.some((j) => j.prompt === 'slipped in halfway'));
});

test('--watch: an empty queue does NOT end the run; it waits and runs whatever arrives', async () => {
  // This is THE case: you leave a run up and keep feeding it work. It is spawned as a separate
  // process because --watch, deliberately, never finishes: it has to be killed.
  const { spawn } = await import('node:child_process');
  const { addJob } = await import('../src/core/jobs.mjs');
  saveQueue([]);

  const cli = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ''), '..', 'kaip.mjs');
  const run = spawn(process.execPath, [cli, 'run', '--watch', '--plain'], {
    env: { ...process.env, KAIP_HOME: TMP },
    stdio: 'ignore',
  });

  try {
    await new Promise((r) => setTimeout(r, 800));          // it starts with an EMPTY queue
    assert.equal(run.exitCode, null, 'it must not have died on seeing no work');

    addJob({ prompt: 'late arrival', adapter: 'mock' });    // and now we give it something

    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (loadQueue().some((j) => j.status === 'done')) { clearInterval(iv); resolve(); }
        else if (Date.now() - t0 > 15000) { clearInterval(iv); reject(new Error('it never picked it up')); }
      }, 200);
    });

    assert.equal(loadQueue()[0].status, 'done', 'it ran it on its own, with nothing restarted');
  } finally {
    run.kill();
  }
});
