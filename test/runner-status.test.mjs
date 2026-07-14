// "Will anything actually fire?" — the question the tool used to get WRONG.
//
// Everything (the GUI banner, the goodbye screen, the phone app, what "add" prints) was
// answering a different question: "is the daemon on?". They are not the same. A "kaip run"
// left open in a terminal processes the queue exactly like the daemon does. But every screen
// told you, in red, that nothing was going to fire — while it was firing.
//
// That is worse than a useless message: it is the tool lying about its own state while doing
// the right thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rst-'));
process.env.KAIP_HOME = TMP;

const { runnerLine, runnerStatus } = await import('../lib/runner-status.mjs');

const LOCK = path.join(TMP, 'data', 'runner.lock');
const takeLock = (pid) => {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid, at: Date.now() }));
};
const dropLock = () => fs.rmSync(LOCK, { force: true });

test('with nobody there: scheduled work will NOT fire, and it says so', () => {
  dropLock();
  const st = runnerStatus();
  assert.equal(st.willFire, false);
  assert.equal(st.kind, null);

  const line = runnerLine(st);
  assert.equal(line.ok, false);
  assert.match(line.text, /will NOT fire/i);
  assert.match(line.hint, /kaip daemon start/);
});

test('a live "run" DOES fire scheduled work (this was the lie)', () => {
  // The lock is held by a live process that is not the daemon: it is someone with a run open.
  takeLock(process.pid);
  const st = runnerStatus();

  assert.equal(st.willFire, true, 'a run processes the queue just like the daemon');
  assert.equal(st.kind, 'run');
  assert.equal(st.pid, process.pid);

  const line = runnerLine(st);
  assert.equal(line.ok, true);
  assert.match(line.text, /run/i);
  dropLock();
});

test('but a "run" does NOT survive closing its window, and that has to be said', () => {
  // It is the difference that really matters when you are about to close something.
  takeLock(process.pid);
  const st = runnerStatus();

  assert.equal(st.durable, false, 'a run dies with its terminal');
  assert.match(runnerLine(st).hint, /close|daemon start/i);
  dropLock();
});

test('an EXPIRED lock does not count: that runner died', () => {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: Date.now() - 10 * 60_000 }));

  assert.equal(runnerStatus().willFire, false);
  dropLock();
});
