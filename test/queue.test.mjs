import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-queue-'));
process.env.PROGRAM_PROMPT_HOME = TMP;
const { loadQueue, loadSessions, saveProjects, saveQueue } = await import('../lib/store.mjs');
const { addJob, clearFinished, jobDetails, removeJobs } = await import('../lib/queue.mjs');

test('addJob: crea un job pending y lo mete en la cola', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'haz algo', adapter: 'mock' });

  assert.equal(j.status, 'pending');
  assert.equal(j.prompt, 'haz algo');
  assert.equal(j.when, null, 'sin --at es secuencial');
  assert.ok(j.createdAt);
  assert.deepEqual(loadQueue().map((x) => x.id), [j.id], 'y queda guardado');
});

test('addJob: --at pasa por parseWhen y --dir por resolveDir (como en la CLI)', () => {
  saveQueue([]);
  saveProjects({ mifac: 'C:/algun/sitio/FacturaSevi' });
  const j = addJob({ prompt: 'x', at: '+2h', dir: 'mifac' });

  assert.ok(Math.abs(j.when - (Date.now() + 2 * 3600_000)) < 5000);
  assert.equal(j.dir, 'C:/algun/sitio/FacturaSevi');
});

test('addJob: sin --dir cae en la carpeta actual', () => {
  const j = addJob({ prompt: 'x', cwd: 'C:/donde/estoy' });
  assert.equal(j.dir, 'C:/donde/estoy');
});

test('addJob: prompt vacío se rechaza (un job sin prompt no lanza nada)', () => {
  assert.throws(() => addJob({ prompt: '   ' }), /missing prompt/);
});

test('addJob: con session + target, el target apunta a esa sesión', () => {
  saveQueue([]);
  addJob({ prompt: 'x', target: 'fixes', session: 'sesion-123', adapter: 'mock' });
  assert.equal(loadSessions().fixes.sessionId, 'sesion-123');
});

test('addJob: hora que no se entiende → error de parseWhen, y la cola intacta', () => {
  saveQueue([]);
  assert.throws(() => addJob({ prompt: 'x', at: 'a las tantas' }), /can't parse time/);
  assert.equal(loadQueue().length, 0);
});

test('removeJobs: quita los pedidos y devuelve cuántos', () => {
  saveQueue([]);
  const a = addJob({ prompt: 'a' }), b = addJob({ prompt: 'b' }), cc = addJob({ prompt: 'c' });
  assert.equal(removeJobs([a.id, cc.id]), 2);
  assert.deepEqual(loadQueue().map((j) => j.id), [b.id]);
});

test('removeJobs: un id que no existe no borra nada', () => {
  saveQueue([]);
  addJob({ prompt: 'a' });
  assert.equal(removeJobs(['nope']), 0);
  assert.equal(loadQueue().length, 1);
});

test('clearFinished: se lleva done/error y respeta pending/running', () => {
  saveQueue([]);
  const keep = addJob({ prompt: 'pendiente' });
  const run = addJob({ prompt: 'corriendo' });
  const old = addJob({ prompt: 'terminado' });
  saveQueue(loadQueue().map((j) => {
    if (j.id === run.id) return { ...j, status: 'running' };
    if (j.id === old.id) return { ...j, status: 'done' };
    return j;
  }));

  assert.equal(clearFinished(), 1);
  const ids = loadQueue().map((j) => j.id);
  assert.ok(ids.includes(keep.id) && ids.includes(run.id));
  assert.ok(!ids.includes(old.id));
});

test('jobDetails: enseña lo que importa del job', () => {
  const j = addJob({ prompt: 'revisa el PR', target: 'review', perm: 'acceptEdits', adapter: 'mock' });
  const out = jobDetails(j);
  assert.match(out, new RegExp(j.id));
  assert.match(out, /status:\s+pending/);
  assert.match(out, /target:\s+review/);
  assert.match(out, /perm:\s+acceptEdits/);
  assert.match(out, /revisa el PR/);
});

test('jobDetails: sin target/sesión no se rompe (pinta —)', () => {
  const out = jobDetails(addJob({ prompt: 'x' }));
  assert.match(out, /target:\s+—/);
  assert.match(out, /perm:\s+bypass/, 'sin permMode, bypass');
});
