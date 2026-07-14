// Ghost commands: references to commands that NO LONGER EXIST.
//
// `pair` was absorbed into `serve`, and the old name stayed alive in the README, in a couple of
// comments and — the one that reached the user — on the app's pairing screen, which for weeks
// sent people off to type a command that failed. Renaming a command is easy; remembering the
// eight places it was written down is not.
//
// This test closes both ends:
//   1. the list in lib/commands.mjs is still the one in the kaip.mjs switch (they cannot drift);
//   2. no reference in the repo — README, HELP, GUI, skills, slash commands, the app — points at
//      a command that is not on that list.
//
// If `mobile` disappears tomorrow, this goes red before anybody types it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cmds-'));
process.env.KAIP_HOME = TMP;

const { COMMANDS, ENGINES, SUBCOMMANDS, isCommand } = await import('../lib/commands.mjs');

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// --- 1. the list cannot drift away from the dispatch --------------------------
test('the command list is EXACTLY what kaip.mjs dispatches', () => {
  const src = fs.readFileSync(path.join(REPO, 'kaip.mjs'), 'utf8');
  const dispatch = src.slice(src.indexOf('// --- dispatch'));
  assert.ok(dispatch.length > 200, 'cannot find the dispatch block in kaip.mjs');

  const cases = [...dispatch.matchAll(/case '([^']+)':/g)]
    .map((m) => m[1])
    .filter((w) => !w.startsWith('-'));            // --help and -h are flags, not commands

  assert.deepEqual(
    [...new Set(cases)].sort(),
    [...COMMANDS].sort(),
    'lib/commands.mjs and the kaip.mjs switch have parted ways: one of the two is lying',
  );
});

test('the declared subcommands are the ones the daemon switch accepts', () => {
  const src = fs.readFileSync(path.join(REPO, 'kaip.mjs'), 'utf8');
  const body = src.slice(src.indexOf('async function cmdDaemon'), src.indexOf('const APK_RELEASE'));
  const cases = [...body.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]);

  assert.deepEqual([...new Set(cases)].sort(), [...SUBCOMMANDS.daemon].sort());
});

// --- 2. nobody may quote a command that does not exist ------------------------
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', '.gradle', 'data', 'out', '.tasks', 'prompts']);
const SCAN_EXT = new Set(['.mjs', '.md', '.kt', '.cmd', '.json']);

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (SCAN_EXT.has(path.extname(e.name))) acc.push(full);
  }
  return acc;
}

/**
 * An INVOCATION, not the word "kaip" in a sentence.
 *
 * It only counts when the text is written the way it is typed: in quotes, in backticks, in
 * «», or at the start of a line (code blocks and the HELP examples). Otherwise a comment like
 * "how kaip leaves the screen" would come out as the non-existent command "leaves", and a test
 * that cries wolf ends up ignored — which is how the real ones get through.
 */
const INVOCATION = /(?:^\s*|[`'"«(])kaip ([a-z][a-z-]*)((?: [a-z][a-z-]*)?)/gm;

/** Every reference in the repo: where it comes from, which command it quotes, which subcommand. */
function references() {
  const files = [
    ...walk(REPO),
    path.join(CLAUDE, 'commands', 'prompt.md'),
    path.join(CLAUDE, 'commands', 'kaip-summary.md'),
    ...walk(path.join(CLAUDE, 'skills', 'kaiprompt')),
    ...walk(path.join(CLAUDE, 'skills', 'kaip-summary')),
    ...walk(path.join(CLAUDE, 'skills', 'prompt')),
  ];

  const out = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }   // not on this PC: skip it
    if (file === path.join(REPO, 'lib', 'commands.mjs')) continue;      // the list itself
    if (file === fileURLToPath(import.meta.url)) continue;              // and this test

    for (const m of text.matchAll(INVOCATION)) {
      let [word, rest] = [m[1], m[2].trim()];
      if (ENGINES.includes(word)) {                 // "kaip claude add" → the engine is not the command
        if (!rest) continue;
        [word, rest] = [rest, ''];
      }
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ file: path.relative(REPO, file), line, word, rest, text: m[0].trim() });
    }
  }
  return out;
}

test('the sweep really does find the references (otherwise it would prove nothing)', () => {
  const refs = references();
  const files = new Set(refs.map((r) => r.file));

  assert.ok(refs.length > 30, `expected dozens of references, found ${refs.length}`);
  assert.ok([...files].some((f) => f === 'README.md'), 'the README must be in the sweep');
  assert.ok([...files].some((f) => f === 'kaip.mjs'), 'the HELP in kaip.mjs too');
  assert.ok([...files].some((f) => f.endsWith('MainActivity.kt')), 'and the Android app');
});

test('NO reference points at a command that does not exist', () => {
  const ghosts = references()
    .filter((r) => !isCommand(r.word))
    .map((r) => `${r.file}:${r.line}  «${r.text}» → there is no "${r.word}"`);

  assert.deepEqual(ghosts, [], 'ghost commands:\n  ' + ghosts.join('\n  '));
});

test('nor at a subcommand that does not exist (kaip daemon <x>, kaip app <x>)', () => {
  const ghosts = references()
    .filter((r) => SUBCOMMANDS[r.word] && r.rest && !SUBCOMMANDS[r.word].includes(r.rest))
    .map((r) => `${r.file}:${r.line}  «${r.text}» → "${r.word}" has no subcommand "${r.rest}"`);

  assert.deepEqual(ghosts, [], 'ghost subcommands:\n  ' + ghosts.join('\n  '));
});

test('"pair" is dead and buried: "serve" absorbed it', () => {
  // The specific regression that brought us here: the app told you to type «kaip pair».
  assert.equal(isCommand('pair'), false, 'pair is not a command any more');

  const quotes = references().filter((r) => r.word === 'pair');
  assert.deepEqual(quotes.map((r) => `${r.file}:${r.line}`), [], 'somebody is still quoting it');
});

// --- the detector, tested: a test that catches nothing protects nothing -------
test('the detector tells an invocation from the bare word in prose', () => {
  const invocations = ['`kaip pair`', '"kaip pair"', '«kaip pair»', '  kaip pair --reset'];
  for (const s of invocations) {
    assert.deepEqual([...s.matchAll(INVOCATION)].map((m) => m[1]), ['pair'], `it must catch: ${s}`);
  }

  const prose = ['// how kaip leaves the screen', 'asks about kaip or kaip'];
  for (const s of prose) {
    assert.deepEqual([...s.matchAll(INVOCATION)].map((m) => m[1]), [], `it must not fire on prose: ${s}`);
  }
});

test('the detector sees the command behind the engine (kaip claude add)', () => {
  const refs = [...'`kaip claude add "x"`'.matchAll(INVOCATION)];
  assert.equal(refs[0][1], 'claude');
  assert.equal(refs[0][2].trim(), 'add', 'and "add" is what needs validating');
});
