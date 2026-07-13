// Lo que pinta el runner. Estado dentro, líneas fuera: un frame se puede dibujar siempre,
// sin consecuencias.
//
// Aquí vive la regresión de la tecla "i" (ver el prompt entero). jobCard leía job.prompt,
// pero un job encolado con --from guarda la RUTA, no el texto: su prompt es null. Así que
// wrap(null) y trunc(null) devolvían vacío en las DOS ramas —plegada y expandida— y la
// tecla parecía muerta. No había ni un test de frames: por eso llegó hasta el usuario.
//
// La regla, y es la misma en todas partes: el prompt de un job se lee con resolvePrompt(),
// que es lo que hace el lanzamiento. Lo que enseña la tarjeta tiene que ser lo que se manda.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-frames-'));
process.env.KAIP_HOME = TMP;

const { saveQueue } = await import('../lib/store.mjs');
const { addJob } = await import('../lib/queue.mjs');
const { clockFrame, runningFrame } = await import('../lib/frames.mjs');
const { strip } = await import('../lib/ui.mjs');

// Sin TTY, size() cae a 80x24; forzamos algo cómodo para que la caja no recorte.
process.stdout.columns = 100;
process.stdout.rows = 40;

const texto = (lines) => strip(lines.join('\n'));
const card = (job, view = {}) => texto(runningFrame(job, [], Date.now(), 0, view));

const promptFile = (nombre, contenido) => {
  const f = path.join(TMP, nombre);
  fs.writeFileSync(f, contenido);
  return f;
};

// --- un job normal (el texto vive en la cola) --------------------------------
test('plegado: una línea del prompt, y la pista dice cuántas hay', () => {
  saveQueue([]);
  const job = addJob({ prompt: 'arregla los tests\ny luego el README', adapter: 'mock' });

  const out = card(job);
  assert.match(out, /arregla los tests/);
  assert.match(out, /i: full prompt · 2 líneas/, 'plegado hay que avisar de que hay más detrás');
});

test('plegado: un prompt de una sola línea lo dice en singular', () => {
  saveQueue([]);
  const job = addJob({ prompt: 'corre los tests', adapter: 'mock' });
  assert.match(card(job), /i: full prompt · 1 línea\b/);
});

test('expandido: sale el prompt ENTERO, no solo la primera línea', () => {
  saveQueue([]);
  const job = addJob({ prompt: 'primera línea\nsegunda línea\ntercera línea', adapter: 'mock' });

  const out = card(job, { expanded: true });
  assert.match(out, /primera línea/);
  assert.match(out, /segunda línea/, 'esto es justo lo que la tecla "i" existe para enseñar');
  assert.match(out, /tercera línea/);
  assert.match(out, /i: collapse/);
});

// --- LA REGRESIÓN: un job con --from (prompt: null) --------------------------
test('--from, plegado: enseña el texto del ARCHIVO, no un hueco', () => {
  saveQueue([]);
  const f = promptFile('tarea.md', 'refactoriza el runner\ncon calma');
  const job = addJob({ from: f, adapter: 'mock' });

  assert.equal(job.prompt, null, 'un job --from guarda la ruta, no el texto (esa era la trampa)');

  const out = card(job);
  assert.match(out, /refactoriza el runner/, 'la tarjeta leía job.prompt (null) y salía vacía');
  assert.match(out, /tarea\.md/, 'y si viene de un archivo, se dice de cuál');
  assert.match(out, /2 líneas/);
});

test('--from, expandido: el prompt entero del archivo', () => {
  saveQueue([]);
  const f = promptFile('largo.md', 'uno\ndos\ntres\ncuatro');
  const job = addJob({ from: f, adapter: 'mock' });

  const out = card(job, { expanded: true });
  for (const l of ['uno', 'dos', 'tres', 'cuatro']) {
    assert.match(out, new RegExp(`\\b${l}\\b`), `falta "${l}": la tecla "i" no enseña nada`);
  }
});

test('--from: lo que enseña la tarjeta es lo que dice el archivo AHORA', () => {
  // El archivo se lee al lanzar, no al encolar: puedes seguir puliéndolo. La tarjeta tiene
  // que ir a la misma fuente, o enseñaría una copia vieja de lo que se va a mandar.
  saveQueue([]);
  const f = promptFile('vivo.md', 'versión vieja');
  const job = addJob({ from: f, adapter: 'mock' });

  fs.writeFileSync(f, 'versión NUEVA');

  const out = card(job, { expanded: true });
  assert.match(out, /versión NUEVA/);
  assert.doesNotMatch(out, /versión vieja/);
});

// --- el archivo se rompe: avisar, no reventar --------------------------------
test('--from con el archivo borrado: pinta el aviso y NO tumba el runner', () => {
  // resolvePrompt LANZA cuando el archivo no está, y eso es deliberado: un lanzamiento
  // desatendido no puede recibir un prompt en blanco e improvisar (test/prompt.test.mjs).
  // Pero esto es un frame, solo pinta: si la excepción subiera, se llevaría por delante al
  // runner en mitad de una tanda.
  saveQueue([]);
  const f = promptFile('efimero.md', 'esto va a desaparecer');
  const job = addJob({ from: f, adapter: 'mock' });
  fs.rmSync(f);

  let out;
  assert.doesNotThrow(() => { out = card(job); }, 'el frame no puede propagar la excepción');
  assert.match(out, /⚠/);
  assert.match(out, /prompt file is gone|efimero\.md/i, 'y hay que decir cuál falta');

  assert.doesNotThrow(() => card(job, { expanded: true }), 'expandido tampoco');
});

test('--from con el archivo vacío: mismo aviso (un prompt en blanco no se lanza)', () => {
  saveQueue([]);
  const f = promptFile('vacio.md', 'algo, para poder encolarlo');
  const job = addJob({ from: f, adapter: 'mock' });
  fs.writeFileSync(f, '   \n  ');

  const out = card(job);
  assert.match(out, /⚠/);
  assert.match(out, /empty|vacio\.md/i);
});

// --- prompts largos ----------------------------------------------------------
test('expandido: si el prompt no cabe, dice cuántas líneas se quedan fuera', () => {
  // Cortar en silencio por la línea 20 es como acabas convencido de haber pedido algo que
  // en realidad nunca pediste.
  saveQueue([]);
  const job = addJob({ prompt: Array.from({ length: 50 }, (_, i) => `línea ${i + 1}`).join('\n'), adapter: 'mock' });

  const out = card(job, { expanded: true });
  assert.match(out, /línea 1\b/);
  assert.match(out, /\+\d+ líneas/, 'hay que decir cuánto queda fuera, no cortar a la brava');
});

// --- la otra pantalla que usa la misma tarjeta -------------------------------
test('el reloj (job agendado) usa la misma tarjeta: también enseña el archivo', () => {
  saveQueue([]);
  const f = promptFile('agendado.md', 'lo de las 3am');
  const job = addJob({ from: f, at: '+2h', adapter: 'mock' });

  const out = texto(clockFrame(job, Date.now() + 7200_000, [job], Date.now(), { expanded: true }));
  assert.match(out, /lo de las 3am/, 'el prompt del job que va a salir tiene que verse');
});
