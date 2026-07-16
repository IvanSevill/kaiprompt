// The daemon: what makes "at 9" mean at 9, even with nothing open.
//
// Two things have to be proved here, and they are the two that used to fail:
//   1. a scheduled launch fires ON ITS OWN, with no GUI and nobody pressing run;
//   2. scheduling is not launching: a job with no time sits still, however many daemons
//      are up.
//
// It is proved for real: the process is started, the mock adapter is used (it costs no
// credits) and we wait to see the result land on disk.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'kaip.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-daemon-'));
const DATA = path.join(TMP, 'data');
const QUEUE = path.join(DATA, 'queue.json');

// Real daemons do get started here (that is the thing under test), but always in a temporary
// HOME and always stopped in the after: nothing survives the test.
const ENV = { ...process.env, KAIP_HOME: TMP, KAIP_NO_DAEMON: '' };
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: ENV, encoding: 'utf8' });

process.env.KAIP_HOME = TMP;            // whatever we import here looks at the same temp HOME
const { isDaemonCmd, parsePosixProcs, parseWinProcs, unaccounted } = await import('../src/runner/daemon.mjs');

const queue = () => JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const job = (id) => queue().find((j) => j.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for something to come true, or give up: a test may not hang forever. */
async function until(cond, ms = 20_000, step = 250) {
  const limit = Date.now() + ms;
  while (Date.now() < limit) {
    if (cond()) return true;
    await sleep(step);
  }
  return false;
}

/** Write the queue by hand: that way the test owns the exact time, parser not involved. */
function seed(jobs) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(QUEUE, JSON.stringify(jobs, null, 2));
}

const mockJob = (over = {}) => ({
  id: 'test' + Math.random().toString(36).slice(2, 7),
  prompt: 'hello', target: null, adapter: 'mock', when: null, dir: null,
  permMode: null, status: 'pending', createdAt: Date.now(), sessionId: null, output: null,
  ...over,
});

after(() => {
  cli('daemon', 'stop');                                  // never leave processes lying around
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows sometimes complains */ }
});

before(() => { cli('daemon', 'stop'); });

test('it starts, reports itself alive, and stops', () => {
  const start = cli('daemon', 'start');
  assert.match(start.stdout, /daemon started \(pid \d+\)/);

  const st = cli('daemon', 'status');
  assert.match(st.stdout, /daemon: on \(pid \d+\)/);

  const again = cli('daemon', 'start');
  assert.match(again.stdout, /daemon: on/, 'starting it twice does not create a second daemon');

  const stop = cli('daemon', 'stop');
  assert.match(stop.stdout, /daemon stopped/);
  assert.match(cli('daemon', 'status').stdout, /daemon: off/);
});

const daemonLog = () => {
  try { return fs.readFileSync(path.join(DATA, 'daemon.log'), 'utf8'); } catch { return '(no log)'; }
};

test('a SCHEDULED job fires on its own: no GUI, no run, nobody watching', async () => {
  const j = mockJob({ when: Date.now() + 2000, prompt: 'scheduled launch' });
  seed([j]);

  const start = cli('daemon', 'start');                   // this is everything the user does
  const fired = await until(() => job(j.id)?.status === 'done');
  cli('daemon', 'stop');

  assert.ok(fired, `the daemon had to launch it when its time came.\n`
    + `start: ${start.stdout}${start.stderr}\nlog:\n${daemonLog()}\nqueue: ${JSON.stringify(queue(), null, 2)}`);
  const done = job(j.id);
  assert.equal(done.status, 'done');
  assert.ok(done.output, 'and leave its output in out/');
  assert.ok(fs.existsSync(path.join(TMP, done.output)));
});

test('the daemon does not touch a job with NO time: scheduling is not launching', async () => {
  const j = mockJob({ prompt: 'sequential, must not go out by itself' });
  seed([j]);

  cli('daemon', 'start');
  await sleep(3000);                                      // plenty of time to get it wrong
  const st = job(j.id).status;
  cli('daemon', 'stop');

  assert.equal(st, 'pending', 'a sequential job only goes out on a manual run');
});

