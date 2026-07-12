// El daemon: lo que hace que "a las 9" signifique a las 9 aunque no haya nada abierto.
//
// Dos cosas hay que demostrar aquí, y son las dos que fallaban:
//   1. un lanzamiento programado se dispara SOLO, sin GUI y sin pulsar run;
//   2. programar NO ejecuta: un job sin hora se queda quieto por mucho daemon que haya.
//
// Se prueba de verdad: se levanta el proceso, se usa el adaptador mock (no gasta
// créditos) y se espera a ver el resultado en disco.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'promptheus.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-daemon-'));
const DATA = path.join(TMP, 'data');
const QUEUE = path.join(DATA, 'queue.json');

// Aquí sí se levantan daemons de verdad (es lo que hay que probar), pero siempre en un
// HOME temporal y siempre parados en el after: nada sobrevive al test.
const ENV = { ...process.env, PROMPTHEUS_HOME: TMP, PROMPTHEUS_NO_DAEMON: '' };
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: ENV, encoding: 'utf8' });

const queue = () => JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const job = (id) => queue().find((j) => j.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera a que se cumpla algo, o se rinde: los tests no pueden colgarse para siempre. */
async function until(cond, ms = 20_000, step = 250) {
  const limit = Date.now() + ms;
  while (Date.now() < limit) {
    if (cond()) return true;
    await sleep(step);
  }
  return false;
}

/** Escribe la cola a mano: así el test controla la hora exacta sin depender del parser. */
function seed(jobs) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(QUEUE, JSON.stringify(jobs, null, 2));
}

const mockJob = (over = {}) => ({
  id: 'test' + Math.random().toString(36).slice(2, 7),
  prompt: 'hola', target: null, adapter: 'mock', when: null, dir: null,
  permMode: null, status: 'pending', createdAt: Date.now(), sessionId: null, output: null,
  ...over,
});

after(() => {
  cli('daemon', 'stop');                                  // nunca dejar procesos sueltos
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows a veces se queja */ }
});

before(() => { cli('daemon', 'stop'); });

test('arranca, se reporta vivo y para', () => {
  const start = cli('daemon', 'start');
  assert.match(start.stdout, /daemon started \(pid \d+\)/);

  const st = cli('daemon', 'status');
  assert.match(st.stdout, /daemon: on \(pid \d+\)/);

  const again = cli('daemon', 'start');
  assert.match(again.stdout, /daemon: on/, 'arrancarlo dos veces no crea un segundo daemon');

  const stop = cli('daemon', 'stop');
  assert.match(stop.stdout, /daemon stopped/);
  assert.match(cli('daemon', 'status').stdout, /daemon: off/);
});

const daemonLog = () => {
  try { return fs.readFileSync(path.join(DATA, 'daemon.log'), 'utf8'); } catch { return '(sin log)'; }
};

test('un job PROGRAMADO se dispara solo: sin GUI, sin run, sin nadie delante', async () => {
  const j = mockJob({ when: Date.now() + 2000, prompt: 'lanzamiento programado' });
  seed([j]);

  const start = cli('daemon', 'start');                   // esto es todo lo que hace el usuario
  const fired = await until(() => job(j.id)?.status === 'done');
  cli('daemon', 'stop');

  assert.ok(fired, `el daemon tenía que lanzarlo al llegar su hora.\n`
    + `start: ${start.stdout}${start.stderr}\nlog:\n${daemonLog()}\ncola: ${JSON.stringify(queue(), null, 2)}`);
  const done = job(j.id);
  assert.equal(done.status, 'done');
  assert.ok(done.output, 'y dejar su salida en out/');
  assert.ok(fs.existsSync(path.join(TMP, done.output)));
});

test('un job SIN hora no lo toca el daemon: programar no es lanzar', async () => {
  const j = mockJob({ prompt: 'secuencial, no debe salir solo' });
  seed([j]);

  cli('daemon', 'start');
  await sleep(3000);                                      // tiempo de sobra para meter la pata
  const st = job(j.id).status;
  cli('daemon', 'stop');

  assert.equal(st, 'pending', 'un job secuencial solo se lanza en un run manual');
});

