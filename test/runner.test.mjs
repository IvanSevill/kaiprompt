import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-run-'));
process.env.PROGRAM_PROMPT_HOME = TMP;
const { loadQueue, loadSessions, nid, outPath, saveQueue, saveSessions } = await import('../lib/store.mjs');
const { executeJob, requeue, runQueue, settle } = await import('../lib/runner.mjs');

const job = (over = {}) => ({
  id: nid(), prompt: 'haz algo', target: null, adapter: 'mock', when: null,
  dir: null, permMode: null, status: 'pending', createdAt: Date.now(),
  sessionId: null, output: null, ...over,
});

// --- quedarse sin cupo no es un fallo ---------------------------------------
// La tanda nocturna perdió su última fase justo aquí: Claude imprime "you've hit your
// session limit" y sale con código 1, que visto desde fuera es igual que un crash. Se
// marcó como `error` y nadie volvió a recogerlo nunca.

const LIMIT = "You've hit your session limit · resets 1:30pm (Europe/Madrid)";

test('settle: un lanzamiento OK termina, sin más', () => {
  assert.deepEqual(settle(job(), { ok: true }), { action: 'done' });
});

test('settle: cortado por cupo → vuelve a la cola, NO se marca como error', () => {
  const s = settle(job(), { ok: false, output: LIMIT, error: 'claude exited with code 1' });
  assert.equal(s.action, 'requeue');
  assert.ok(s.waitUntil > Date.now(), 'con una hora de reanudación en el futuro');
});

test('settle: un fallo de VERDAD sigue siendo un error (no se reintenta eternamente)', () => {
  const s = settle(job(), { ok: false, output: 'TypeError: boom', error: 'crashed' });
  assert.equal(s.action, 'fail');
});

test('settle: se rinde si el cupo lo tumba una y otra vez', () => {
  const s = settle(job({ quotaRetries: 3 }), { ok: false, output: LIMIT, error: 'x' });
  assert.equal(s.action, 'fail');
  assert.match(s.reason, /giving up/);
});

test('requeue: vuelve a pending y NO toca "when" — eso conserva el ORDEN de la cola', () => {
  // Lo que pediste: que al volver el cupo siga en el mismo sitio en que estaba.
  const primero = job({ when: 1000 });
  const segundo = job({ when: 2000 });
  saveQueue([primero, segundo]);

  const s = settle(primero, { ok: false, output: LIMIT, error: 'x' });
  requeue(primero, s);

  const q = loadQueue();
  const vuelto = q.find((j) => j.id === primero.id);
  assert.equal(vuelto.status, 'pending', 'de vuelta en la cola');
  assert.equal(vuelto.when, 1000, 'su hora NO cambia');
  assert.equal(vuelto.quotaRetries, 1);
  assert.ok(vuelto.pausedUntil > Date.now());
  assert.equal(vuelto.finishedAt, null, 'no cuenta como terminado');

  // Y sigue siendo el más antiguo pendiente: al volver el cupo, sale primero otra vez.
  const pendientes = q.filter((j) => j.status === 'pending').sort((a, b) => a.when - b.when);
  assert.equal(pendientes[0].id, primero.id);
  assert.equal(pendientes[1].id, segundo.id);
});

test('executeJob: marca done, escribe la salida y guarda la sesión del target', async () => {
  const j = job({ target: 'fixes' });
  saveQueue([j]);

  const res = await executeJob(j);

  assert.equal(res.ok, true);
  assert.equal(j.status, 'done');
  assert.ok(j.finishedAt);
  assert.ok(fs.existsSync(outPath(j.id)), 'debe escribir out/<id>.txt');
  assert.match(fs.readFileSync(outPath(j.id), 'utf8'), /\[mock\]/);
  assert.ok(j.sessionId, 'debe capturar el session id');
  assert.equal(loadSessions().fixes.sessionId, j.sessionId, 'y asociarlo al target');
});

