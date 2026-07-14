// El daemon: lo que hace que "a las 9" signifique a las 9 aunque no haya nada abierto.
//
// Dos cosas hay que demostrar aquí, y son las dos que fallaban:
//   1. un lanzamiento agendado se dispara SOLO, sin GUI y sin pulsar run;
//   2. agendar NO ejecuta: un job sin hora se queda quieto por mucho daemon que haya.
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
const CLI = path.join(ROOT, 'kaip.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-daemon-'));
const DATA = path.join(TMP, 'data');
const QUEUE = path.join(DATA, 'queue.json');

// Aquí sí se levantan daemons de verdad (es lo que hay que probar), pero siempre en un
// HOME temporal y siempre parados en el after: nada sobrevive al test.
const ENV = { ...process.env, KAIP_HOME: TMP, KAIP_NO_DAEMON: '' };
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: ENV, encoding: 'utf8' });

process.env.KAIP_HOME = TMP;            // lo que importemos aquí mira al mismo HOME temporal
const { isDaemonCmd, parsePosixProcs, parseWinProcs, unaccounted } = await import('../lib/daemon.mjs');

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

test('un job SIN hora no lo toca el daemon: agendar no es lanzar', async () => {
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
test('una hora absoluta en el pasado se rechaza al agendarla (no se lanza en el acto)', () => {
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

test('un "missed" se recupera reagendándolo (vuelve a pending)', () => {
  const j = mockJob({ when: Date.now() - 48 * 3600 * 1000 });
  seed([j]);
  cli('run', '--once');
  assert.equal(job(j.id).status, 'missed');

  const r = cli('edit', j.id, '--at', '+2h');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(job(j.id).status, 'pending', 'reagendarlo lo devuelve a la cola');
});

test('un "run" manual le QUITA el turno al daemon, y se lo devuelve al salir', () => {
  // Delante del terminal manda la persona. Antes, el daemon tenia el cerrojo y al escribir
  // "run" te soltaba un "another runner is already active" sin que hubiera nada visible
  // corriendo.
  seed([mockJob({ when: Date.now() + 60_000 })]);         // pendiente pero no vencido
  cli('daemon', 'start');

  const manual = cli('run', '--once');
  assert.match(manual.stdout, /took over from the daemon/i);
  assert.doesNotMatch(manual.stdout, /another runner is already active/i);

  const back = cli('daemon', 'status');
  assert.match(back.stdout, /daemon: on/i, 'y el daemon vuelve solo');
  cli('daemon', 'stop');
});

// --- un daemon. UNO. -----------------------------------------------------------
// Hay UN daemon global, y un "kaip run" es el MISMO papel: drenar la cola. Por eso hay un
// cerrojo. Lo que hacía la herramienta era spawnear un daemon en cada `add`, que chocaba
// contra el cerrojo y se moría en silencio medio segundo después — pero no antes de haber
// escrito su pid y haber anunciado "daemon started, it will fire on time". Un proceso
// condenado y una mentira por cada alta.

/** Un cerrojo vivo, tomado por alguien que no es el daemon: exactamente un `kaip run`. */
function fakeRun() {
  const lock = path.join(DATA, 'runner.lock');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  fs.rmSync(path.join(DATA, 'daemon.json'), { force: true });
  return () => fs.rmSync(lock, { force: true });
}

const daemonState = () => path.join(DATA, 'daemon.json');

test('con un "run" vivo, "daemon start" NO spawnea nada — y lo dice', () => {
  seed([mockJob({ when: Date.now() + 60_000 })]);
  const release = fakeRun();

  const r = cli('daemon', 'start');
  release();

  assert.doesNotMatch(r.stdout, /daemon started \(pid \d+\)/i, 'no puede anunciar un pid que no ha arrancado');
  assert.match(r.stdout, /already draining the queue/i, 'tiene que decir quién drena la cola');
  assert.equal(fs.existsSync(daemonState()), false, 'y no deja ni el pid escrito');
});

test('un "add" con hora y un "run" vivo: ningún daemon nace, y el mensaje es verdad', () => {
  seed([]);
  const release = fakeRun();

  const r = cli('add', 'con un run delante', '--at', '+2h', '--adapter', 'mock');
  release();

  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(daemonState()), false, 'nada de daemons condenados por cada alta');
  assert.match(r.stdout, /procesando la cola/i, 'dice quién lo va a lanzar de verdad');
  assert.doesNotMatch(r.stdout, /daemon started/i, 'y no presume de uno que no existe');
  assert.match(r.stdout, /cierras esa ventana/i, 'con la letra pequeña: un run muere con su ventana');
});

test('"daemon status" no jura que no se lanzará nada mientras un "run" lo lanza', () => {
  seed([mockJob({ when: Date.now() + 60_000 })]);
  const release = fakeRun();

  const r = cli('daemon', 'status');
  release();

  assert.match(r.stdout, /draining the queue/i);
  assert.doesNotMatch(r.stdout, /will NOT fire/i, 'porque sí se va a lanzar');
});

// --- zombis --------------------------------------------------------------------
// Un daemon huérfano no se ve: nace oculto y escribe en un log. La única forma de saber que
// está ahí es contar los procesos y compararlos con el pid que decimos tener.
test('un daemon se reconoce por su línea de comandos, y nada más se le parece', () => {
  assert.ok(isDaemonCmd('node C:\\kaip\\kaip.mjs daemon run'));
  assert.ok(isDaemonCmd('node "C:\\ruta con espacios\\kaip.mjs" daemon run --seq'));
  assert.equal(isDaemonCmd('node C:\\kaip\\kaip.mjs run'), false, 'un "run" manual NO es el daemon');
  assert.equal(isDaemonCmd('node servidor.mjs'), false);
  assert.equal(isDaemonCmd(null), false);
});

test('los procesos que no son el pid de daemon.json son huérfanos', () => {
  const procs = [{ pid: 111, cmd: 'x' }, { pid: 222, cmd: 'x' }, { pid: process.pid, cmd: 'x' }];

  assert.deepEqual(unaccounted(procs, 111).map((p) => p.pid), [222],
    'el daemon que sí conocemos no es un huérfano, y nosotros tampoco');
  assert.deepEqual(unaccounted(procs, null).map((p) => p.pid), [111, 222],
    'sin daemon anotado, los dos sobran');
});

test('la lista de procesos se lee igual venga de PowerShell o de ps', () => {
  const win = parseWinProcs('{"ProcessId":42,"CommandLine":"node kaip.mjs daemon run"}');
  assert.deepEqual(win, [{ pid: 42, cmd: 'node kaip.mjs daemon run' }],
    'un solo proceso vuelve como objeto, no como lista');

  assert.equal(parseWinProcs('[{"ProcessId":1,"CommandLine":"a"},{"ProcessId":2}]').length, 2);
  assert.deepEqual(parseWinProcs('no es json'), [], 'y una salida rota no revienta el status');

  assert.deepEqual(parsePosixProcs(' 42 node kaip.mjs daemon run\n  7 otra cosa\n'), [
    { pid: 42, cmd: 'node kaip.mjs daemon run' },
    { pid: 7, cmd: 'otra cosa' },
  ]);
});

test('dos runners MANUALES si se respetan: el segundo se retira', () => {
  // El cerrojo sigue haciendo su trabajo donde importa: nadie puede lanzar dos veces
  // el mismo job. Lo que ya no bloquea es al humano frente al daemon.
  seed([mockJob({ when: Date.now() + 60_000 })]);
  const lock = path.join(TMP, 'data', 'runner.lock');
  // Un runner vivo de verdad. Vale este mismo proceso: el `run` que arrancamos abajo es OTRO
  // (un hijo), así que ve un cerrojo de un pid que existe y no es el suyo — que es justo el
  // caso. Fingirlo con el pid 999999 dejó de colar cuando el cerrojo empezó a comprobar si
  // el proceso está realmente ahí.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));

  const second = cli('run', '--once');
  fs.rmSync(lock, { force: true });

  assert.match(second.stdout, /another runner is already active/i);
});
