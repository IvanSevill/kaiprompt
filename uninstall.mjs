#!/usr/bin/env node
// uninstall.mjs — undo what install.mjs did: the two slash commands and the hook.
// Your data (data/, out/, projects.json, programados.jsonl) is left exactly as it is.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { c } from './lib/ui.mjs';
import { claudeHome, posix, uninstall } from './lib/install.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

console.log(`\n${c.accent('program-prompt')} → uninstalling`);
console.log(c.muted(`  from: ${posix(claudeHome())}\n`));

for (const line of uninstall({ root: ROOT })) console.log('  ' + c.ok('✓') + ' ' + line);

console.log(c.muted('\nThe shell shortcut (if you added it) has to come out of your profile by hand.\n'));
