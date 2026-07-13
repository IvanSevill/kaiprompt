// "¿Se va a lanzar algo?" — la pregunta que la herramienta contestaba MAL.
//
// Todo (el aviso de la GUI, la despedida, la app del movil, lo que imprime "add")
// respondia a otra pregunta: "¿esta el daemon encendido?". No son la misma. Un "kaip run"
// abierto en un terminal procesa la cola exactamente igual que el daemon. Pero cada
// pantalla te decia, en rojo, que no se iba a lanzar nada — mientras se lanzaba.
//
// Eso es peor que un mensaje inutil: es la herramienta mintiendo sobre su propio estado
// mientras hace lo correcto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rst-'));
process.env.KAIP_HOME = TMP;

const { runnerLine, runnerStatus } = await import('../lib/runner-status.mjs');

const LOCK = path.join(TMP, 'data', 'runner.lock');
const takeLock = (pid) => {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid, at: Date.now() }));
};
const dropLock = () => fs.rmSync(LOCK, { force: true });

test('sin nadie: lo agendado NO se va a lanzar, y se dice', () => {
  dropLock();
  const st = runnerStatus();
  assert.equal(st.willFire, false);
  assert.equal(st.kind, null);

  const line = runnerLine(st);
  assert.equal(line.ok, false);
  assert.match(line.text, /NO se lanzar/i);
  assert.match(line.hint, /kaip daemon start/);
});

test('un "run" vivo SI dispara lo agendado (esto era la mentira)', () => {
  // El cerrojo lo tiene un proceso vivo que no es el daemon: es alguien con un run abierto.
  takeLock(process.pid);
  const st = runnerStatus();

  assert.equal(st.willFire, true, 'un run procesa la cola igual que el daemon');
  assert.equal(st.kind, 'run');
  assert.equal(st.pid, process.pid);

  const line = runnerLine(st);
  assert.equal(line.ok, true);
  assert.match(line.text, /run/i);
  dropLock();
});

test('pero un "run" NO sobrevive a que cierres su ventana, y eso hay que decirlo', () => {
  // Es la diferencia que de verdad importa cuando estas a punto de cerrar algo.
  takeLock(process.pid);
  const st = runnerStatus();

  assert.equal(st.durable, false, 'un run muere con su terminal');
  assert.match(runnerLine(st).hint, /cierras|daemon start/i);
  dropLock();
});

test('un cerrojo CADUCADO no cuenta: ese runner murio', () => {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: Date.now() - 10 * 60_000 }));

  assert.equal(runnerStatus().willFire, false);
  dropLock();
});
