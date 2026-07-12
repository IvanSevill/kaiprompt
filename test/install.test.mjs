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
  addHook, commandFiles, detectBase, hookCommand, install, posix,
  removeHook, shellSnippets, uninstall,
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
test('commandFiles: los dos comandos llevan la ruta REAL de instalación', () => {
  const files = commandFiles(ROOT);
  assert.deepEqual(Object.keys(files).sort(), ['programar.md', 'resumen-prompts.md']);

  assert.match(files['programar.md'], /C:\/tools\/kaiprompt\/programar\.mjs/);
  assert.match(files['resumen-prompts.md'], /C:\/tools\/kaiprompt\/kaip\.mjs/);
  assert.match(files['resumen-prompts.md'], /C:\/tools\/kaiprompt\/out/);
});

test('commandFiles: resumen-prompts apunta al binario que existe (no al nombre viejo)', () => {
  // El instalado a mano apuntaba a "programar-prompt.mjs", que no existe: estaba roto.
  const md = commandFiles(ROOT)['resumen-prompts.md'];
  assert.doesNotMatch(md, /programar-prompt\.mjs/);
});

test('commandFiles: llevan front-matter, si no Claude Code no los reconoce', () => {
  for (const body of Object.values(commandFiles(ROOT))) {
    assert.match(body, /^---\n/);
    assert.match(body, /description:/);
  }
});

// --- el hook ------------------------------------------------------------------
test('addHook: registra UserPromptSubmit apuntando a programar.mjs', () => {
  const { settings: s, changed } = addHook({}, ROOT);
  assert.equal(changed, true);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, hookCommand(ROOT));
  assert.match(s.hooks.UserPromptSubmit[0].hooks[0].command, /programar\.mjs/);
});

test('addHook: es idempotente (dos hooks = el turno se bloquea dos veces)', () => {
  const uno = addHook({}, ROOT).settings;
  const { settings: dos, changed } = addHook(uno, ROOT);
  assert.equal(changed, false, 'la segunda vez no cambia nada');
  assert.equal(dos.hooks.UserPromptSubmit.length, 1);
});

test('addHook: NO pisa otros ajustes ni otros hooks del usuario', () => {
  const previo = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'otra-cosa' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'hook-ajeno' }] }],
    },
  };
  const { settings: s } = addHook(previo, ROOT);

  assert.equal(s.model, 'opus', 'lo que no es nuestro se queda');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'otra-cosa');
  assert.equal(s.hooks.UserPromptSubmit.length, 2, 'el hook ajeno sigue ahí');
  assert.ok(s.hooks.UserPromptSubmit.some((g) => g.hooks[0].command === hookCommand(ROOT)));
});

test('removeHook: se lleva el nuestro y deja el resto intacto', () => {
  const conAmbos = addHook({
    model: 'opus',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'hook-ajeno' }] }] },
  }, ROOT).settings;

  const { settings: s, changed } = removeHook(conAmbos, ROOT);
  assert.equal(changed, true);
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, 'hook-ajeno');
});

test('removeHook: si era el único, no deja restos vacíos', () => {
  const solo = addHook({}, ROOT).settings;
  const { settings: s } = removeHook(solo, ROOT);
  assert.equal(s.hooks, undefined, 'ni hooks: {} colgando');
});

test('removeHook: sin hook registrado no rompe', () => {
  assert.equal(removeHook({}, ROOT).changed, false);
  assert.equal(removeHook({ model: 'opus' }, ROOT).changed, false);
});

// --- install / uninstall de verdad, sobre disco -------------------------------
test('install: escribe los comandos, registra el hook y crea projects.json', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  const acciones = install({ root, claudeDir: CLAUDE, base: 'C:/mis/proyectos' });

  assert.ok(fs.existsSync(cmdFile('programar.md')));
  assert.ok(fs.existsSync(cmdFile('resumen-prompts.md')));
  assert.equal(settings().hooks.UserPromptSubmit[0].hooks[0].command, hookCommand(root));
  assert.deepEqual(readJSON(path.join(root, 'projects.json'), null), { _base: 'C:/mis/proyectos' });
  assert.ok(acciones.length >= 4, 'y cuenta lo que ha hecho');
});

test('install: dos veces seguidas deja UN solo hook (idempotente en disco)', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  install({ root, claudeDir: CLAUDE, base: 'C:/x' });
  install({ root, claudeDir: CLAUDE, base: 'C:/x' });

  assert.equal(settings().hooks.UserPromptSubmit.length, 1);
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

test('install: respeta un settings.json que ya tenía cosas', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] } }));

  install({ root, claudeDir: CLAUDE, base: null });

  const s = settings();
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions.allow, ['Bash']);
  assert.ok(s.hooks.UserPromptSubmit);
});

test('uninstall: revierte los comandos y el hook, y NO toca los datos', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }));
  install({ root, claudeDir: CLAUDE, base: 'C:/mis/proyectos' });

  uninstall({ root, claudeDir: CLAUDE });

  assert.equal(fs.existsSync(cmdFile('programar.md')), false);
  assert.equal(fs.existsSync(cmdFile('resumen-prompts.md')), false);
  assert.equal(settings().hooks, undefined, 'el hook fuera');
  assert.equal(settings().model, 'opus', 'settings.json como estaba');
  assert.ok(fs.existsSync(path.join(root, 'projects.json')), 'projects.json NO se borra');
});

test('uninstall: sin haber instalado, no rompe', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  assert.doesNotThrow(() => uninstall({ root, claudeDir: CLAUDE }));
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
