// El instalador escribe dentro del ~/.claude de alguien, al lado de su configuración.
// La regla que prueba casi todo este archivo: NO PISA NADA. Ni los comandos, ni la nota,
// ni projects.json, ni settings.json (en el que ya no registra nada).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-inst-'));
process.env.KAIP_HOME = TMP;
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');   // un ~/.claude de mentira

const { readJSON } = await import('../lib/store.mjs');
const {
  commandFiles, detectBase, install, noteBody, notePath, posix, shellSnippets, uninstall,
} = await import('../lib/install.mjs');

const ROOT = 'C:/tools/kaiprompt';                          // una instalación de ejemplo
const CLAUDE = path.join(TMP, 'claude');
const settingsFile = path.join(CLAUDE, 'settings.json');
const cmdFile = (n) => path.join(CLAUDE, 'commands', n);
const settings = () => readJSON(settingsFile, {});

const reset = () => {
  fs.rmSync(CLAUDE, { recursive: true, force: true });
  fs.mkdirSync(CLAUDE, { recursive: true });
};

// --- los slash commands -------------------------------------------------------
test('commandFiles: son DOS, y llevan la ruta REAL de instalación', () => {
  const files = commandFiles(ROOT);
  assert.deepEqual(Object.keys(files).sort(), ['kaip-summary.md', 'prompt.md']);

  for (const body of Object.values(files)) {
    assert.match(body, /C:\/tools\/kaiprompt\/kaip\.mjs/, 'apunta al binario que existe');
  }
  assert.match(files['kaip-summary.md'], /C:\/tools\/kaiprompt\/out/);
});

test('commandFiles: llevan front-matter, si no Claude Code no los reconoce', () => {
  for (const body of Object.values(commandFiles(ROOT))) {
    assert.match(body, /^---\n/);
    assert.match(body, /description:/);
  }
});

// --- install / uninstall de verdad, sobre disco -------------------------------
test('install: escribe los comandos, la nota y projects.json', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  const acciones = install({ root, claudeDir: CLAUDE, base: 'C:/mis/proyectos' });

  assert.ok(fs.existsSync(cmdFile('prompt.md')));
  assert.ok(fs.existsSync(cmdFile('kaip-summary.md')));
  assert.ok(fs.existsSync(notePath(CLAUDE)));
  assert.deepEqual(readJSON(path.join(root, 'projects.json'), null), { _base: 'C:/mis/proyectos' });
  assert.ok(acciones.length >= 4, 'y cuenta lo que ha hecho');
});

test('install: NO registra nada en settings.json (ya no hay hook)', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }));

  install({ root, claudeDir: CLAUDE, base: null });

  assert.deepEqual(settings(), { model: 'opus' }, 'settings.json, intacto');
});

test('install: dos veces seguidas no duplica ni cambia nada (idempotente en disco)', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  install({ root, claudeDir: CLAUDE, base: 'C:/x' });

  const antes = fs.readdirSync(path.join(CLAUDE, 'commands')).sort();
  const nota = fs.readFileSync(notePath(CLAUDE), 'utf8');

  install({ root, claudeDir: CLAUDE, base: 'C:/x' });

  assert.deepEqual(fs.readdirSync(path.join(CLAUDE, 'commands')).sort(), antes);
  assert.equal(fs.readFileSync(notePath(CLAUDE), 'utf8'), nota);
});

test('install: NO pisa un slash command que el usuario ya tenía tuneado', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.mkdirSync(path.join(CLAUDE, 'commands'), { recursive: true });
  fs.writeFileSync(cmdFile('prompt.md'), 'el mio, y me ha costado');

  install({ root, claudeDir: CLAUDE, base: null });

  assert.equal(fs.readFileSync(cmdFile('prompt.md'), 'utf8'), 'el mio, y me ha costado');
  assert.ok(fs.existsSync(cmdFile('kaip-summary.md')), 'el que faltaba sí se escribe');
});

test('install: NO pisa un projects.json que ya existía (es dato del usuario)', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ _base: 'C:/lo/mio', alias: 'C:/a' }));

  install({ root, claudeDir: CLAUDE, base: 'C:/otra/cosa' });

  assert.deepEqual(readJSON(path.join(root, 'projects.json'), null), { _base: 'C:/lo/mio', alias: 'C:/a' });
});

test('install: sin carpeta base, projects.json se crea vacío (no revienta)', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  install({ root, claudeDir: CLAUDE, base: null });
  assert.deepEqual(readJSON(path.join(root, 'projects.json'), null), {});
});

test('uninstall: revierte los comandos y la nota, y NO toca los datos', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }));
  install({ root, claudeDir: CLAUDE, base: 'C:/mis/proyectos' });

  uninstall({ root, claudeDir: CLAUDE });

  assert.equal(fs.existsSync(cmdFile('prompt.md')), false);
  assert.equal(fs.existsSync(cmdFile('kaip-summary.md')), false);
  assert.equal(fs.existsSync(notePath(CLAUDE)), false);
  assert.deepEqual(settings(), { model: 'opus' }, 'settings.json como estaba');
  assert.ok(fs.existsSync(path.join(root, 'projects.json')), 'projects.json NO se borra');
});

test('uninstall: sin haber instalado, no rompe', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  assert.doesNotThrow(() => uninstall({ root, claudeDir: CLAUDE }));
});

// --- la nota ------------------------------------------------------------------
test('la nota es un archivo PROPIO: el CLAUDE.md del usuario no se toca', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  const suyo = path.join(CLAUDE, 'CLAUDE.md');
  fs.writeFileSync(suyo, '# mis instrucciones\nno me las toques');

  install({ root, claudeDir: CLAUDE, base: null });
  assert.equal(fs.readFileSync(suyo, 'utf8'), '# mis instrucciones\nno me las toques');

  uninstall({ root, claudeDir: CLAUDE });
  assert.ok(fs.existsSync(suyo), 'y el uninstall tampoco se lo lleva por delante');
});

test('la nota dice qué es, dónde vive y cómo desinstalarlo', () => {
  const body = noteBody('C:/tools/kaiprompt');
  assert.match(body, /kaiprompt/);
  assert.match(body, /C:\/tools\/kaiprompt/, 'dónde vive');
  assert.match(body, /uninstall\.mjs/, 'cómo se quita');
  assert.match(body, /\/prompt|\/kaip-summary/, 'y qué comandos trae');
});

// --- detalles -----------------------------------------------------------------
test('detectBase: encuentra una carpeta de proyectos típica, o null', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  assert.equal(detectBase(home), null, 'si no hay nada, null (no inventa)');

  fs.mkdirSync(path.join(home, 'Projects'));
  assert.equal(detectBase(home), posix(path.join(home, 'Projects')));
});

test('shellSnippets: el atajo lleva la ruta real, y entrecomillada', () => {
  const { powershell, bash } = shellSnippets('C:/tools/chat queue');
  assert.match(powershell, /function kaip/);
  assert.match(powershell, /"C:\/tools\/chat queue\/kaip\.mjs"/, 'con espacios debe ir entre comillas');
  assert.match(bash, /alias kaip=/);
});

test('posix: en el JSON van barras normales (una barra invertida habría que escaparla)', () => {
  assert.equal(posix('C:\\tools\\kaiprompt'), 'C:/tools/kaiprompt');
});
