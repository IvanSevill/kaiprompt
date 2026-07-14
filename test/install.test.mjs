// The installer writes inside somebody's ~/.claude, next to their own config. The rule that
// nearly this whole file tests: IT CLOBBERS NOTHING. Not the commands, not the note, not
// projects.json, not settings.json (in which it now registers nothing at all).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-inst-'));
process.env.KAIP_HOME = TMP;
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');   // a make-believe ~/.claude

const { readJSON } = await import('../lib/store.mjs');
const {
  commandFiles, detectBase, install, noteBody, notePath, posix, shellSnippets, uninstall,
} = await import('../lib/install.mjs');

const ROOT = 'C:/tools/kaiprompt';                          // an example installation
const CLAUDE = path.join(TMP, 'claude');
const settingsFile = path.join(CLAUDE, 'settings.json');
const cmdFile = (n) => path.join(CLAUDE, 'commands', n);
const settings = () => readJSON(settingsFile, {});

const reset = () => {
  fs.rmSync(CLAUDE, { recursive: true, force: true });
  fs.mkdirSync(CLAUDE, { recursive: true });
};

// --- the slash commands -------------------------------------------------------
test('commandFiles: there are TWO, and they carry the REAL installation path', () => {
  const files = commandFiles(ROOT);
  assert.deepEqual(Object.keys(files).sort(), ['kaip-summary.md', 'prompt.md']);

  for (const body of Object.values(files)) {
    assert.match(body, /C:\/tools\/kaiprompt\/kaip\.mjs/, 'it points at a binary that exists');
  }
  assert.match(files['kaip-summary.md'], /C:\/tools\/kaiprompt\/out/);
});

test('commandFiles: they carry front-matter, or Claude Code will not recognise them', () => {
  for (const body of Object.values(commandFiles(ROOT))) {
    assert.match(body, /^---\n/);
    assert.match(body, /description:/);
  }
});

// --- a real install / uninstall, on disk --------------------------------------
test('install: writes the commands, the note and projects.json', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  const actions = install({ root, claudeDir: CLAUDE, base: 'C:/my/projects' });

  assert.ok(fs.existsSync(cmdFile('prompt.md')));
  assert.ok(fs.existsSync(cmdFile('kaip-summary.md')));
  assert.ok(fs.existsSync(notePath(CLAUDE)));
  assert.deepEqual(readJSON(path.join(root, 'projects.json'), null), { _base: 'C:/my/projects' });
  assert.ok(actions.length >= 4, 'and it reports what it did');
});

test('install: registers NOTHING in settings.json (there is no hook any more)', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }));

  install({ root, claudeDir: CLAUDE, base: null });

  assert.deepEqual(settings(), { model: 'opus' }, 'settings.json, untouched');
});

test('install: twice in a row duplicates nothing and changes nothing (idempotent on disk)', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  install({ root, claudeDir: CLAUDE, base: 'C:/x' });

  const before = fs.readdirSync(path.join(CLAUDE, 'commands')).sort();
  const note = fs.readFileSync(notePath(CLAUDE), 'utf8');

  install({ root, claudeDir: CLAUDE, base: 'C:/x' });

  assert.deepEqual(fs.readdirSync(path.join(CLAUDE, 'commands')).sort(), before);
  assert.equal(fs.readFileSync(notePath(CLAUDE), 'utf8'), note);
});

test('install: does NOT clobber a slash command the user had already tuned', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.mkdirSync(path.join(CLAUDE, 'commands'), { recursive: true });
  fs.writeFileSync(cmdFile('prompt.md'), 'mine, and it took me a while');

  install({ root, claudeDir: CLAUDE, base: null });

  assert.equal(fs.readFileSync(cmdFile('prompt.md'), 'utf8'), 'mine, and it took me a while');
  assert.ok(fs.existsSync(cmdFile('kaip-summary.md')), 'the missing one does get written');
});

test('install: does NOT clobber a projects.json that was already there (it is user data)', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ _base: 'C:/mine', alias: 'C:/a' }));

  install({ root, claudeDir: CLAUDE, base: 'C:/something/else' });

  assert.deepEqual(readJSON(path.join(root, 'projects.json'), null), { _base: 'C:/mine', alias: 'C:/a' });
});

test('install: with no base folder, projects.json is created empty (it does not blow up)', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  install({ root, claudeDir: CLAUDE, base: null });
  assert.deepEqual(readJSON(path.join(root, 'projects.json'), null), {});
});

test('uninstall: reverses the commands and the note, and does NOT touch the data', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }));
  install({ root, claudeDir: CLAUDE, base: 'C:/my/projects' });

  uninstall({ root, claudeDir: CLAUDE });

  assert.equal(fs.existsSync(cmdFile('prompt.md')), false);
  assert.equal(fs.existsSync(cmdFile('kaip-summary.md')), false);
  assert.equal(fs.existsSync(notePath(CLAUDE)), false);
  assert.deepEqual(settings(), { model: 'opus' }, 'settings.json as it was');
  assert.ok(fs.existsSync(path.join(root, 'projects.json')), 'projects.json is NOT deleted');
});

test('uninstall: with nothing installed, it does not break', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  assert.doesNotThrow(() => uninstall({ root, claudeDir: CLAUDE }));
});

// --- the note ------------------------------------------------------------------
test('the note is its OWN file: the user\'s CLAUDE.md is not touched', () => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  const theirs = path.join(CLAUDE, 'CLAUDE.md');
  fs.writeFileSync(theirs, '# my instructions\nleave them alone');

  install({ root, claudeDir: CLAUDE, base: null });
  assert.equal(fs.readFileSync(theirs, 'utf8'), '# my instructions\nleave them alone');

  uninstall({ root, claudeDir: CLAUDE });
  assert.ok(fs.existsSync(theirs), 'and the uninstall does not take it out either');
});

test('the note says what it is, where it lives and how to uninstall it', () => {
  const body = noteBody('C:/tools/kaiprompt');
  assert.match(body, /kaiprompt/);
  assert.match(body, /C:\/tools\/kaiprompt/, 'where it lives');
  assert.match(body, /uninstall\.mjs/, 'how to remove it');
  assert.match(body, /\/prompt|\/kaip-summary/, 'and which commands it brings');
});

// --- details -------------------------------------------------------------------
test('detectBase: finds a typical projects folder, or null', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  assert.equal(detectBase(home), null, 'with nothing there, null (it invents nothing)');

  fs.mkdirSync(path.join(home, 'Projects'));
  assert.equal(detectBase(home), posix(path.join(home, 'Projects')));
});

test('shellSnippets: the shortcut carries the real path, in quotes', () => {
  const { powershell, bash } = shellSnippets('C:/tools/chat queue');
  assert.match(powershell, /function kaip/);
  assert.match(powershell, /"C:\/tools\/chat queue\/kaip\.mjs"/, 'with spaces it has to be quoted');
  assert.match(bash, /alias kaip=/);
});

test('posix: the JSON carries forward slashes (a backslash would have to be escaped)', () => {
  assert.equal(posix('C:\\tools\\kaiprompt'), 'C:/tools/kaiprompt');
});
