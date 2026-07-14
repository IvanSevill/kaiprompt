import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ago, hhmmss, humanDur, parseWhen } from '../lib/time.mjs';

test('parseWhen: no value → null (a sequential job)', () => {
  assert.equal(parseWhen(null), null);
  assert.equal(parseWhen(''), null);
});

test('parseWhen: relative +Nm/+Nh/+Nd', () => {
  const t0 = Date.now();
  assert.ok(Math.abs(parseWhen('+30m') - (t0 + 30 * 60000)) < 2000);
  assert.ok(Math.abs(parseWhen('+2h') - (t0 + 2 * 3600000)) < 2000);
  assert.ok(Math.abs(parseWhen('+1d') - (t0 + 86400000)) < 2000);
});

test('parseWhen: an HH:MM already gone today → tomorrow (never in the past)', () => {
  const when = parseWhen('00:01');
  assert.ok(when > Date.now(), 'it must always land in the future');
  assert.ok(when - Date.now() <= 86400000 + 60000);
});

test('parseWhen: an HH:MM still to come → today', () => {
  const d = new Date(Date.now() + 3600000);     // in 1h
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const when = new Date(parseWhen(hhmm));
  assert.equal(when.getDate(), d.getDate());
  assert.equal(when.getHours(), d.getHours());
});

// The Spanish forms are INPUT this still accepts, not text anyone is shown. Dropping them
// would quietly break every "--at 'mañana 09:00'" already out there, so they stay tested.
test('parseWhen: "mañana 09:00" and "tomorrow 09:00" both parse', () => {
  for (const s of ['mañana 09:00', 'tomorrow 09:00']) {
    const d = new Date(parseWhen(s));
    assert.equal(d.getHours(), 9);
    assert.equal(d.getMinutes(), 0);
    assert.ok(d.getTime() > Date.now());
  }
});

test('parseWhen: a weekday (lun/mon) lands on that day, and in the future', () => {
  for (const s of ['lun 08:30', 'mon 08:30']) {
    const d = new Date(parseWhen(s));
    assert.equal(d.getDay(), 1);
    assert.equal(d.getHours(), 8);
    assert.ok(d.getTime() > Date.now());
  }
});

test('parseWhen: ISO', () => {
  const d = new Date(parseWhen('2030-01-02T10:15'));
  assert.equal(d.getFullYear(), 2030);
  assert.equal(d.getMonth(), 0);
});

test('parseWhen: rubbish → a clear error', () => {
  assert.throws(() => parseWhen('whenever'), /can't parse time/);
});

test('hhmmss: formats, and never goes negative', () => {
  assert.equal(hhmmss(0), '00:00:00');
  assert.equal(hhmmss(3661_000), '01:01:01');
  assert.equal(hhmmss(-5000), '00:00:00');       // in the past → clamped to zero
  assert.equal(hhmmss(90_000_000), '25:00:00');  // >24h: the hours do not wrap
});

test('humanDur: compact, by magnitude', () => {
  assert.equal(humanDur(45_000), '45s');
  assert.equal(humanDur(125_000), '2m 5s');
  assert.equal(humanDur(3600_000 * 2 + 60_000 * 15), '2h 15m');
  assert.equal(humanDur(86400_000 * 3 + 3600_000 * 4), '3d 4h');
});

test('ago: rounded to the unit a person would say it in', () => {
  const now = Date.now();
  assert.equal(ago(now - 30_000, now), 'a moment ago');
  assert.equal(ago(now - 12 * 60_000, now), '12 min ago');
  assert.equal(ago(now - 60 * 60_000, now), '1 hour ago');
  assert.equal(ago(now - 5 * 3600_000, now), '5 hours ago');
  assert.equal(ago(now - 26 * 3600_000, now), '1 day ago');
});