test('executeJob: reanuda la sesión guardada del target', async () => {
  saveSessions({ reanuda: { sessionId: 'sesion-previa', adapter: 'mock', updatedAt: 1 } });
  const j = job({ target: 'reanuda' });
  await executeJob(j);
  assert.equal(j.sessionId, 'sesion-previa', 'reutiliza la sesión, no crea otra');
});

test('executeJob: adaptador inexistente → error controlado', async () => {
  const j = job({ adapter: 'no-existe' });
  await assert.rejects(() => executeJob(j), /unknown adapter/);
});

test('executeJob: emite eventos en vivo cuando se pasa onEvent', async () => {
  const vistos = [];
  const j = job();
  await executeJob(j, { onEvent: (e) => vistos.push(e.type) });

  assert.ok(vistos.includes('system'), 'evento de init');
  assert.ok(vistos.includes('assistant'), 'eventos de trabajo');
  assert.ok(vistos.includes('result'), 'evento final');
});

test('executeJob: sin onEvent NO hay streaming (modo de una tacada)', async () => {
  const j = job();
  const res = await executeJob(j);          // no debe romper ni colgarse
  assert.equal(res.ok, true);
});

test('runQueue (sin TTY): procesa los secuenciales en orden', async () => {
  const a = job({ prompt: 'primero' });
  const b = job({ prompt: 'segundo' });
  saveQueue([a, b]);

  await runQueue({ once: true });

  const q = loadQueue();
  assert.equal(q.length, 2);
  assert.ok(q.every((j) => j.status === 'done'), 'los dos deben quedar done');
  assert.ok(q[0].finishedAt <= q[1].finishedAt, 'y en orden: el 2º tras el 1º');
});

test('runQueue --once: NO espera a los agendados a futuro', async () => {
  const futuro = job({ when: Date.now() + 3600_000 });
  saveQueue([futuro]);

  const t0 = Date.now();
  await runQueue({ once: true });

  assert.ok(Date.now() - t0 < 3000, 'debe salir enseguida, no esperar una hora');
  assert.equal(loadQueue()[0].status, 'pending', 'y dejarlo pendiente');
});

test('runQueue --dry-run: no ejecuta nada', async () => {
  const j = job();
  saveQueue([j]);
  await runQueue({ dryRun: true });
  assert.equal(loadQueue()[0].status, 'pending', 'sigue pendiente: no se ha lanzado');
  assert.ok(!fs.existsSync(outPath(j.id)), 'y no escribe salida');
});

test('runQueue: cola vacía no rompe', async () => {
  saveQueue([]);
  await runQueue({ once: true });
  assert.deepEqual(loadQueue(), []);
});

// --- cerrojo: evita que dos runners ejecuten el mismo job dos veces ----------
test('cerrojo: un segundo runner no hace nada mientras hay otro activo', async () => {
  const { lockIsHeld } = await import('../lib/runner.mjs');
  const lock = path.join(TMP, 'data', 'runner.lock');

  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() }));
  assert.equal(lockIsHeld(), true, 'cerrojo fresco = hay runner vivo');

  const j = job();
  saveQueue([j]);
  await runQueue({ once: true });
  assert.equal(loadQueue()[0].status, 'pending', 'no debe tocar la cola: hay otro runner');

  fs.rmSync(lock, { force: true });
});

test('cerrojo caducado (runner muerto) se ignora y se puede volver a lanzar', async () => {
  const { lockIsHeld } = await import('../lib/runner.mjs');
  const lock = path.join(TMP, 'data', 'runner.lock');

  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() - 10 * 60_000 }));  // 10 min
  assert.equal(lockIsHeld(), false, 'cerrojo viejo = el runner murió');

  saveQueue([job()]);
  await runQueue({ once: true });
  assert.equal(loadQueue()[0].status, 'done', 'debe poder ejecutar igualmente');
});

test('cerrojo: se libera al terminar', async () => {
  saveQueue([]);
  await runQueue({ once: true });
  assert.equal(fs.existsSync(path.join(TMP, 'data', 'runner.lock')), false, 'no debe quedar colgado');
});
