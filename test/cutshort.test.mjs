import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Aislar datos (store) y el ~/.claude falso (transcripts) ANTES de importar.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cut-'));
process.env.KAIP_HOME = TMP;
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');

const { loadQueue, saveQueue, saveSessions, writeJSON } = await import('../lib/store.mjs');
const { encodeDir, projectsRoot } = await import('../lib/chat.mjs');
const { CONTINUATION, isContinuation } = await import('../lib/prompt.mjs');
const {
  dismiss, dismissed, findCutShort, isQuotaError, MAX_AGE_MS, readCutShort, resumeCutShort,
} = await import('../lib/cutshort.mjs');

// Una carpeta que EXISTE: resumeCutShort y `resumable` exigen que siga ahí, porque una
// sesión de Claude Code vive en su carpeta y reanudarla desde otra no encuentra nada.
const DIR = path.join(TMP, 'proyecto');
fs.mkdirSync(DIR, { recursive: true });

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const ts = (minsAgo) => new Date(NOW - minsAgo * 60_000).toISOString();

const user = (text, minsAgo) => ({
  type: 'user', cwd: DIR, timestamp: ts(minsAgo), message: { role: 'user', content: text },
});
const bot = (text, minsAgo) => ({
  type: 'assistant', cwd: DIR, timestamp: ts(minsAgo), message: { content: [{ type: 'text', text }] },
});
/** Lo que Claude Code escribe cuando se acaba el cupo: un `assistant` con isApiErrorMessage. */
const quotaError = (minsAgo, text = "You've hit your session limit · resets 1:30pm (Europe/Madrid)") => ({
  type: 'assistant', cwd: DIR, timestamp: ts(minsAgo), isApiErrorMessage: true,
  message: { content: [{ type: 'text', text }] },
});

// El ruido de verdad: tras el error de cupo el transcript SIGUE creciendo con entradas de
// servicio. Si miras la última LÍNEA en vez del último turno, no encuentras nada.
const bookkeeping = () => [
  { type: 'last-prompt', lastPrompt: 'lo que fuera', cwd: DIR },
  { type: 'queue-operation', cwd: DIR },
  { type: 'ai-title', cwd: DIR },
  { type: 'permission-mode', cwd: DIR },
];

let n = 0;
/** Escribe un transcript de mentira y devuelve su session id. */
function transcript(entries, { dir = DIR, mtime = NOW } = {}) {
  const sid = `0000000${++n}-dead-beef-cafe-000000000000`;
  const folder = path.join(projectsRoot(), encodeDir(dir));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${sid}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return { sid, file };
}

const reset = () => {
  saveQueue([]); saveSessions({}); writeJSON(path.join(TMP, 'data', 'cutshort.json'), { sessions: [] });
};

// --- la señal ----------------------------------------------------------------
test('una sesión cortada por cupo SE DETECTA', () => {
  const { file } = transcript([
    user('arregla el network config', 20),
    bot('Voy a mirarlo.', 19),
    user('falta enchufar el network config', 12),
    quotaError(12),
    ...bookkeeping(),                     // ← el error NO es la última línea del fichero
  ]);

  const hit = readCutShort(file);
  assert.ok(hit, 'debería detectarla');
  assert.equal(hit.dir, DIR);
  // El preview es la petición que nadie contestó: es lo único que dice qué faltaba.
  assert.equal(hit.ask, 'falta enchufar el network config');
});

test('una conversación TERMINADA no se detecta', () => {
  const { file } = transcript([
    user('arregla los tests', 30),
    bot('Listo: 3 tests en verde.', 29),
  ]);
  assert.equal(readCutShort(file), null);
});

test('el error de cupo A MITAD, con el usuario volviendo después, NO cuenta', () => {
  // Se quedó sin cupo, esperó, volvió y lo terminó. Ya no hay nada que ofrecer.
  const { file } = transcript([
    user('haz algo', 300),
    quotaError(299),
    ...bookkeeping(),
    user('continúa', 20),
    bot('Hecho.', 19),
  ]);
  assert.equal(readCutShort(file), null);
});

