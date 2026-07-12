import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hhmmss, humanDur, parseWhen } from '../lib/time.mjs';

test('parseWhen: sin valor → null (job secuencial)', () => {
  assert.equal(parseWhen(null), null);
  assert.equal(parseWhen(''), null);
});

test('parseWhen: relativos +Nm/+Nh/+Nd', () => {
  const t0 = Date.now();
  assert.ok(Math.abs(parseWhen('+30m') - (t0 + 30 * 60000)) < 2000);
  assert.ok(Math.abs(parseWhen('+2h') - (t0 + 2 * 3600000)) < 2000);
  assert.ok(Math.abs(parseWhen('+1d') - (t0 + 86400000)) < 2000);
});

test('parseWhen: HH:MM ya pasada hoy → mañana (nunca en el pasado)', () => {
  const when = parseWhen('00:01');
  assert.ok(when > Date.now(), 'debe quedar siempre en el futuro');
  assert.ok(when - Date.now() <= 86400000 + 60000);
});

test('parseWhen: HH:MM futura → hoy', () => {
  const d = new Date(Date.now() + 3600000);     // dentro de 1h
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const when = new Date(parseWhen(hhmm));
  assert.equal(when.getDate(), d.getDate());
  assert.equal(when.getHours(), d.getHours());
});

test('parseWhen: "mañana 09:00" y "tomorrow 09:00"', () => {
  for (const s of ['mañana 09:00', 'tomorrow 09:00']) {
    const d = new Date(parseWhen(s));
    assert.equal(d.getHours(), 9);
    assert.equal(d.getMinutes(), 0);
    assert.ok(d.getTime() > Date.now());
  }
});

test('parseWhen: día de la semana (lun/mon) cae en ese día y en el futuro', () => {
  const d = new Date(parseWhen('lun 08:30'));
  assert.equal(d.getDay(), 1);
  assert.equal(d.getHours(), 8);
  assert.ok(d.getTime() > Date.now());
});

test('parseWhen: ISO', () => {
  const d = new Date(parseWhen('2030-01-02T10:15'));
  assert.equal(d.getFullYear(), 2030);
  assert.equal(d.getMonth(), 0);
});

test('parseWhen: basura → error claro', () => {
  assert.throws(() => parseWhen('cuandosea'), /can't parse time/);
});

test('hhmmss: formatea y nunca va negativo', () => {
  assert.equal(hhmmss(0), '00:00:00');
  assert.equal(hhmmss(3661_000), '01:01:01');
  assert.equal(hhmmss(-5000), '00:00:00');       // pasado → clamp a cero
  assert.equal(hhmmss(90_000_000), '25:00:00');  // >24h: las horas no se envuelven
});

test('humanDur: compacto por magnitud', () => {
  assert.equal(humanDur(45_000), '45s');
  assert.equal(humanDur(125_000), '2m 5s');
  assert.equal(humanDur(3600_000 * 2 + 60_000 * 15), '2h 15m');
  assert.equal(humanDur(86400_000 * 3 + 3600_000 * 4), '3d 4h');
});
