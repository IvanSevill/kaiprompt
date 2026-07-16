// Running out of quota mid-batch is not a failure, it is an interruption. These tests pin the
// difference down: stage 4 of the overnight batch died exactly like this and was lost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_QUOTA_RETRIES, isQuotaExhausted, parseResetAt, planRetry, quotaVerdict as policyVerdict,
} from '../src/core/quota-retry.mjs';
import { readUsage, resetFromUsage, sessionQuota } from '../src/adapters/claude-quota.mjs';

const quotaVerdict = (text, { usageFile, ...options } = {}) => policyVerdict(text, {
  ...options,
  usage: readUsage(usageFile),
});

// The real message that killed last night's launch.
const REAL = "You've hit your session limit · resets 1:30pm (Europe/Madrid)\n\n[ERROR] claude exited with code 1";
const REAL_WEEKLY = "You've hit your weekly limit · resets Jul 18, 11pm (Europe/Madrid)";

// --- detection ---------------------------------------------------------------
test('it recognises the exact message that cut the overnight batch off', () => {
  assert.ok(isQuotaExhausted(REAL));
});

test('it recognises the other ways of saying it', () => {
  for (const s of [
    'You have reached your usage limit',
    'Usage limit reached',
    'you have exceeded your rate limit',
  ]) assert.ok(isQuotaExhausted(s), s);
});

test('an ORDINARY failure is not mistaken for running out of quota', () => {
  // This matters: if we mistook a crash for the quota, we would retry forever.
  for (const s of [
    'TypeError: cannot read property of undefined',
    'the tests failed: 3 passing, 2 failing',
    '[ERROR] claude exited with code 1',
    'rate limiting is implemented in this file',
    '',
    undefined,
  ]) assert.equal(isQuotaExhausted(s), false, String(s));
});

// --- when the quota comes back -----------------------------------------------
test('parseResetAt: "resets 1:30pm" with the afternoon still ahead → today at 13:30', () => {
  const now = new Date('2026-07-12T09:00:00').getTime();
  const at = new Date(parseResetAt(REAL, now));
  assert.equal(at.getHours(), 13);
  assert.equal(at.getMinutes(), 30);
  assert.equal(at.getDate(), 12);
});

test('parseResetAt: if that time has already gone today, it is tomorrow (we never wake in the past)', () => {
  const now = new Date('2026-07-12T15:00:00').getTime();
  const at = parseResetAt('resets 1:30pm', now);
  assert.ok(at > now);
  assert.equal(new Date(at).getDate(), 13);
});

test('parseResetAt: 24h format, and with no minutes', () => {
  const now = new Date('2026-07-12T05:00:00').getTime();
  assert.equal(new Date(parseResetAt('resets at 08:30', now)).getHours(), 8);
  assert.equal(new Date(parseResetAt('resets 3am', now)).getHours(), 3);
  assert.equal(new Date(parseResetAt('resets 11pm', now)).getHours(), 23);
});

test('parseResetAt: midnight and midday do not cross over (12am=0, 12pm=12)', () => {
  const now = new Date('2026-07-12T06:00:00').getTime();
  assert.equal(new Date(parseResetAt('resets 12pm', now)).getHours(), 12);
  assert.equal(new Date(parseResetAt('resets 12am', now)).getHours(), 0);
});

test('parseResetAt: no time in the text → null (we do not invent one)', () => {
  assert.equal(parseResetAt('hit your session limit', Date.now()), null);
  assert.equal(parseResetAt('resets 99:99', Date.now()), null);
});

// --- the claude-usage file ----------------------------------------------------
// The REAL shape of the file (the one the statusline writes): nested under rate_limits, and
// resets_at in epoch SECONDS, not ISO.
const usageFile = (obj) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-quota-')), 'usage.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
};
const secs = (ms) => Math.floor(ms / 1000);

test('readUsage: reads the real shape (rate_limits + epoch in seconds)', () => {
  const reset = Date.now() + 3600_000;
  const f = usageFile({
    updatedAt: secs(Date.now()),
    rate_limits: {
      five_hour: { used_percentage: 47, resets_at: secs(reset) },
      seven_day: { used_percentage: 25, resets_at: secs(reset + 86400_000) },
    },
  });
  const u = readUsage(f);
  assert.equal(u.session.usedPct, 47);
  assert.equal(u.session.freePct, 53, 'what is left, which is what gets painted');
  assert.equal(Math.abs(u.session.resetsAt - reset) < 1000, true, 'seconds → ms');
  assert.equal(u.weekly.usedPct, 25);
});

test('sessionQuota: the 5h window, which is the one that cuts a launch off', () => {
  const reset = Date.now() + 3600_000;
  const f = usageFile({ rate_limits: { five_hour: { used_percentage: 90, resets_at: secs(reset) } } });
  const q = sessionQuota(f);
  assert.equal(q.freePct, 10);
  assert.equal(q.renewed, false);
});