test('acabar en tool_result NO es señal de cupo (es cerrar la terminal)', () => {
  // 45 de los 180 transcripts reales acaban así. Ofrecerlos todos sería ofrecer todo.
  const { file } = transcript([
    user('lee el fichero', 10),
    { type: 'assistant', cwd: DIR, timestamp: ts(9), message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
    { type: 'user', cwd: DIR, timestamp: ts(9), message: { role: 'user', content: [{ type: 'tool_result', content: 'def main()' }] } },
  ]);
  assert.equal(readCutShort(file), null);
});

test('otros errores de API (login, 429) NO son falta de cupo', () => {
  for (const text of [
    'Please run /login · API Error: 401 Invalid authentication credentials',
    'Your organization has disabled Claude subscription access for Claude Code',
    "API Error: Request rejected (429) · This request would exceed your account's rate limit.",
  ]) {
    const { file } = transcript([user('haz algo', 10), quotaError(9, text)]);
    assert.equal(readCutShort(file), null, `no debería detectar: ${text}`);
  }
});

test('CLAUDE HABLANDO de límites no es un límite', () => {
  // El fallo que un grep de "session limit" cometería: este repo entero habla de cupos.
  // Sin isApiErrorMessage, un assistant que MENCIONA el límite es solo conversación.
  const { file } = transcript([
    user('¿qué hace quota.mjs?', 10),
    bot("Detecta cuando has hit your session limit y reencola el job.", 9),
  ]);
  assert.equal(readCutShort(file), null);
});

test('isQuotaError exige el flag Y el texto Y ser del assistant', () => {
  const q = { role: 'assistant', apiError: true, blocks: [{ type: 'text', text: "You've hit your session limit · resets 3am" }] };
  assert.equal(isQuotaError(q), true);
  assert.equal(isQuotaError({ ...q, apiError: false }), false, 'sin el flag: es solo texto');
  assert.equal(isQuotaError({ ...q, role: 'user' }), false, 'del usuario: es una queja, no un corte');
  assert.equal(isQuotaError({ ...q, blocks: [{ type: 'text', text: 'API Error: 500' }] }), false);
  assert.equal(isQuotaError(undefined), false);
});

test('el límite SEMANAL también corta', () => {
  const { file } = transcript([
    user('sigue', 10),
    quotaError(9, "You've hit your weekly limit · resets Thursday at 9am"),
  ]);
  assert.ok(readCutShort(file));
});

// --- a quién NO se le ofrece ---------------------------------------------------
test('una sesión que lanzó KAIP no se ofrece (requeue ya la reanuda)', () => {
  reset();
  const { sid } = transcript([user('haz algo', 10), quotaError(9)]);

  assert.equal(findCutShort({ now: NOW }).filter((h) => h.sessionId === sid).length, 1);

  // Ahora hay un job de kaip con esa sesión: ofrecerla sería encolar el trabajo dos veces
  // y reanudar la misma sesión desde dos sitios.
  saveQueue([{ id: 'j1', status: 'done', sessionId: sid, prompt: 'x' }]);
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);

  // Y tampoco si solo está atada a un target en sessions.json.
  reset();
  saveSessions({ fixes: { sessionId: sid, adapter: 'claude' } });
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);
});

test('una sesión VIEJA no se ofrece', () => {
  reset();
  const old = NOW - 30 * 60 * 60 * 1000;                 // 30 h: más de las 24 del umbral
  const { sid } = transcript([
    { type: 'user', cwd: DIR, timestamp: new Date(old).toISOString(), message: { role: 'user', content: 'haz algo' } },
    { type: 'assistant', cwd: DIR, timestamp: new Date(old).toISOString(), isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: "You've hit your session limit · resets 3am" }] } },
  ], { mtime: old });

  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);
  // …pero la señal sigue ahí: lo que la descarta es la edad, no la detección.
  assert.equal(findCutShort({ now: NOW, maxAgeMs: 48 * 60 * 60 * 1000 }).some((h) => h.sessionId === sid), true);
  assert.equal(MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

test('decir que NO la silencia PARA SIEMPRE', () => {
  reset();
  const { sid } = transcript([user('haz algo', 10), quotaError(9)]);
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), true);

  dismiss(sid);
  assert.equal(dismissed().has(sid), true);
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);

  // Y sobrevive a releer el estado de disco: no es memoria de esta sesión de GUI.
  assert.equal(dismissed().has(sid), true);
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);
});

test('las más recientes primero', () => {
  reset();
  const a = transcript([user('vieja', 600), quotaError(600)]);
  const b = transcript([user('nueva', 5), quotaError(5)]);
  const found = findCutShort({ now: NOW }).map((h) => h.sessionId);
  assert.ok(found.indexOf(b.sid) < found.indexOf(a.sid));
});

// --- aceptar: el puente --------------------------------------------------------
test('aceptar la encola como CONTINUACIÓN y LA PRIMERA', () => {
  reset();
  const { sid } = transcript([user('falta el network config', 8), quotaError(8)]);
  const hit = findCutShort({ now: NOW }).find((h) => h.sessionId === sid);

  const job = resumeCutShort(hit);

  assert.equal(job.sessionId, sid, 'la misma sesión');
  assert.equal(job.continuation, true);
  assert.equal(job.priority, true, 'va la primera');
  assert.equal(job.when, null, 'sin hora: en cuanto haya cupo');
  assert.equal(job.dir, DIR);

  // Reusa el mecanismo que ya existía: isContinuation → executeJob manda CONTINUATION,
  // no el prompt. No hay un segundo mecanismo de reanudación.
  assert.equal(isContinuation(job), true);
  assert.equal(job.prompt, CONTINUATION);

  assert.equal(loadQueue().length, 1);
});

test('una vez encolada ya no se vuelve a ofrecer', () => {
  reset();
  const { sid } = transcript([user('haz algo', 8), quotaError(8)]);
  resumeCutShort(findCutShort({ now: NOW }).find((h) => h.sessionId === sid));
  assert.equal(findCutShort({ now: NOW }).some((h) => h.sessionId === sid), false);
});

test('no se reanuda una conversación cuya carpeta ya no existe', () => {
  reset();
  const gone = path.join(TMP, 'borrado');
  fs.mkdirSync(gone, { recursive: true });
  const { file } = transcript([
    { type: 'user', cwd: gone, timestamp: ts(5), message: { role: 'user', content: 'haz algo' } },
    { type: 'assistant', cwd: gone, timestamp: ts(5), isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: "You've hit your session limit · resets 3am" }] } },
  ], { dir: gone });
  const hit = readCutShort(file);
  fs.rmSync(gone, { recursive: true, force: true });

  assert.throws(() => resumeCutShort(hit), /carpeta|folder/i);
});

test('sin ~/.claude/projects no explota: simplemente no hay nada que ofrecer', () => {
  reset();
  assert.deepEqual(findCutShort({ now: NOW, root: path.join(TMP, 'no-existe') }), []);
});
