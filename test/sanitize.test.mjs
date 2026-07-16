import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This repo is PUBLIC. An absolute home path (such as "C:\Users\<...>" or "/home/<...>")
// leaks the user's name and would not work on anyone else's machine: the tool installs wherever
// it is cloned. The installer writes actual paths at install time, so none must remain in source.
//
// This test is the lock: if someone embeds a personal path again, it fails here.

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Things outside the repo are not scanned. Gradle build folders contain absolute paths from the
// machine that built them; that is normal, which is why they are in .gitignore. Scanning them
// only produces false alarms that teach people to ignore this test.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'data', 'out', '.tasks', '.atl',
  'build', '.gradle',
]);
// User data: it lives on disk but is in .gitignore and is not published.
const SKIP_FILES = new Set(['projects.json', 'local.properties']);
const SCAN_EXT = new Set(['.mjs', '.js', '.json', '.md', '.cmd', '.sh', '.yml', '.txt', '']);

// Placeholders are templates, not personal data.
const PLACEHOLDERS = ['<your-user>', '<you>', '$USER', '%USERNAME%', '$env:USERPROFILE', '$HOME'];

/** A named user folder: Users\<...>, Users/<...>, home/<...> (with or without "C:"). */
const HOME_PATH = /(?:[A-Za-z]:)?[\\/]?(?:Users|home)[\\/]([A-Za-z0-9_.-]+)/g;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || SKIP_FILES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (SCAN_EXT.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

test('sanitized: no repository file contains a personal home path', () => {
  const hits = [];

  for (const file of walk(REPO)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [match, user] of text.matchAll(HOME_PATH)) {
      if (PLACEHOLDERS.some((p) => match.includes(p) || user === p)) continue;
      const line = text.slice(0, text.indexOf(match)).split('\n').length;
      hits.push(`${path.relative(REPO, file)}:${line}  ${match}`);
    }
  }

  assert.deepEqual(hits, [], `personal paths found:\n  ${hits.join('\n  ')}`);
});

test('sanitized: the scan actually examines files (otherwise it would test nothing)', () => {
  // A test that reads nothing would always pass: verify that walk finds code here.
  const files = walk(REPO).map((f) => path.relative(REPO, f).replace(/\\/g, '/'));
  assert.ok(files.includes('kaip.mjs'));
  assert.ok(files.includes('lib/install.mjs'));
  assert.ok(files.includes('README.md'));
  assert.ok(files.length > 15, `expected to scan the full repo, found only ${files.length} files`);
});

test('sanitized: the detector recognizes a personal path if one slips in', () => {
  // The username is composed at runtime: written literally here, this file would itself
  // contain a personal path and the scan above would catch itself.
  const u = 'someone';
  const bad = [
    `node "C:\\Users\\${u}\\.claude\\tools\\kaip\\kaip.mjs"`,
    `/home/${u}/.claude/tools/kaiprompt`,
    `/Users/${u}/.claude`,
  ];
  for (const value of bad) {
    assert.equal([...value.matchAll(HOME_PATH)].length, 1, `must catch: ${value}`);
  }

  const good = 'node "$env:USERPROFILE\\.claude\\tools\\kaip\\kaip.mjs"';
  assert.equal([...good.matchAll(HOME_PATH)].length, 0, 'and allow the placeholder');
});