test('sessionQuota: past the reset the reading is spent → 100% free, "renewed"', () => {
  // rate_limits only refreshes on an API response: past the reset, the old number lies. The
  // clock knows before the file does.
  const reset = Date.now() - 60_000;
  const f = usageFile({ rate_limits: { five_hour: { used_percentage: 100, resets_at: secs(reset) } } });
  const q = sessionQuota(f);
  assert.equal(q.renewed, true);
  assert.equal(q.freePct, 100);
  assert.equal(q.usedPct, 0);
});

test('sessionQuota / readUsage: no file, or rubbish in it → null, without blowing up', () => {
  assert.equal(sessionQuota('/does/not/exist.json'), null);
  assert.equal(readUsage('/does/not/exist.json'), null);
});

test('resetFromUsage: takes whichever of the two windows expires FIRST', () => {
  const soon = Date.now() + 3600_000;
  const f = usageFile({
    rate_limits: {
      five_hour: { used_percentage: 10, resets_at: secs(soon) },
      seven_day: { used_percentage: 10, resets_at: secs(soon + 86400_000) },
    },
  });
  assert.ok(Math.abs(resetFromUsage(f) - soon) < 1000);
});

test('resetFromUsage: it ignores resets that have already passed (the file can be stale)', () => {
  const f = usageFile({ rate_limits: { five_hour: { used_percentage: 10, resets_at: secs(Date.now() - 9e6) } } });
  assert.equal(resetFromUsage(f), null);
});

test('resetFromUsage: no file, or rubbish in it → null, without blowing up', () => {
  assert.equal(resetFromUsage('/does/not/exist.json'), null);
});

// --- the verdict --------------------------------------------------------------
test('quotaVerdict: the message beats the file (it describes THIS launch)', () => {
  const now = new Date('2026-07-12T09:00:00').getTime();
  const v = quotaVerdict(REAL, { now, usageFile: '/does/not/exist.json' });
  assert.equal(v.exhausted, true);
  assert.equal(v.source, 'message');
  assert.equal(new Date(v.resetsAt).getHours(), 13);
  assert.ok(v.resetsAt > parseResetAt(REAL, now) - 1, 'with a grace margin over the reset');
});

test('quotaVerdict: no time in the message and no file → 5h ahead (never null)', () => {
  const now = Date.now();
  const v = quotaVerdict('hit your session limit', { now, usageFile: '/does/not/exist.json' });
  assert.equal(v.source, 'fallback');
  assert.ok(v.resetsAt > now);
});

test('quotaVerdict: if it was not the quota, there is nothing to wait for', () => {
  const v = quotaVerdict('TypeError: boom', { usageFile: '/does/not/exist.json' });
  assert.deepEqual(v, { exhausted: false, resetsAt: null, source: null });
});

// --- what to do with the job --------------------------------------------------
test('planRetry: cut off by the quota → back in the queue, NOT marked as an error', () => {
  const v = quotaVerdict(REAL, { usageFile: '/does/not/exist.json' });
  const plan = planRetry({ id: 'j1' }, v);
  assert.equal(plan.action, 'requeue');
  assert.equal(plan.quotaRetries, 1);
  assert.equal(plan.waitUntil, v.resetsAt);
});

test('planRetry: it does NOT touch "when" — that is what preserves the queue order', () => {
  // The job that was cut off keeps its original time, so when the quota returns it is still
  // the oldest pending one and goes first. Everything behind it stays behind it.
  const job = { id: 'j1', when: 1000, quotaRetries: 0 };
  const plan = planRetry(job, quotaVerdict(REAL, { usageFile: '/does/not/exist.json' }));
  assert.equal(job.when, 1000, 'the job is not mutated');
  assert.ok(!('when' in plan), 'the plan does not propose changing the time');
});

test('planRetry: a real failure is marked as an error (it is not retried)', () => {
  const plan = planRetry({ id: 'j1' }, quotaVerdict('TypeError: boom', { usageFile: '/does/not/exist.json' }));
  assert.equal(plan.action, 'fail');
});

test('planRetry: it gives up after several tries in a row (otherwise, an infinite loop)', () => {
  const v = quotaVerdict(REAL, { usageFile: '/does/not/exist.json' });
  const plan = planRetry({ id: 'j1', quotaRetries: MAX_QUOTA_RETRIES }, v);
  assert.equal(plan.action, 'fail');
  assert.match(plan.reason, /giving up/);
});

// --- the WEEKLY cap, not just the session one --------------------------------
// Both windows can cut a launch off. Mistaking a weekly cap for a crash would mean treating a
// stoppage of days as a failure, and losing the work.

