// Quedarse sin cupo a media tanda no es un fallo, es una interrupción. Estos tests
// fijan la diferencia: la Fase 4 de la tanda nocturna murió justo así y se perdió.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_QUOTA_RETRIES, isQuotaExhausted, parseResetAt, planRetry, quotaVerdict, resetFromUsage,
} from '../lib/quota.mjs';

// El mensaje real que mató el lanzamiento de anoche.
const REAL = "You've hit your session limit · resets 1:30pm (Europe/Madrid)\n\n[ERROR] claude exited with code 1";

// --- detección ---------------------------------------------------------------
test('reconoce el mensaje exacto que cortó la tanda nocturna', () => {
  assert.ok(isQuotaExhausted(REAL));
});

test('reconoce las otras formas de decirlo', () => {
  for (const s of [
    'You have reached your usage limit',
    'Usage limit reached',
    'you have exceeded your rate limit',
  ]) assert.ok(isQuotaExhausted(s), s);
});

test('un fallo NORMAL no se confunde con quedarse sin cupo', () => {
  // Esto importa: si confundiéramos un crash con el cupo, reintentaríamos para siempre.
  for (const s of [
    'TypeError: cannot read property of undefined',
    'the tests failed: 3 passing, 2 failing',
    '[ERROR] claude exited with code 1',
    'rate limiting is implemented in this file',
    '',
    undefined,
  ]) assert.equal(isQuotaExhausted(s), false, String(s));
});

// --- cuándo vuelve el cupo ---------------------------------------------------
test('parseResetAt: "resets 1:30pm" con la tarde ya empezada → hoy a las 13:30', () => {
  const now = new Date('2026-07-12T09:00:00').getTime();
  const at = new Date(parseResetAt(REAL, now));
  assert.equal(at.getHours(), 13);
  assert.equal(at.getMinutes(), 30);
  assert.equal(at.getDate(), 12);
});

test('parseResetAt: si la hora ya pasó hoy, es mañana (nunca despertamos en el pasado)', () => {
  const now = new Date('2026-07-12T15:00:00').getTime();
  const at = parseResetAt('resets 1:30pm', now);
  assert.ok(at > now);
  assert.equal(new Date(at).getDate(), 13);
});

test('parseResetAt: formato 24h y sin minutos', () => {
  const now = new Date('2026-07-12T05:00:00').getTime();
  assert.equal(new Date(parseResetAt('resets at 08:30', now)).getHours(), 8);
  assert.equal(new Date(parseResetAt('resets 3am', now)).getHours(), 3);
  assert.equal(new Date(parseResetAt('resets 11pm', now)).getHours(), 23);
});

test('parseResetAt: medianoche y mediodía no se cruzan (12am=0, 12pm=12)', () => {
  const now = new Date('2026-07-12T06:00:00').getTime();
  assert.equal(new Date(parseResetAt('resets 12pm', now)).getHours(), 12);
  assert.equal(new Date(parseResetAt('resets 12am', now)).getHours(), 0);
});

test('parseResetAt: sin hora en el texto → null (no inventamos)', () => {
  assert.equal(parseResetAt('hit your session limit', Date.now()), null);
  assert.equal(parseResetAt('resets 99:99', Date.now()), null);
});

// --- el archivo de claude-usage ----------------------------------------------
test('resetFromUsage: coge la ventana que vence ANTES de las dos', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-quota-')), 'usage.json');
  const soon = new Date(Date.now() + 3600_000).toISOString();
  const later = new Date(Date.now() + 86400_000).toISOString();
  fs.writeFileSync(tmp, JSON.stringify({
    five_hour: { resets_at: soon }, seven_day: { resets_at: later },
  }));
  assert.equal(resetFromUsage(tmp), Date.parse(soon));
});

test('resetFromUsage: ignora los resets ya pasados (el archivo puede estar rancio)', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-quota-')), 'usage.json');
  fs.writeFileSync(tmp, JSON.stringify({ five_hour: { resets_at: '2020-01-01T00:00:00Z' } }));
  assert.equal(resetFromUsage(tmp), null);
});

test('resetFromUsage: sin archivo o con basura → null, sin reventar', () => {
  assert.equal(resetFromUsage('/no/existe.json'), null);
});

// --- el veredicto ------------------------------------------------------------
test('quotaVerdict: el mensaje manda sobre el archivo (describe ESTE lanzamiento)', () => {
  const now = new Date('2026-07-12T09:00:00').getTime();
  const v = quotaVerdict(REAL, { now, usageFile: '/no/existe.json' });
  assert.equal(v.exhausted, true);
  assert.equal(v.source, 'message');
  assert.equal(new Date(v.resetsAt).getHours(), 13);
  assert.ok(v.resetsAt > parseResetAt(REAL, now) - 1, 'con un margen de gracia por encima del reset');
});

test('quotaVerdict: sin hora en el mensaje ni archivo → 5h por delante (nunca null)', () => {
  const now = Date.now();
  const v = quotaVerdict('hit your session limit', { now, usageFile: '/no/existe.json' });
  assert.equal(v.source, 'fallback');
  assert.ok(v.resetsAt > now);
});

test('quotaVerdict: si no fue el cupo, no hay nada que esperar', () => {
  const v = quotaVerdict('TypeError: boom', { usageFile: '/no/existe.json' });
  assert.deepEqual(v, { exhausted: false, resetsAt: null, source: null });
});

// --- qué hacer con el job ----------------------------------------------------
test('planRetry: cortado por cupo → vuelve a la cola, NO se marca como error', () => {
  const v = quotaVerdict(REAL, { usageFile: '/no/existe.json' });
  const plan = planRetry({ id: 'j1' }, v);
  assert.equal(plan.action, 'requeue');
  assert.equal(plan.quotaRetries, 1);
  assert.equal(plan.waitUntil, v.resetsAt);
});

test('planRetry: NO toca "when" — eso es lo que conserva el orden de la cola', () => {
  // El job cortado guarda su hora original, así que al volver el cupo sigue siendo el
  // más antiguo pendiente y sale primero. Los de detrás siguen detrás.
  const job = { id: 'j1', when: 1000, quotaRetries: 0 };
  const plan = planRetry(job, quotaVerdict(REAL, { usageFile: '/no/existe.json' }));
  assert.equal(job.when, 1000, 'el job no se muta');
  assert.ok(!('when' in plan), 'el plan no propone cambiar la hora');
});

test('planRetry: un fallo de verdad se marca como error (no se reintenta)', () => {
  const plan = planRetry({ id: 'j1' }, quotaVerdict('TypeError: boom', { usageFile: '/no/existe.json' }));
  assert.equal(plan.action, 'fail');
});

test('planRetry: se rinde tras varios intentos seguidos (si no, bucle infinito)', () => {
  const v = quotaVerdict(REAL, { usageFile: '/no/existe.json' });
  const plan = planRetry({ id: 'j1', quotaRetries: MAX_QUOTA_RETRIES }, v);
  assert.equal(plan.action, 'fail');
  assert.match(plan.reason, /giving up/);
});
