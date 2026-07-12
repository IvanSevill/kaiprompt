import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-edit-'));
process.env.PROGRAM_PROMPT_HOME = TMP;
const { loadQueue, nid, saveProjects, saveQueue } = await import('../lib/store.mjs');
const { applyEdits, editJob } = await import('../lib/edit.mjs');

const job = (over = {}) => ({
  id: nid(), prompt: 'haz algo', target: null, adapter: 'mock', when: null,
  dir: 'C:/vieja', permMode: null, status: 'pending', createdAt: Date.now(),
  sessionId: null, output: null, ...over,
});

const only = (over) => { const j = job(over); saveQueue([j]); return j; };

// --- qué se puede cambiar ----------------------------------------------------
test('edit: cambia el prompt y lo persiste', () => {
  const j = only({});
  const { changes } = editJob(j.id, { prompt: 'otra cosa' });
  assert.deepEqual(changes, ['prompt']);
  assert.equal(loadQueue()[0].prompt, 'otra cosa');
});

test('edit: --at reprograma (reutiliza parseWhen)', () => {
  const j = only({});
  const { job: n } = editJob(j.id, { at: '+2h' });
  const esperado = Date.now() + 2 * 3600_000;
  assert.ok(Math.abs(n.when - esperado) < 5000, 'debe quedar dentro de 2h');
  assert.ok(loadQueue()[0].when, 'y guardado');
});

test('edit: --at none lo devuelve a secuencial', () => {
  const j = only({ when: Date.now() + 3600_000 });
  const { job: n } = editJob(j.id, { at: 'none' });
  assert.equal(n.when, null);
});

test('edit: --dir resuelve alias/proyecto igual que add', () => {
  saveProjects({ mifac: 'C:/algun/sitio/FacturaSevi' });
  const j = only({});
  const { job: n } = editJob(j.id, { dir: 'mifac' });
  assert.equal(n.dir, 'C:/algun/sitio/FacturaSevi');
});

test('edit: varios flags a la vez', () => {
  const j = only({});
  const { job: n, changes } = editJob(j.id, { target: 'fixes', perm: 'acceptEdits', adapter: 'claude' });
  assert.equal(n.target, 'fixes');
  assert.equal(n.permMode, 'acceptEdits');
  assert.equal(n.adapter, 'claude');
  assert.equal(changes.length, 3);
});

test('edit: --target none quita el target', () => {
  const j = only({ target: 'fixes' });
  assert.equal(editJob(j.id, { target: 'none' }).job.target, null);
});

test('edit: no toca lo que no se pide', () => {
  const j = only({ target: 'fixes', when: 123, permMode: 'acceptEdits' });
  const { job: n } = editJob(j.id, { prompt: 'nuevo' });
  assert.equal(n.target, 'fixes');
  assert.equal(n.when, 123);
  assert.equal(n.permMode, 'acceptEdits');
  assert.equal(n.id, j.id, 'y el id se mantiene');
});

test('edit: solo edita ese job, el resto de la cola queda intacto', () => {
  const a = job(), b = job();
  saveQueue([a, b]);
  editJob(b.id, { prompt: 'cambiado' });
  const q = loadQueue();
  assert.equal(q.length, 2);
  assert.equal(q.find((x) => x.id === a.id).prompt, 'haz algo');
  assert.equal(q.find((x) => x.id === b.id).prompt, 'cambiado');
});

// --- lo que debe rechazar ----------------------------------------------------
test('edit: un job done NO se edita (reescribir el pasado corrompe la cola)', () => {
  const j = only({ status: 'done' });
  assert.throws(() => editJob(j.id, { prompt: 'x' }), /is done: only pending/);
  assert.equal(loadQueue()[0].prompt, 'haz algo', 'no ha cambiado nada');
});

test('edit: un job running tampoco (ya está en manos del adaptador)', () => {
  const j = only({ status: 'running' });
  assert.throws(() => editJob(j.id, { prompt: 'x' }), /is running: only pending/);
});

test('edit: id inexistente → error claro', () => {
  saveQueue([]);
  assert.throws(() => editJob('nope', { prompt: 'x' }), /no job found/);
});

test('edit: sin flags → dice qué se puede cambiar', () => {
  const j = only({});
  assert.throws(() => editJob(j.id, {}), /nothing to change/);
});

test('edit: adaptador inexistente → error (si no, el job fallaría al lanzarse)', () => {
  const j = only({});
  assert.throws(() => editJob(j.id, { adapter: 'no-existe' }), /unknown adapter/);
  assert.equal(loadQueue()[0].adapter, 'mock', 'y la cola sigue sana');
});

test('edit: --perm solo acepta modos conocidos', () => {
  const j = only({});
  assert.throws(() => editJob(j.id, { perm: 'barra-libre' }), /unknown --perm/);
});

test('edit: --at con una hora que no se entiende → error de parseWhen', () => {
  const j = only({});
  assert.throws(() => editJob(j.id, { at: 'a las tantas' }), /can't parse time/);
});

test('edit: un flag sin valor no borra en silencio', () => {
  const j = only({ target: 'fixes' });
  assert.throws(() => editJob(j.id, { target: true }), /--target needs a value/);
  assert.equal(loadQueue()[0].target, 'fixes');
});

test('edit: prompt vacío se rechaza', () => {
  const j = only({});
  assert.throws(() => editJob(j.id, { prompt: '   ' }), /--prompt cannot be empty/);
});

// --- lo agendado desde el chat ----------------------------------------------
test('edit: se puede editar algo programado con /programar (importa antes de buscar)', () => {
  saveQueue([]);
  fs.writeFileSync(path.join(TMP, 'data', 'programados.state.json'), '{"imported":[]}');
  const entry = {
    id: 'p-edit-1', prompt: 'lo de siempre', target: null, adapter: 'mock',
    when: Date.now() + 3600_000, dir: 'C:/proj', permMode: null, createdAt: Date.now(),
  };
  fs.writeFileSync(path.join(TMP, 'programados.jsonl'), JSON.stringify(entry) + '\n');

  const { job: n } = editJob('p-edit-1', { prompt: 'mejor esto' });
  assert.equal(n.prompt, 'mejor esto');
  assert.equal(loadQueue().find((x) => x.id === 'p-edit-1').prompt, 'mejor esto');

  fs.rmSync(path.join(TMP, 'programados.jsonl'), { force: true });
});

// --- applyEdits (puro) -------------------------------------------------------
test('applyEdits: no muta el job original', () => {
  const j = job({ prompt: 'original' });
  const { job: n } = applyEdits(j, { prompt: 'copia' });
  assert.equal(j.prompt, 'original');
  assert.equal(n.prompt, 'copia');
});