test('but a manual run does take it (that is what it is for)', async () => {
  const j = mockJob({ prompt: 'sequential' });
  seed([j]);

  const r = cli('run', '--once');
  assert.equal(job(j.id).status, 'done', r.stdout + r.stderr);
});

test('--seq: ask for it explicitly and the daemon drains the sequential ones too', async () => {
  const j = mockJob({ prompt: 'sequential with --seq' });
  seed([j]);

  cli('daemon', 'start', '--seq');
  const fired = await until(() => job(j.id).status === 'done', 15_000);
  cli('daemon', 'stop');

  assert.ok(fired, 'with --seq it does go in');
});

test('a job left hanging in "running" by a dead runner is closed out as an error', () => {
  seed([mockJob({ status: 'running', runnerPid: 999_999, startedAt: Date.now() - 60_000 })]);

  cli('run', '--once');                                   // any start-up does the cleanup

  const j = queue()[0];
  assert.equal(j.status, 'error');
  assert.match(j.error, /interrupted/i);
});

// The bug that started all this: a misread time (an ISO in UTC read as local) landed in the
// past, and "past" means "overdue" → it fired on the spot. Two doors shut: the parser no
// longer accepts an absolute time in the past, and the runner does not revive the very
// overdue.
test('an absolute time in the past is refused at queue time (it does not fire on the spot)', () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19);
  const r = cli('add', 'should not go out', '--at', yesterday, '--adapter', 'mock');

  assert.notEqual(r.status, 0, 'it has to fail, not queue');
  assert.match(r.stderr + r.stdout, /in the past/i);
  assert.match(r.stderr + r.stdout, /UTC/, 'and explain the Z trap, which is the real cause');
});

test('a launch that is too overdue is marked "missed" rather than fired', async () => {
  const old = mockJob({ when: Date.now() - 48 * 3600 * 1000, prompt: 'from two days ago' });
  const fine = mockJob({ when: Date.now() - 60_000, prompt: 'from a minute ago' });
  seed([old, fine]);

  cli('run', '--once');

  assert.equal(job(old.id).status, 'missed', 'the two-day-old one does NOT come back to life');
  assert.match(job(old.id).error, /missed/i);
  assert.equal(job(fine.id).status, 'done', 'but an ordinary delay is picked back up');
});

test('a "missed" job is recovered by rescheduling it (it goes back to pending)', () => {
  const j = mockJob({ when: Date.now() - 48 * 3600 * 1000 });
  seed([j]);
  cli('run', '--once');
  assert.equal(job(j.id).status, 'missed');

  const r = cli('edit', j.id, '--at', '+2h');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(job(j.id).status, 'pending', 'rescheduling puts it back in the queue');
});

test('a manual "run" TAKES the turn off the daemon, and hands it back on the way out', () => {
  // In front of the terminal, the person is in charge. Before, the daemon held the lock and
  // typing "run" got you "another runner is already active" with nothing visibly running.
  seed([mockJob({ when: Date.now() + 60_000 })]);         // pending but not due
  cli('daemon', 'start');

  const manual = cli('run', '--once');
  assert.match(manual.stdout, /took over from the daemon/i);
  assert.doesNotMatch(manual.stdout, /another runner is already active/i);

  const back = cli('daemon', 'status');
  assert.match(back.stdout, /daemon: on/i, 'and the daemon comes back on its own');
  cli('daemon', 'stop');
});

// --- one daemon. ONE. ----------------------------------------------------------
// There is ONE daemon, machine-wide, and a "kaip run" is the SAME role: draining the queue.
// Which is why there is a lock. What the tool used to do was spawn a daemon on every `add`,
// which hit the lock and died in silence half a second later — but not before writing its pid
// and announcing "daemon started, it will fire on time". A doomed process and a lie, once per
// add.

/** A live lock, taken by somebody who is not the daemon: exactly a `kaip run`. */
function fakeRun() {
  const lock = path.join(DATA, 'runner.lock');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  fs.rmSync(path.join(DATA, 'daemon.json'), { force: true });
  return () => fs.rmSync(lock, { force: true });
}

const daemonState = () => path.join(DATA, 'daemon.json');