test('it recognises the weekly cap too', () => {
  for (const s of [
    REAL_WEEKLY,
    "You've reached your weekly limit · resets Thursday at 9am",
    'You have hit your week limit',
    'weekly limit reached',
  ]) assert.ok(isQuotaExhausted(s), s);
});

test('parseResetAt: the real weekly message uses its month and day at the printed time', () => {
  const now = Date.parse('2026-07-14T12:00:00+02:00');
  assert.equal(parseResetAt(REAL_WEEKLY, now), Date.parse('2026-07-18T23:00:00+02:00'));
});

test('parseResetAt: weekly dates accept abbreviated and full month names in either order', () => {
  const now = Date.parse('2026-07-14T12:00:00+02:00');
  const expected = Date.parse('2026-07-18T23:00:00+02:00');
  for (const s of [
    'resets Jul 18, 11pm',
    'resets July 18, 11pm',
    'resets 18 Jul, 11pm',
    'resets 18 July, 11pm',
  ]) assert.equal(parseResetAt(s, now), expected, s);
});

test('quotaVerdict: the real weekly message requeues at its weekly reset', () => {
  const now = Date.parse('2026-07-14T12:00:00+02:00');
  const v = quotaVerdict(REAL_WEEKLY, { now, usageFile: '/does/not/exist.json', graceMs: 0 });
  assert.deepEqual(v, {
    exhausted: true,
    resetsAt: Date.parse('2026-07-18T23:00:00+02:00'),
    source: 'message',
    kind: 'weekly',
  });
});

test('quotaVerdict: an unparseable weekly message falls back to seven days, not five hours', () => {
  const now = Date.now();
  const v = quotaVerdict('hit your weekly limit', { now, usageFile: '/does/not/exist.json' });
  assert.equal(v.source, 'fallback');
  assert.equal(v.kind, 'weekly');
  assert.equal(v.resetsAt, now + 7 * 86400_000);
});

test('parseResetAt: a weekly reset with a weekday', () => {
  const now = new Date('2026-07-12T10:00:00').getTime();   // Sunday the 12th
  const at = new Date(parseResetAt('resets Thursday at 9am', now));
  assert.equal(at.getDay(), 4, 'Thursday');
  assert.equal(at.getHours(), 9);
  assert.ok(at.getTime() > now);
});

test('parseResetAt: a weekly reset with no time → that day at 00:00, always in the future', () => {
  const now = new Date('2026-07-12T10:00:00').getTime();
  const at = new Date(parseResetAt('resets Friday', now));
  assert.equal(at.getDay(), 5);
  assert.ok(at.getTime() > now);
});

test('parseResetAt: if the day is TODAY but the time has gone, it is next week', () => {
  const now = new Date('2026-07-12T15:00:00').getTime();   // Sunday, 15:00
  const at = new Date(parseResetAt('resets Sunday at 9am', now));
  assert.equal(at.getDay(), 0);
  assert.ok(at.getTime() - now > 6 * 86400_000, 'a week away, not in a little while');
});

test('resetFromUsage: between session and weekly, the one that expires FIRST wins', () => {
  // Which is what you were asking: the wait goes by the nearest window.
  const session = Date.now() + 2 * 3600_000;
  const weekly = Date.now() + 5 * 86400_000;
  const f = usageFile({
    rate_limits: {
      five_hour: { used_percentage: 100, resets_at: secs(session) },
      seven_day: { used_percentage: 100, resets_at: secs(weekly) },
    },
  });
  assert.ok(Math.abs(resetFromUsage(f) - session) < 1000, 'the 5h one, which comes back sooner');
});

test('resetFromUsage: if the WEEKLY one expires first (session already renewed), the weekly wins', () => {
  const weekly = Date.now() + 3 * 3600_000;
  const f = usageFile({
    rate_limits: {
      five_hour: { used_percentage: 0, resets_at: secs(Date.now() - 1000) },   // already gone
      seven_day: { used_percentage: 100, resets_at: secs(weekly) },
    },
  });
  assert.ok(Math.abs(resetFromUsage(f) - weekly) < 1000);
});

test('quotaVerdict: an active weekly cap beats a fresh session reading', () => {
  const now = Date.now();
  const weekly = now + 3 * 3600_000;
  const f = usageFile({ rate_limits: {
    five_hour: { used_percentage: 0, resets_at: secs(now + 5 * 3600_000) },
    seven_day: { used_percentage: 100, resets_at: secs(weekly) },
  } });
  const v = quotaVerdict('hit your session limit · resets 1:30pm', { now, usageFile: f, graceMs: 0 });
  assert.equal(v.kind, 'weekly');
  assert.ok(Math.abs(v.resetsAt - weekly) < 1000);
});
