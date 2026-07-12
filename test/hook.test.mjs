// El hook /programar: intercepta el prompt, lo agenda y BLOQUEA el turno (exit 2)
// para no gastar tokens. Es la pieza más delicada: si se equivoca, o se come
// prompts normales, o deja de agendar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'programar.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hook-'));
const PROG = path.join(TMP, 'programados.jsonl');

const PASS = 0;    // deja pasar el prompt
const BLOCK = 2;   // bloquea el turno → 0 tokens

// Al programar, el hook levanta el daemon (si no, la hora programada no llegaría a
// nadie). Aquí lo desactivamos: un test no debe dejar procesos sueltos en la máquina.
// Que el daemon se arme de verdad se prueba en daemon.test.mjs.
const ENV = { ...process.env, PROMPTHEUS_HOME: TMP, PROMPTHEUS_NO_DAEMON: '1' };

function hook(input, cwd = 'C:/tmp') {
  fs.rmSync(PROG, { force: true });
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ input, cwd }),
    env: ENV,
    encoding: 'utf8',
  });
  const lines = fs.existsSync(PROG)
    ? fs.readFileSync(PROG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { code: r.status, stderr: r.stderr, entries: lines };
}

test('agenda y bloquea el turno (0 tokens)', () => {
  const r = hook('/programar +2h | corre los tests | tests');
  assert.equal(r.code, BLOCK, 'exit 2 = no llama al modelo');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].prompt, 'corre los tests');
  assert.equal(r.entries[0].target, 'tests');
  assert.ok(r.entries[0].when > Date.now());
  assert.match(r.stderr, /programado/i, 'confirma al usuario');
});

test('un solo /programar escribe UNA sola línea (no duplica)', () => {
  const r = hook('/programar 09:00 | algo | t');
  assert.equal(r.entries.length, 1);
});

test('sin barra también funciona ("programar ...")', () => {
  const r = hook('programar +1h | sin barra');
  assert.equal(r.code, BLOCK);
  assert.equal(r.entries[0].prompt, 'sin barra');
});

test('la 4ª parte elige la carpeta (ruta literal)', () => {
  const r = hook('/programar +1h | x | t | C:/otra/ruta');
  assert.equal(r.entries[0].dir, 'C:/otra/ruta');
});

test('sin 4ª parte usa la carpeta desde la que se escribió', () => {
  const r = hook('/programar +1h | x | t', 'C:/mi/proyecto');
  assert.equal(r.entries[0].dir, 'C:/mi/proyecto');
});

test('un prompt NORMAL pasa de largo y no toca nada', () => {
  const r = hook('¿qué hora es?');
  assert.equal(r.code, PASS, 'exit 0 = el mensaje sigue su curso');
  assert.equal(r.entries.length, 0);
});

test('/programar-prompt NO lo intercepta (es otro comando)', () => {
  const r = hook('/programar-prompt claude list');
  assert.equal(r.code, PASS);
  assert.equal(r.entries.length, 0);
});

test('"programa mi agenda" no se confunde con el comando', () => {
  const r = hook('programa mi agenda de la semana');
  assert.equal(r.code, PASS);
  assert.equal(r.entries.length, 0);
});

test('faltan campos → bloquea y muestra la ayuda (sin agendar)', () => {
  const r = hook('/programar 09:00');
  assert.equal(r.code, BLOCK);
  assert.equal(r.entries.length, 0);
  assert.match(r.stderr, /uso:/i);
});

test('hora inválida → bloquea con error claro (sin agendar)', () => {
  const r = hook('/programar cuandosea | algo');
  assert.equal(r.code, BLOCK);
  assert.equal(r.entries.length, 0);
  assert.match(r.stderr, /no entiendo la hora/i);
});

test('stdin vacío o no-JSON no rompe el hook (deja pasar)', () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: 'no soy json', env: ENV, encoding: 'utf8',
  });
  assert.equal(r.status, PASS);
});

test('al programar avisa de que el daemon queda al mando (no lanza nada ahora)', () => {
  const r = hook('/programar +2h | algo');
  assert.match(r.stderr, /daemon/i, 'el usuario tiene que saber quién lo va a lanzar');
  assert.doesNotMatch(r.stderr, /lanzando|running/i, 'programar no ejecuta');
});
