import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-offer-'));
process.env.KAIP_HOME = TMP;
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.KAIP_NO_DAEMON = '1';          // un test no deja procesos de fondo vivos

const { loadQueue, saveQueue } = await import('../lib/store.mjs');
const { strip } = await import('../lib/ui.mjs');
const { dismissed } = await import('../lib/cutshort.mjs');
const { applyEffect, initialState, reduce, refresh, render } = await import('../lib/tui.mjs');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIMS = { cols: 100, rows: 30 };
const view = (s) => strip(render(s, DIMS).join('\n'));

const DIR = path.join(TMP, 'FacturaSevi');
fs.mkdirSync(DIR, { recursive: true });

const hit = (over = {}) => ({
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  file: path.join(TMP, 'x.jsonl'),
  dir: DIR,
  at: Date.now() - 12 * 60_000,
  ask: 'falta enchufar el network config',
  resetsAt: null,
  ...over,
});

const withOffer = (hits) => refresh(initialState({ offer: { hits, sel: 0 } }));

// --- el aviso ----------------------------------------------------------------
test('el aviso sale arriba, con proyecto, cuándo y qué se pedía', () => {
  const out = view(withOffer([hit()]));
  assert.match(out, /Parece que una conversación se quedó a medias/);
  assert.match(out, /FacturaSevi/);
  assert.match(out, /hace 12 min/);
  assert.match(out, /falta enchufar el network config/);
  assert.match(out, /¿La termino en cuanto vuelva el cupo\?/);
  assert.match(out, /\[enter\] sí/);
  assert.match(out, /\[esc\] no/);
});

test('sin sesiones a medias, el aviso NO existe', () => {
  const out = view(refresh(initialState()));
  assert.doesNotMatch(out, /a medias/);
  assert.doesNotMatch(out, /\[enter\] sí/);
});

test('es una OFERTA: mostrarla no encola nada', () => {
  saveQueue([]);
  render(withOffer([hit()]), DIMS);
  assert.equal(loadQueue().length, 0, 'nada se encola sin decir que sí');
});

// --- responder ---------------------------------------------------------------
test('enter = sí → encola una continuación prioritaria, y el aviso se va', () => {
  saveQueue([]);
  const h = hit();
  const { state, effect } = reduce(withOffer([h]), 'enter');

  assert.equal(effect.type, 'resume-cut');
  assert.equal(effect.hit.sessionId, h.sessionId);
  assert.equal(state.offer, null, 'contestada: el aviso desaparece');

  applyEffect(effect);
  const [job] = loadQueue();
  assert.equal(job.sessionId, h.sessionId);
  assert.equal(job.continuation, true);
  assert.equal(job.priority, true);
  assert.equal(job.when, null);
});

test('esc = no → la silencia, y no encola nada', () => {
  saveQueue([]);
  const h = hit({ sessionId: 'bbbbbbbb-1111-2222-3333-444444444444' });
  const { state, effect } = reduce(withOffer([h]), 'esc');

  assert.equal(effect.type, 'dismiss-cut');
  assert.equal(state.offer, null);

  applyEffect(effect);
  assert.equal(loadQueue().length, 0, 'decir que no no encola nada');
  assert.equal(dismissed().has(h.sessionId), true, 'y no se vuelve a preguntar');
});

test('con varias, ↑↓ elige y enter solo contesta a la marcada', () => {
  saveQueue([]);
  const a = hit({ sessionId: 'aaaa1111-0000-0000-0000-000000000000', ask: 'la primera' });
  const b = hit({ sessionId: 'bbbb2222-0000-0000-0000-000000000000', ask: 'la segunda' });

  let s = withOffer([a, b]);
  assert.match(view(s), /¿Termino la marcada/);

  s = reduce(s, 'down').state;
  assert.equal(s.offer.sel, 1);

  const { state, effect } = reduce(s, 'enter');
  assert.equal(effect.hit.sessionId, b.sessionId, 'la marcada, no la primera');

  // La otra sigue ofrecida: contestar a una no contesta por las demás.
  assert.equal(state.offer.hits.length, 1);
  assert.equal(state.offer.hits[0].sessionId, a.sessionId);
});

test('el aviso se queda con el teclado: ni "d" ni "x" ni "a" hacen nada', () => {
  const s = withOffer([hit()]);
  for (const key of ['d', 'x', 'a', 'e', 'r', 'D']) {
    const { state, effect } = reduce(s, key);
    assert.equal(effect, null, `"${key}" no debería hacer nada con el aviso arriba`);
    assert.equal(state.offer, s.offer);
  }
});

test('…pero q y ctrl-c siguen saliendo: una pregunta de la que no puedes irte es una trampa', () => {
  const s = withOffer([hit()]);
  assert.equal(reduce(s, 'q').effect.type, 'quit');
  assert.equal(reduce(s, 'ctrl-c').effect.type, 'quit');
});

test('un refresh no resucita un aviso ya contestado', () => {
  const { state } = reduce(withOffer([hit()]), 'esc');
  assert.equal(refresh(state).offer, null, 'se calcula al abrir, no en cada repintado');
});

// --- y NADA de esto sale por CLI ----------------------------------------------
test('sin GUI, kaip se comporta exactamente como antes', () => {
  // `list` es la vista que un ojo despistado esperaría que "avisase" también. No avisa:
  // sin TTY no hay nadie a quien preguntar, y preguntar igualmente es ruido en un log.
  const out = execFileSync(process.execPath, [path.join(ROOT, 'kaip.mjs'), 'list'], {
    env: { ...process.env, KAIP_HOME: TMP, CLAUDE_CONFIG_DIR: path.join(TMP, 'claude') },
    encoding: 'utf8',
  });
  assert.doesNotMatch(out, /a medias/);
  assert.doesNotMatch(out, /vuelva el cupo/);
});
