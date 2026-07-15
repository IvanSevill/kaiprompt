#!/usr/bin/env node
// install.mjs — wire this clone into Claude Code and OpenCode. Zero dependencies.
//
//   node install.mjs                 asks for the projects folder
//   node install.mjs --base <path>   takes it from the flag
//   node install.mjs --yes           no questions (detects the folder, or leaves it empty)
//
// It also installs an OpenCode usage plugin. Existing files are never overwritten.
//
// Undo with: node uninstall.mjs

import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { c } from './lib/ui.mjs';
import { claudeHome, detectBase, install, posix, shellSnippets } from './lib/install.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

async function askBase() {
  const guess = detectBase();
  if (flag('yes') || !process.stdin.isTTY) return guess;          // unattended: take the guess

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(
    `\n${c.bold('Where do you keep your projects?')}\n`
    + c.muted('  Any subfolder of it can then be used by name: --dir myapp\n')
    + c.muted(`  Enter to accept${guess ? ` [${guess}]` : ' (skip)'}: `),
  )).trim();
  rl.close();
  return answer || guess;
}

const base = typeof flag('base') === 'string' ? flag('base') : await askBase();

console.log(`\n${c.accent('kaip')} → installing`);
console.log(c.muted(`  from: ${posix(ROOT)}`));
console.log(c.muted(`  into: ${posix(claudeHome())}\n`));

for (const line of install({ root: ROOT, base })) console.log('  ' + c.ok('✓') + ' ' + line);

const { powershell, bash } = shellSnippets(ROOT);
console.log(`\n${c.bold('One last step')} — the shortcut, so you can type ${c.accent('kaip')}:\n`);
console.log(c.muted('  PowerShell (add it to your $PROFILE):'));
console.log(`    ${powershell}\n`);
console.log(c.muted('  bash / git-bash (add it to your ~/.bashrc):'));
console.log(`    ${bash}\n`);
console.log(c.muted('Then try:  kaip        (the guided GUI)\n'));