test('pero un run manual sí se lo lleva (para eso está)', async () => {
  const j = mockJob({ prompt: 'secuencial' });
  seed([j]);

  const r = cli('run', '--once');
  assert.equal(job(j.id).status, 'done', r.stdout + r.stderr);
});

test('--seq: si lo pides expresamente, el daemon también vacía los secuenciales', async () => {
  const j = mockJob({ prompt: 'secuencial con --seq' });
  seed([j]);

  cli('daemon', 'start', '--seq');
  const fired = await until(() => job(j.id).status === 'done', 15_000);
  cli('daemon', 'stop');

  assert.ok(fired, 'con --seq sí entra');
});

test('el daemon recoge lo que /programar dejó en el buzón mientras dormía', async () => {
  seed([]);
  cli('daemon', 'start');

  const entry = {
    id: 'pbuzon1', at: new Date().toISOString(), when: Date.now() + 1500,
    target: null, prompt: 'vengo del chat', adapter: 'mock', dir: null, createdAt: Date.now(),
  };
  fs.writeFileSync(path.join(TMP, 'programados.jsonl'), JSON.stringify(entry) + '\n');

  const fired = await until(() => job('pbuzon1')?.status === 'done');
  cli('daemon', 'stop');

  assert.ok(fired, 'el hook escribe el buzón y el daemon lo importa sin reiniciarlo');
});

test('un job colgado en "running" por un runner muerto se cierra como error', () => {
  seed([mockJob({ status: 'running', runnerPid: 999_999, startedAt: Date.now() - 60_000 })]);

  cli('run', '--once');                                   // cualquier arranque hace la limpieza

  const j = queue()[0];
  assert.equal(j.status, 'error');
  assert.match(j.error, /interrupted/i);
});

// El bug que originó todo: una hora mal entendida (ISO en UTC leído como local) caía en
// el pasado, y "pasado" significa "vencido" → se lanzaba en el acto. Dos puertas cerradas:
// el parser ya no acepta una hora absoluta pasada, y el runner no resucita lo muy vencido.
test('una hora absoluta en el pasado se rechaza al programarla (no se lanza en el acto)', () => {
  const ayer = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19);
  const r = cli('add', 'no debería salir', '--at', ayer, '--adapter', 'mock');

  assert.notEqual(r.status, 0, 'tiene que fallar, no encolar');
  assert.match(r.stderr + r.stdout, /in the past/i);
  assert.match(r.stderr + r.stdout, /UTC/, 'y explicar la trampa de la Z, que es la causa real');
});

test('un lanzamiento demasiado vencido se marca "missed" en vez de dispararse', async () => {
  const viejo = mockJob({ when: Date.now() - 48 * 3600 * 1000, prompt: 'de hace dos días' });
  const bueno = mockJob({ when: Date.now() - 60_000, prompt: 'de hace un minuto' });
  seed([viejo, bueno]);

  cli('run', '--once');

  assert.equal(job(viejo.id).status, 'missed', 'lo de hace dos días NO revive');
  assert.match(job(viejo.id).error, /missed/i);
  assert.equal(job(bueno.id).status, 'done', 'pero un retraso normal sí se recupera');
});

test('un "missed" se recupera reprogramándolo (vuelve a pending)', () => {
  const j = mockJob({ when: Date.now() - 48 * 3600 * 1000 });
  seed([j]);
  cli('run', '--once');
  assert.equal(job(j.id).status, 'missed');

  const r = cli('edit', j.id, '--at', '+2h');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(job(j.id).status, 'pending', 'reprogramar lo devuelve a la cola');
});

test('dos runners no se pisan: el segundo se retira', () => {
  seed([mockJob({ when: Date.now() + 60_000 })]);         // algo pendiente pero no vencido
  cli('daemon', 'start');

  const second = cli('run');                              // intenta correr con el daemon vivo
  cli('daemon', 'stop');

  assert.match(second.stdout, /another runner is already active/i);
});
