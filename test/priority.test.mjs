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
  id: nid(), prompt: 'haz algo', target: null, adapter: 'mock', when: null,
  dir: null, permMode: null, status: 'pending', createdAt: T,
  sessionId: null, output: null, ...over,
});

// --- prioridad: adelantar SIN tocar la hora de nadie ---------------------------
// El orden de la cola se preserva justamente NO tocando el `when` (eso es lo que protege
// `requeue`). Así que "ponerlo primero" no puede hacerse falseando la hora: tiene que ser
// un campo aparte, y eso es lo que se prueba aquí.

test('un job con prioridad sale ANTES que uno agendado y ya vencido', () => {
  const due = job({ id: 'agendado', when: T - 5 * MIN });      // vencido: le tocaba hace 5 min
  const prio = job({ id: 'primero', when: null, priority: true });

  const { job: first } = nextUp([due, prio], T);
  assert.equal(first.id, 'primero');
});

test('…y ANTES que uno agendado para justo ahora, aunque llegara después', () => {
  const due = job({ id: 'agendado', when: T, createdAt: T - 60 * MIN });
  const prio = job({ id: 'primero', priority: true, createdAt: T });   // añadido el último

  assert.equal(nextUp([due, prio], T).job.id, 'primero');
  assert.equal(nextUp([prio, due], T).job.id, 'primero', 'y da igual el orden en el array');
});

test('la prioridad NO altera el `when` de nadie', () => {
  const due = job({ id: 'agendado', when: T + 30 * MIN });
  const otro = job({ id: 'otro', when: T + 60 * MIN });
  const prio = job({ id: 'primero', priority: true });
  const antes = [due, otro, prio].map((j) => j.when);

  nextUp([due, otro, prio], T);
  startable([due, otro, prio], [], 3, T);

  assert.deepEqual([due, otro, prio].map((j) => j.when), antes, 'ninguna hora se movió');
  assert.equal(prio.when, null, 'y el prioritario sigue sin hora: va cuando haya cupo');
});

test('varios prioritarios: el más antiguo primero (no se adelantan entre sí)', () => {
  const a = job({ id: 'a', priority: true, createdAt: T - 10 * MIN });
  const b = job({ id: 'b', priority: true, createdAt: T - 2 * MIN });
  assert.equal(nextUp([b, a], T).job.id, 'a');
  assert.deepEqual(startable([b, a], [], 9, T).map((j) => j.id), ['a', 'b']);
});

test('un agendado para el FUTURO sigue esperando su hora, prioridad o no', () => {
  const futuro = job({ id: 'futuro', when: T + 60 * MIN });
  assert.equal(nextUp([futuro], T).job, undefined);

  const prio = job({ id: 'primero', priority: true });
  assert.equal(nextUp([futuro, prio], T).job.id, 'primero');
  assert.deepEqual(startable([futuro, prio], [], 9, T).map((j) => j.id), ['primero']);
});

test('el orden completo: prioritario → vencido → secuencial', () => {
  const seq = job({ id: 'seq' });
  const due = job({ id: 'due', when: T - MIN });
  const prio = job({ id: 'prio', priority: true });
  assert.deepEqual(
    startable([seq, due, prio], [], 9, T).map((j) => j.id),
    ['prio', 'due', 'seq'],
  );
});

// --- el daemon ---------------------------------------------------------------
test('el daemon SÍ coge un prioritario, aunque no tenga hora', () => {
  // Un job secuencial espera a un `run` a mano: si el daemon los cogiera, añadir uno lo
  // lanzaría a los segundos. Un prioritario no es eso: alguien vio UNA conversación a
  // medias y dijo "sí, termínala en cuanto vuelva el cupo". Esa respuesta ES la orden de
  // lanzar sin nadie delante — y un daemon que lo ignorase dejaría la oferta aceptada y
  // nada corriendo nunca.
  const seq = job({ id: 'seq' });
  const prio = job({ id: 'prio', priority: true });

  const { job: picked } = nextUp([seq, prio], T, { scheduledOnly: true });
  assert.equal(picked.id, 'prio');

  // …pero el secuencial sigue esperando su `run`. Eso no cambia.
  assert.equal(nextUp([seq], T, { scheduledOnly: true }).job, undefined);
});

test('un prioritario nunca caduca como "missed" (no tiene hora que se le pase)', () => {
  saveQueue([job({ id: 'prio', priority: true, createdAt: T - 40 * 60 * 60 * 1000 })]);
  assert.equal(reapMissed(), 0, 'sin `when` no hay hora que perder');
});

// --- el campo ----------------------------------------------------------------
test('addJob acepta priority, y por defecto NO lo pone', () => {
  const normal = addJob({ prompt: 'x', dir: TMP });
  assert.equal(normal.priority, undefined, 'un job normal no lleva el campo');
  assert.equal(isPriority(normal), false);

  const first = addJob({ prompt: 'x', dir: TMP, priority: true });
  assert.equal(first.priority, true);
  assert.equal(isPriority(first), true);
  assert.equal(first.when, null);
});
