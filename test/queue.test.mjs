import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-queue-'));
process.env.PROMPTHEUS_HOME = TMP;
const { loadQueue, loadSessions, saveProjects, saveQueue, saveSessions } = await import('../lib/store.mjs');
const {
  addJob, clearFinished, jobDetails, removeJobs, suggestDirs, suggestTargets,
} = await import('../lib/queue.mjs');

// --- conversaciones recomendadas --------------------------------------------
// Reutilizar un target es el mayor ahorro de tokens de la herramienta: el lanzamiento
// retoma una sesión que YA tiene el contexto cargado. Por eso el asistente las ofrece
// en vez de obligarte a recordar el nombre.

test('suggestTargets: propone las sesiones ya existentes, la más reciente primero', () => {
  saveQueue([]);
  saveSessions({
    vieja: { sessionId: 's-vieja', adapter: 'claude', updatedAt: 1000 },
    reciente: { sessionId: 's-reciente', adapter: 'claude', updatedAt: 9000 },
  });

  const s = suggestTargets();
  assert.deepEqual(s.map((x) => x.target), ['reciente', 'vieja']);
  assert.equal(s[0].sessionId, 's-reciente');
  assert.equal(s[0].upcoming, false);
});

test('suggestTargets: incluye targets que aún no han corrido, marcados como "upcoming"', () => {
  // Encadenar trabajo sobre un lanzamiento que todavía no ha salido es un caso real.
  saveSessions({});
  saveQueue([{
    id: 'j1', target: 'manana', prompt: 'x', status: 'pending',
    createdAt: 5000, sessionId: null, adapter: 'claude',
  }]);

  const [s] = suggestTargets();
  assert.equal(s.target, 'manana');
  assert.equal(s.upcoming, true, 'aún no tiene sesión');
  assert.equal(s.jobs, 1);
});

test('suggestTargets: un target con sesión Y jobs sale una sola vez, no duplicado', () => {
  saveSessions({ fixes: { sessionId: 's-fixes', adapter: 'claude', updatedAt: 1000 } });
  saveQueue([
    { id: 'j1', target: 'fixes', status: 'done', createdAt: 2000, finishedAt: 3000, sessionId: 's-fixes', adapter: 'claude', prompt: 'a' },
    { id: 'j2', target: 'fixes', status: 'pending', createdAt: 4000, sessionId: null, adapter: 'claude', prompt: 'b' },
  ]);

  const s = suggestTargets();
  assert.equal(s.length, 1);
  assert.equal(s[0].jobs, 2);
  assert.equal(s[0].sessionId, 's-fixes');
  assert.equal(s[0].upcoming, false);
});

test('suggestTargets: sin nada, lista vacía (no revienta)', () => {
  saveSessions({}); saveQueue([]);
  assert.deepEqual(suggestTargets(), []);
});

test('suggestDirs: junta los alias de proyectos y las carpetas ya usadas, sin repetir', () => {
  saveProjects({ _base: 'C:/base', miapp: 'C:/base/MiApp' });
  saveQueue([
    { id: 'j1', dir: 'C:/base/MiApp', status: 'done', createdAt: 5000, adapter: 'claude', prompt: 'a' },
    { id: 'j2', dir: 'C:/otra', status: 'done', createdAt: 9000, adapter: 'claude', prompt: 'b' },
  ]);

  const dirs = suggestDirs();
  assert.equal(dirs.filter((d) => d.dir === 'C:/base/MiApp').length, 1, 'sin duplicar');
  assert.equal(dirs[0].dir, 'C:/otra', 'la más reciente primero');
  assert.equal(dirs.find((d) => d.dir === 'C:/base/MiApp').label, 'miapp', 'conserva el alias');
});

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
  saveProjects({ mialias: 'C:/algun/sitio/MiApp' });
  const j = addJob({ prompt: 'x', at: '+2h', dir: 'mialias' });

  assert.ok(Math.abs(j.when - (Date.now() + 2 * 3600_000)) < 5000);
  assert.equal(j.dir, 'C:/algun/sitio/MiApp');
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
