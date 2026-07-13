import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Aislar los datos ANTES de importar el store (lee la env al cargarse).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-store-'));
process.env.KAIP_HOME = TMP;
const {
  importProgramados, loadQueue, loadSessions, nid, patchJob, preview,
  resolveDir, saveProjects, saveQueue, saveSessions,
} = await import('../lib/store.mjs');

const job = (over = {}) => ({
  id: nid(), prompt: 'hola', target: null, adapter: 'mock', when: null,
  dir: null, permMode: null, status: 'pending', createdAt: Date.now(),
  sessionId: null, output: null, ...over,
});

test('cola: vacía por defecto, y round-trip', () => {
  assert.deepEqual(loadQueue(), []);
  const j = job();
  saveQueue([j]);
  assert.equal(loadQueue()[0].id, j.id);
});

test('patchJob actualiza solo ese job', () => {
  const a = job(), b = job();
  saveQueue([a, b]);
  patchJob({ ...b, status: 'done' });
  const q = loadQueue();
  assert.equal(q.find((j) => j.id === a.id).status, 'pending');
  assert.equal(q.find((j) => j.id === b.id).status, 'done');
});

test('sesiones: round-trip', () => {
  saveSessions({ fixes: { sessionId: 'abc', adapter: 'claude', updatedAt: 1 } });
  assert.equal(loadSessions().fixes.sessionId, 'abc');
});

test('nid: ids únicos aunque se generen miles en el mismo milisegundo', () => {
  // Regresión: con solo 3 chars aleatorios había ~35% de colisión en 200 ids
  // (paradoja del cumpleaños). Dos jobs con el mismo id corrompen la cola.
  const N = 5000;
  const ids = new Set(Array.from({ length: N }, () => nid()));
  assert.equal(ids.size, N, 'no puede haber ni una colisión');
});

test('nid: respeta el prefijo y mantiene longitud fija', () => {
  assert.ok(nid('p').startsWith('p'));
  assert.equal(nid('j').length, nid('j').length);
});

test('preview: primera línea, truncada', () => {
  assert.equal(preview('una linea\notra'), 'una linea');
  assert.equal(preview('x'.repeat(60), 10).length, 10);
  assert.ok(preview('x'.repeat(60), 10).endsWith('…'));
  assert.equal(preview(undefined), '');          // no revienta con prompt vacío
});

// --- resolveDir -------------------------------------------------------------
test('resolveDir: sin valor → fallback', () => {
  assert.equal(resolveDir(null, 'C:/fallback'), 'C:/fallback');
  assert.equal(resolveDir('', 'C:/fallback'), 'C:/fallback');
});

test('resolveDir: alias explícito de projects.json', () => {
  saveProjects({ mialias: 'C:/algun/sitio/MiApp' });
  assert.equal(resolveDir('mialias', 'X'), 'C:/algun/sitio/MiApp');
  assert.equal(resolveDir('MIALIAS', 'X'), 'C:/algun/sitio/MiApp', 'sin distinguir mayúsculas');
});

test('resolveDir: nombre de proyecto = subcarpeta de _base (sin distinguir mayúsculas)', () => {
  const base = path.join(TMP, 'Programas');
  fs.mkdirSync(path.join(base, 'MiApp'), { recursive: true });
  saveProjects({ _base: base });
  assert.equal(resolveDir('miapp', 'X'), base.replace(/\\/g, '\\') + '/MiApp');
});

test('resolveDir: una ruta que EXISTE se acepta tal cual', () => {
  saveProjects({ _base: path.join(TMP, 'Programas') });
  const real = path.join(TMP, 'una-carpeta-de-verdad');
  fs.mkdirSync(real, { recursive: true });
  assert.equal(resolveDir(real, 'X'), real);
});

test('resolveDir: un nombre que no casa con NADA se rechaza (antes se colaba como ruta relativa)', () => {
  // El bug: "--dir kaiprompt", con kaiprompt fuera de _base, se quedaba como la ruta
  // RELATIVA "kaiprompt". El job entonces corre en la carpeta en la que el runner
  // arrancara — y eso no se descubre hasta que ya ha hecho el trabajo donde no debia.
  // Mejor negarse ahora, mientras hay alguien mirando.
  saveProjects({ _base: path.join(TMP, 'Programas'), miapp: 'C:/algun/sitio' });

  assert.throws(() => resolveDir('no-existe-esta-carpeta', 'X'), /no such folder/);
  assert.throws(() => resolveDir('no-existe-esta-carpeta', 'X'), /miapp/, 'y dice qué alias hay');
  assert.throws(() => resolveDir('no-existe-esta-carpeta', 'X'), /kaip projects/, 'y cómo registrarla');
});

// --- importProgramados ------------------------------------------------------
test('importProgramados: importa lo agendado y NO duplica en la 2ª pasada', () => {
  saveQueue([]);
  fs.writeFileSync(path.join(TMP, 'data', 'programados.state.json'), '{"imported":[]}');
  const entry = {
    id: 'p-test-1', prompt: 'corre los tests', target: 'tests', adapter: 'claude',
    when: Date.now() + 3600000, dir: 'C:/proj', permMode: 'acceptEdits', createdAt: Date.now(),
  };
  fs.writeFileSync(path.join(TMP, 'programados.jsonl'), JSON.stringify(entry) + '\n');

  assert.equal(importProgramados(), 1);
  const [j] = loadQueue();
  assert.equal(j.id, 'p-test-1');
  assert.equal(j.dir, 'C:/proj', 'la carpeta se conserva');
  assert.equal(j.permMode, 'acceptEdits', 'el modo de permisos se conserva');
  assert.equal(j.status, 'pending');

  assert.equal(importProgramados(), 0, 'segunda pasada: nada nuevo');
  assert.equal(loadQueue().length, 1, 'no se duplica');
});

test('importProgramados: sin archivo → 0, sin romper', () => {
  fs.rmSync(path.join(TMP, 'programados.jsonl'), { force: true });
  assert.equal(importProgramados(), 0);
});
