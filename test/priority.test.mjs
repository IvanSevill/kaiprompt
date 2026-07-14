import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-prio-'));
process.env.KAIP_HOME = TMP;

const { nid, saveQueue } = await import('../lib/store.mjs');
const { isPriority, nextUp, reapMissed, startable } = await import('../lib/schedule.mjs');
const { addJob } = await import('../lib/queue.mjs');

const T = Date.UTC(2026, 6, 13, 12, 0, 0);
const MIN = 60_000;

const job = (over = {}) => ({
  id: nid(), prompt: 'do something', target: null, adapter: 'mock', when: null,
  dir: null, permMode: null, status: 'pending', createdAt: T,
  sessionId: null, output: null, ...over,
});

// --- priority: jump the queue WITHOUT moving anybody's time ---------------------
// The queue order is preserved precisely by NOT touching `when` (that is what `requeue`
// protects). So "put it first" cannot be done by faking the time: it has to be a field of its
// own, and that is what is tested here.

test('a priority job goes out BEFORE one that is scheduled and already due', () => {
  const due = job({ id: 'scheduled', when: T - 5 * MIN });      // due: it was up 5 min ago
  const prio = job({ id: 'first', when: null, priority: true });

  const { job: picked } = nextUp([due, prio], T);
  assert.equal(picked.id, 'first');
});

test('…and BEFORE one scheduled for right now, even if it was added later', () => {
  const due = job({ id: 'scheduled', when: T, createdAt: T - 60 * MIN });
  const prio = job({ id: 'first', priority: true, createdAt: T });   // added last

  assert.equal(nextUp([due, prio], T).job.id, 'first');
  assert.equal(nextUp([prio, due], T).job.id, 'first', 'and the order in the array makes no difference');
});

test('priority does NOT alter anybody\'s `when`', () => {
  const due = job({ id: 'scheduled', when: T + 30 * MIN });
  const other = job({ id: 'other', when: T + 60 * MIN });
  const prio = job({ id: 'first', priority: true });
  const before = [due, other, prio].map((j) => j.when);

  nextUp([due, other, prio], T);
  startable([due, other, prio], [], 3, T);

  assert.deepEqual([due, other, prio].map((j) => j.when), before, 'not one time moved');
  assert.equal(prio.when, null, 'and the priority one still has no time: it goes when there is quota');
});

test('several priority jobs: the oldest first (they do not jump each other)', () => {
  const a = job({ id: 'a', priority: true, createdAt: T - 10 * MIN });
  const b = job({ id: 'b', priority: true, createdAt: T - 2 * MIN });
  assert.equal(nextUp([b, a], T).job.id, 'a');
  assert.deepEqual(startable([b, a], [], 9, T).map((j) => j.id), ['a', 'b']);
});

test('one scheduled for the FUTURE still waits its turn, priority or not', () => {
  const future = job({ id: 'future', when: T + 60 * MIN });
  assert.equal(nextUp([future], T).job, undefined);

  const prio = job({ id: 'first', priority: true });
  assert.equal(nextUp([future, prio], T).job.id, 'first');
  assert.deepEqual(startable([future, prio], [], 9, T).map((j) => j.id), ['first']);
});

test('the full order: priority → due → sequential', () => {
  const seq = job({ id: 'seq' });
  const due = job({ id: 'due', when: T - MIN });
  const prio = job({ id: 'prio', priority: true });
  assert.deepEqual(
    startable([seq, due, prio], [], 9, T).map((j) => j.id),
    ['prio', 'due', 'seq'],
  );
});

test('quota-paused jobs remain ineligible in every scheduling mode until reset', () => {
  const paused = [
    job({ id: 'prio', priority: true, pausedUntil: T + MIN }),
    job({ id: 'due', when: T - MIN, pausedUntil: T + MIN }),
    job({ id: 'seq', pausedUntil: T + MIN }),
  ];

  assert.equal(nextUp(paused, T).job, undefined);
  assert.equal(nextUp(paused, T, { scheduledOnly: true }).job, undefined);
  assert.deepEqual(startable(paused, [], 3, T), []);
  assert.deepEqual(startable(paused, [], 3, T + MIN).map((j) => j.id), ['prio', 'due', 'seq']);
});

// --- the daemon ---------------------------------------------------------------
test('the daemon DOES take a priority job, even with no time on it', () => {
  // A sequential job waits for a run by hand: if the daemon took them, adding one would fire
  // it seconds later. A priority job is not that: somebody looked at ONE half-finished
  // conversation and said "yes, finish it as soon as the quota is back". That answer IS the
  // order to launch with nobody watching — and a daemon that ignored it would leave the offer
  // accepted and nothing ever running.
  const seq = job({ id: 'seq' });
  const prio = job({ id: 'prio', priority: true });

  const { job: picked } = nextUp([seq, prio], T, { scheduledOnly: true });
  assert.equal(picked.id, 'prio');

  // …but the sequential one still waits for its `run`. That does not change.
  assert.equal(nextUp([seq], T, { scheduledOnly: true }).job, undefined);
});

test('a priority job never expires as "missed" (it has no time to miss)', () => {
  saveQueue([job({ id: 'prio', priority: true, createdAt: T - 40 * 60 * 60 * 1000 })]);
  assert.equal(reapMissed(), 0, 'with no `when` there is no time to lose');
});

// --- the field ----------------------------------------------------------------
test('addJob accepts priority, and does NOT set it by default', () => {
  const normal = addJob({ prompt: 'x', dir: TMP });
  assert.equal(normal.priority, undefined, 'an ordinary job does not carry the field');
  assert.equal(isPriority(normal), false);

  const first = addJob({ prompt: 'x', dir: TMP, priority: true });
  assert.equal(first.priority, true);
  assert.equal(isPriority(first), true);
  assert.equal(first.when, null);
});
