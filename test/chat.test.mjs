import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Aislar datos (store) y el ~/.claude falso (transcripts) ANTES de importar.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chat-'));
process.env.KAIP_HOME = TMP;
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');

const { nid, saveQueue, saveSessions } = await import('../lib/store.mjs');
const {
  encodeDir, findTranscript, parseTranscript, projectsRoot, renderChat, resolveRef,
} = await import('../lib/chat.mjs');

const DIR = 'C:\\proj\\app';
const SID = 'ff679ec5-531d-4424-aba3-7341b2fcaa38';
const ts = (n) => new Date(Date.UTC(2026, 6, 12, 9, n)).toISOString();

// Un transcript como los de verdad: mezcla turnos con entradas de servicio
// (attachment, queue-operation, mode…) que NO son conversación.
const LINES = [
  { type: 'queue-operation', sessionId: SID },
  { type: 'user', cwd: DIR, timestamp: ts(0), message: { role: 'user', content: 'arregla los tests' } },
  { type: 'attachment', cwd: DIR },
  { type: 'assistant', cwd: DIR, timestamp: ts(1), message: { content: [{ type: 'thinking', thinking: 'pensando…' }] } },
  { type: 'assistant', cwd: DIR, timestamp: ts(2), message: { content: [{ type: 'text', text: 'Voy a mirar el fichero.' }] } },
  { type: 'assistant', cwd: DIR, timestamp: ts(3), message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'app/main.py' } }] } },
  { type: 'user', cwd: DIR, timestamp: ts(4), message: { role: 'user', content: [{ type: 'tool_result', content: 'def main(): ...' }] } },
  { type: 'assistant', cwd: DIR, timestamp: ts(5), message: { content: [{ type: 'text', text: 'Listo: 3 tests en verde.' }] } },
  { type: 'user', cwd: DIR, timestamp: ts(6), isMeta: true, message: { role: 'user', content: 'ruido interno' } },
];

const projDir = path.join(projectsRoot(), encodeDir(DIR));
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, `${SID}.jsonl`), LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');

const job = (over = {}) => ({
  id: nid(), prompt: 'haz algo', target: null, adapter: 'mock', when: null,
  dir: DIR, permMode: null, status: 'done', createdAt: Date.now(),
  sessionId: SID, output: null, ...over,
});

// --- codificación de la carpeta ---------------------------------------------
test('encodeDir: sustituye : \\ / . por guiones (así nombra Claude Code la carpeta)', () => {
  assert.equal(encodeDir('C:\\Users\\x\\.claude\\tools'), 'C--Users-x--claude-tools');
  assert.equal(encodeDir('C:/proj/app'), 'C--proj-app');
});

// --- resolver la referencia --------------------------------------------------
test('resolveRef: un target guardado → su session-id', () => {
  saveQueue([]);
  saveSessions({ fixes: { sessionId: SID, adapter: 'claude', updatedAt: 1 } });
  const r = resolveRef('fixes');
  assert.equal(r.sessionId, SID);
  assert.equal(r.target, 'fixes');
});

test('resolveRef: un id de job → la sesión de ese job', () => {
  saveSessions({});
  const j = job({ target: 'revision' });
  saveQueue([j]);
  const r = resolveRef(j.id);
  assert.equal(r.sessionId, SID);
  assert.equal(r.target, 'revision');
  assert.deepEqual(r.jobs.map((x) => x.id), [j.id], 'y los jobs que usaron esa sesión');
});

test('resolveRef: un session-id suelto vale tal cual', () => {
  saveQueue([]); saveSessions({});
  assert.equal(resolveRef(SID).sessionId, SID);
});

test('resolveRef: job que aún no ha corrido → error claro, no crash', () => {
  const j = job({ status: 'pending', sessionId: null });
  saveQueue([j]);
  assert.throws(() => resolveRef(j.id), /no session yet/);
});

test('resolveRef: sin argumento → uso', () => {
  assert.throws(() => resolveRef(undefined), /usage/);
});

// --- localizar el transcript -------------------------------------------------
test('findTranscript: lo encuentra por la carpeta del job', () => {
  assert.equal(findTranscript(SID, [DIR]), path.join(projDir, `${SID}.jsonl`));
});

test('findTranscript: sin pista de carpeta, barre todos los proyectos', () => {
  assert.equal(findTranscript(SID, []), path.join(projDir, `${SID}.jsonl`));
});

test('findTranscript: sesión inexistente → null (no revienta)', () => {
  assert.equal(findTranscript('no-existe', [DIR]), null);
});

// --- parsear -----------------------------------------------------------------
test('parseTranscript: se queda solo con la conversación real', () => {
  const chat = parseTranscript(path.join(projDir, `${SID}.jsonl`));
  assert.equal(chat.cwd, DIR);
  assert.equal(chat.turns.length, 6, 'fuera queue-operation, attachment y el isMeta');
  assert.ok(chat.turns.every((t) => t.role === 'user' || t.role === 'assistant'));
  assert.equal(chat.first, ts(0));
  assert.equal(chat.last, ts(5));
});

