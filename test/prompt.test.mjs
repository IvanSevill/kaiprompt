// El prompt puede ser el texto, o un ENLACE a un archivo que lo contiene.
//
// La diferencia está en CUÁNDO se lee. --file copia el contenido al encolar (una foto).
// --from guarda la RUTA, y el archivo se lee al LANZAR: así puedes seguir puliendo el
// prompt hasta el segundo antes de que salga, y lo que diga el archivo a las 03:00 es lo
// que se manda. Eso es lo que hace útil a la skill /prompt: escribe un archivo, y tú
// encolas el archivo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-prompt-'));
process.env.KAIP_HOME = TMP;
const { loadQueue, saveQueue } = await import('../lib/store.mjs');
const { addJob } = await import('../lib/queue.mjs');
const { editJob } = await import('../lib/edit.mjs');
const { executeJob } = await import('../lib/runner.mjs');
const { isLinked, jobPreview, linkPrompt, resolvePrompt } = await import('../lib/prompt.mjs');

const write = (name, body) => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, body);
  return f;
};

// --- enlazar ----------------------------------------------------------------
test('addJob --from: guarda la RUTA, no el texto', () => {
  saveQueue([]);
  const f = write('p1.md', 'haz los tests');
  const j = addJob({ from: f, adapter: 'mock' });

  assert.equal(j.promptFile, path.resolve(f));
  assert.equal(j.prompt, null, 'el texto NO se copia: se lee al lanzar');
  assert.ok(isLinked(j));
});

test('addJob --from: una ruta que no existe se rechaza AL ENCOLAR (no a las 3am)', () => {
  assert.throws(() => addJob({ from: path.join(TMP, 'no-existe.md') }), /no such prompt file/);
});

test('addJob --from: un archivo vacío se rechaza al encolar', () => {
  const f = write('vacio.md', '   \n  ');
  assert.throws(() => addJob({ from: f }), /empty/i);
});

test('linkPrompt: devuelve ruta ABSOLUTA (el job puede correr desde otra carpeta)', () => {
  const f = write('abs.md', 'x');
  assert.ok(path.isAbsolute(linkPrompt(f)));
});

// --- lo importante: se lee al LANZAR ----------------------------------------
test('el archivo se lee al EJECUTAR, no al encolar: editarlo después cambia lo que se manda', async () => {
  saveQueue([]);
  const f = write('vivo.md', 'version vieja');
  const j = addJob({ from: f, adapter: 'mock' });

  fs.writeFileSync(f, 'VERSION NUEVA');          // lo pules justo antes de que salga

  assert.equal(resolvePrompt(j), 'VERSION NUEVA', 'manda lo que dice el archivo AHORA');

  await executeJob(j);
  assert.equal(j.status, 'done');
  const salida = fs.readFileSync(path.join(TMP, 'out', `${j.id}.txt`), 'utf8');
  assert.match(salida, /VERSION NUEVA/, 'y es lo que le llegó de verdad al adaptador');
});

test('un prompt normal (texto pegado) sigue funcionando igual', async () => {
  saveQueue([]);
  const j = addJob({ prompt: 'texto de toda la vida', adapter: 'mock' });
  assert.equal(isLinked(j), false);
  assert.equal(resolvePrompt(j), 'texto de toda la vida');
  await executeJob(j);
  assert.equal(j.status, 'done');
});

// --- lo que NO puede pasar nunca --------------------------------------------
// Un lanzamiento desatendido corre con autonomía total en un proyecto de verdad.
// Mandarle un prompt en blanco y dejar que improvise es lo peor que podría hacer
// esta herramienta. Así que si el archivo no está, NO se lanza.

test('si el archivo DESAPARECE antes de lanzar, no se manda nada: error claro', async () => {
  saveQueue([]);
  const f = write('se-borra.md', 'algo');
  const j = addJob({ from: f, adapter: 'mock' });
  fs.rmSync(f);

  await assert.rejects(() => executeJob(j), /prompt file is gone/i);
  assert.ok(!fs.existsSync(path.join(TMP, 'out', `${j.id}.txt`)), 'no llega a ejecutar nada');
});

test('si el archivo se queda VACÍO antes de lanzar, tampoco se manda nada', async () => {
  saveQueue([]);
  const f = write('se-vacia.md', 'algo');
  const j = addJob({ from: f, adapter: 'mock' });
  fs.writeFileSync(f, '');

  await assert.rejects(() => executeJob(j), /empty/i);
});

test('el error dice CÓMO arreglarlo (reapuntar el job a otro archivo)', async () => {
  const f = write('tmp2.md', 'algo');
  const j = addJob({ from: f, adapter: 'mock' });
  fs.rmSync(f);
  await assert.rejects(() => executeJob(j), /kaip edit/);
});

// --- verlo en la cola --------------------------------------------------------
test('jobPreview: para un job enlazado enseña lo que dice el archivo AHORA, marcado con ↪', () => {
  const f = write('prev.md', 'primera linea\nsegunda');
  const j = addJob({ from: f, adapter: 'mock' });
  assert.match(jobPreview(j), /^↪ primera linea/);

  fs.writeFileSync(f, 'ha cambiado');
  assert.match(jobPreview(j), /ha cambiado/, 'no se queda con una copia rancia');
});

test('jobPreview: un archivo que ya no está se ve como AVISO en la lista (te enteras antes)', () => {
  const f = write('roto.md', 'x');
  const j = addJob({ from: f, adapter: 'mock' });
  fs.rmSync(f);
  assert.match(jobPreview(j), /⚠.*ilegible/);
});

// --- editar ------------------------------------------------------------------
test('edit --from: reapunta un job a otro archivo', () => {
  saveQueue([]);
  const a = write('a.md', 'archivo A');
  const b = write('b.md', 'archivo B');
  const j = addJob({ from: a, adapter: 'mock' });

  const { job } = editJob(j.id, { from: b });
  assert.equal(job.promptFile, path.resolve(b));
  assert.equal(resolvePrompt(job), 'archivo B');
});

test('edit --prompt sobre un job enlazado ROMPE el enlace (si no, no sabrías cuál manda)', () => {
  saveQueue([]);
  const f = write('c.md', 'del archivo');
  const j = addJob({ from: f, adapter: 'mock' });

  const { job } = editJob(j.id, { prompt: 'ahora texto a pelo' });
  assert.equal(job.promptFile, null, 'ya no está enlazado');
  assert.equal(job.prompt, 'ahora texto a pelo');
  assert.equal(resolvePrompt(job), 'ahora texto a pelo');
});

test('edit --from apuntando a algo que no existe se rechaza (la cola no se corrompe)', () => {
  saveQueue([]);
  const f = write('d.md', 'x');
  const j = addJob({ from: f, adapter: 'mock' });
  assert.throws(() => editJob(j.id, { from: path.join(TMP, 'fantasma.md') }), /no such prompt file/);
  assert.equal(loadQueue()[0].promptFile, path.resolve(f), 'el job se queda como estaba');
});