test('with a live "run", "daemon start" spawns NOTHING — and says so', () => {
  seed([mockJob({ when: Date.now() + 60_000 })]);
  const release = fakeRun();

  const r = cli('daemon', 'start');
  release();

  assert.doesNotMatch(r.stdout, /daemon started \(pid \d+\)/i, 'it cannot announce a pid it never started');
  assert.match(r.stdout, /already draining the queue/i, 'it has to say who is draining the queue');
  assert.equal(fs.existsSync(daemonState()), false, 'and it does not even leave the pid written down');
});

test('an "add" with a time and a live "run": no daemon is born, and the message is true', () => {
  seed([]);
  const release = fakeRun();

  const r = cli('add', 'with a run already up', '--at', '+2h', '--adapter', 'mock');
  release();

  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(daemonState()), false, 'no doomed daemons, one per add');
  assert.match(r.stdout, /processing the queue/i, 'it says who is really going to launch it');
  assert.doesNotMatch(r.stdout, /daemon started/i, 'and does not boast about one that does not exist');
  assert.match(r.stdout, /close that window/i, 'with the small print: a run dies with its window');
});

test('"daemon status" does not swear nothing will fire while a "run" is firing it', () => {
  seed([mockJob({ when: Date.now() + 60_000 })]);
  const release = fakeRun();

  const r = cli('daemon', 'status');
  release();

  assert.match(r.stdout, /draining the queue/i);
  assert.doesNotMatch(r.stdout, /will NOT fire/i, 'because it is going to fire');
});

// --- zombies -------------------------------------------------------------------
// An orphan daemon is invisible: it is born hidden and writes to a log. The only way to know
// it is there is to count the processes and compare them with the pid we claim to have.
test('a daemon is recognised by its command line, and nothing else looks like it', () => {
  assert.ok(isDaemonCmd('node C:\\kaip\\kaip.mjs daemon run'));
  assert.ok(isDaemonCmd('node "C:\\path with spaces\\kaip.mjs" daemon run --seq'));
  assert.equal(isDaemonCmd('node C:\\kaip\\kaip.mjs run'), false, 'a manual "run" is NOT the daemon');
  assert.equal(isDaemonCmd('node server.mjs'), false);
  assert.equal(isDaemonCmd(null), false);
});

test('processes that are not the pid in daemon.json are orphans', () => {
  const procs = [{ pid: 111, cmd: 'x' }, { pid: 222, cmd: 'x' }, { pid: process.pid, cmd: 'x' }];

  assert.deepEqual(unaccounted(procs, 111).map((p) => p.pid), [222],
    'the daemon we do know about is not an orphan, and neither are we');
  assert.deepEqual(unaccounted(procs, null).map((p) => p.pid), [111, 222],
    'with no daemon on record, both are surplus');
});

test('the process list reads the same whether it comes from PowerShell or from ps', () => {
  const win = parseWinProcs('{"ProcessId":42,"CommandLine":"node kaip.mjs daemon run"}');
  assert.deepEqual(win, [{ pid: 42, cmd: 'node kaip.mjs daemon run' }],
    'a single process comes back as an object, not a list');

  assert.equal(parseWinProcs('[{"ProcessId":1,"CommandLine":"a"},{"ProcessId":2}]').length, 2);
  assert.deepEqual(parseWinProcs('not json'), [], 'and broken output does not blow up the status');

  assert.deepEqual(parsePosixProcs(' 42 node kaip.mjs daemon run\n  7 something else\n'), [
    { pid: 42, cmd: 'node kaip.mjs daemon run' },
    { pid: 7, cmd: 'something else' },
  ]);
});

test('two MANUAL runners do respect each other: the second one stands down', () => {
  // The lock still does its job where it matters: nobody can launch the same job twice. What
  // it no longer blocks is the human in front of the daemon.
  seed([mockJob({ when: Date.now() + 60_000 })]);
  const lock = path.join(TMP, 'data', 'runner.lock');
  // A genuinely live runner. This very process will do: the `run` we start below is ANOTHER
  // one (a child), so it sees a lock from a pid that exists and is not its own — which is
  // exactly the case. Faking it with pid 999999 stopped working when the lock started
  // checking whether the process is really there.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));

  const second = cli('run', '--once');
  fs.rmSync(lock, { force: true });

  assert.match(second.stdout, /another runner is already active/i);
});