test('parseTranscript: el user es string y el assistant bloques', () => {
  const { turns } = parseTranscript(path.join(projDir, `${SID}.jsonl`));
  assert.deepEqual(turns[0].blocks, [{ type: 'text', text: 'arregla los tests' }]);
  assert.equal(turns[2].blocks[0].type, 'text');
});

test('parseTranscript: marca el eco de una herramienta (no es un turno humano)', () => {
  const { turns } = parseTranscript(path.join(projDir, `${SID}.jsonl`));
  const eco = turns.find((t) => t.role === 'user' && t.toolResult);
  assert.ok(eco, 'el tool_result debe quedar marcado');
  assert.equal(turns[0].toolResult, false, 'el prompt humano no');
});

// --- render ------------------------------------------------------------------
test('renderChat: cabecera con target, sesión, carpeta, turnos y fechas', () => {
  saveQueue([job({ target: 'fixes' })]);
  saveSessions({ fixes: { sessionId: SID, adapter: 'claude', updatedAt: 1 } });
  const out = renderChat('fixes');

  assert.match(out, /chat/);
  assert.match(out, /target\s+fixes/);
  assert.match(out, new RegExp(`session\\s+${SID}`));
  assert.match(out, /folder\s+C:\\proj\\app/);
  assert.match(out, /turns\s+6/);
  assert.match(out, /dates/);
  assert.match(out, /claude --resume/, 'y cómo retomar la conversación');
});

test('renderChat: pinta la conversación y resume los tool_use', () => {
  const out = renderChat('fixes');
  assert.match(out, /❯ arregla los tests/, 'el turno humano');
  assert.match(out, /⏺ Voy a mirar el fichero\./, 'la respuesta');
  assert.match(out, /Read\(app\/main\.py\)/, 'la herramienta, resumida');
  assert.doesNotMatch(out, /pensando…/, 'el thinking no sale sin --full');
  assert.doesNotMatch(out, /def main/, 'ni el eco del tool_result');
});

test('renderChat --full: saca también thinking y resultados de herramienta', () => {
  const out = renderChat('fixes', { full: true });
  assert.match(out, /pensando…/);
  assert.match(out, /def main/);
});

test('renderChat --last: limita los turnos mostrados', () => {
  const out = renderChat('fixes', { last: 1 });
  assert.match(out, /Listo: 3 tests en verde\./, 'el último turno sí');
  assert.doesNotMatch(out, /arregla los tests/, 'los anteriores no');
  assert.match(out, /showing the last 1/);
});

test('renderChat --raw: devuelve las líneas del transcript tal cual', () => {
  const out = renderChat('fixes', { raw: true, last: 2 });
  for (const line of out.split('\n')) JSON.parse(line);           // debe ser JSONL válido
  assert.doesNotMatch(out, /╭/, 'sin adornos');
});

test('renderChat: sin transcript → error claro (no crash)', () => {
  saveQueue([]); saveSessions({});
  assert.throws(() => renderChat('sesion-fantasma'), /no transcript found/);
});

test('renderChat: sesión sin mensajes no revienta', () => {
  const vacio = 'aaaaaaaa-0000-0000-0000-000000000000';
  fs.writeFileSync(path.join(projDir, `${vacio}.jsonl`),
    JSON.stringify({ type: 'ai-title', aiTitle: 'x' }) + '\n');
  assert.match(renderChat(vacio), /no messages yet/);
});

// --- entrar EN la conversación (tecla "y" de la GUI) -------------------------
// Leer el transcript te dice qué pasó. Esto te deja retomar el hilo y seguir hablando,
// en un Claude Code de verdad.

test('resumeTarget: da la sesión Y la carpeta (sin la carpeta, --resume no la encuentra)', async () => {
  const { resumeTarget, resumeCommand } = await import('../lib/chat.mjs');
  saveSessions({ fixes: { sessionId: 'sess-1', adapter: 'claude', updatedAt: 1 } });
  saveQueue([{
    id: 'j1', target: 'fixes', sessionId: 'sess-1', dir: 'C:/proyectos/miapp',
    status: 'done', adapter: 'claude', prompt: 'x', createdAt: 1,
  }]);

  const r = resumeTarget('fixes');
  assert.equal(r.sessionId, 'sess-1');
  assert.equal(r.dir, 'C:/proyectos/miapp', 'las sesiones de Claude Code son POR CARPETA');
  assert.match(resumeCommand(r), /cd "C:\/proyectos\/miapp" && claude --resume sess-1/);
});

test('resumeTarget: por id de job también', async () => {
  const { resumeTarget } = await import('../lib/chat.mjs');
  saveQueue([{
    id: 'j2', target: null, sessionId: 'sess-2', dir: 'C:/otra',
    status: 'done', adapter: 'claude', prompt: 'x', createdAt: 1,
  }]);
  assert.equal(resumeTarget('j2').sessionId, 'sess-2');
});

test('resumeTarget: sin carpeta conocida, error CLARO (no un --resume que no encuentra nada)', async () => {
  const { resumeTarget } = await import('../lib/chat.mjs');
  saveSessions({ huerfana: { sessionId: 'sess-3', adapter: 'claude', updatedAt: 1 } });
  saveQueue([]);
  assert.throws(() => resumeTarget('huerfana'), /which folder/i);
});
