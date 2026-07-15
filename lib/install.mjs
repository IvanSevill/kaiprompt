// What an install has to do on *this* machine: the slash commands, the note and
// projects.json all need the real installation path, which only exists once cloned.
//
// Everything here is a pure function of (root, claudeDir) plus small file writes,
// so install and uninstall are the same logic read in both directions — and testable.
//
// The one rule the whole file obeys: NOTHING here overwrites a file the user already has.
// This runs inside somebody's ~/.claude, next to their own config. An installer that
// clobbers what it finds there is worse than one that does nothing at all.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeJSON } from './store.mjs';
import { claudeHome } from './chat.mjs';

export { claudeHome };

export const opencodeHome = (home = os.homedir()) => path.join(home, '.config', 'opencode');

/** Node wants forward slashes in the JSON we write; Windows backslashes would need escaping. */
export const posix = (p) => String(p).replace(/\\/g, '/');

export const commandsDir = (claudeDir = claudeHome()) => path.join(claudeDir, 'commands');
export const notePath = (claudeDir = claudeHome()) => path.join(claudeDir, 'kaiprompt.md');
export const opencodePluginPath = (opencodeDir = opencodeHome()) => path.join(
  opencodeDir, 'plugins', 'kaiprompt-usage.js',
);

export function opencodePluginBody(root) {
  const source = pathToFileURL(path.resolve(root, 'opencode', 'usage-metrics.mjs')).href;
  return `export { default } from ${JSON.stringify(source)};\n`;
}

// --- the two slash commands ---------------------------------------------------
export function commandFiles(root) {
  const cli = posix(path.join(root, 'kaip.mjs'));
  const out = posix(path.join(root, 'out'));

  return {
    'prompt.md': `---
description: Turn a rough idea into a sharp, self-contained prompt and leave it in a file
argument-hint: <your idea, however it comes out>
allowed-tools: Bash(node:*), Read, Write, Glob, Grep
---

The user wants to turn this into a real prompt:

**$ARGUMENTS**

Existing conversations and projects (in case the prompt should continue one instead of
starting from scratch):

!\`node "${cli}" sessions; node "${cli}" projects\`

---

# Your job

Turn that idea into a **final, specific, self-contained prompt**, and **write it to a
file**. **DO NOT run the prompt. DO NOT do the work it describes.** Your deliverable is the
file and its absolute path, nothing else.

## If you do not understand it, ASK

A launch runs **with nobody present**, with complete autonomy over a real project.
Nobody will be there to correct a misunderstanding. So a partially understood idea does not
become a prompt: it becomes questions.

Read whatever you can discover from the project (stack, tests, conventions). Ask only what
**only the user** can decide.

## Final prompt structure

In English, addressed to Claude Code, and always containing:

1. **OBJECTIVE** - what must be achieved, in one or two sentences.
2. **CONTEXT** - where the code is and what to read before changing anything. Add value here:
   investigate the project and hand it over already understood, so the launch does not spend quota
   rediscovering it.
3. **WHAT TO DO** - concrete, ordered steps.
4. **HARD RULES** - what it must NOT touch, rename, or delete. A bypass launch does
   *literally* what you let it do.
5. **DONE CRITERIA** - how to know it finished successfully. Almost always: tests passing,
   then a commit.
6. **IF YOU RUN OUT OF QUOTA** - stop in a consistent, committed state, never halfway through.

If the work is large, **split it** into chained prompts that share \`--target\`: they resume the
conversation with its context already loaded, so they are cheaper and much more likely to finish.

## How you finish

1. The **absolute path** to the file, alone and clear.
2. A three-line summary.
3. **What you assumed** without asking - the user wants to know now if you assumed incorrectly.
4. The ready-made command:

\`\`\`
kaip add --from "<path>" --at <when> --dir <project> --target <conversation>
\`\`\`

Remind the user that \`--from\` reads the file **when launching**, so they can keep editing it until
the last second. Also, **queueing is not launching**: the daemon or a \`run\` must be active then.
`,

    'kaip-summary.md': `---
description: Summary of the latest batch of launches: what ran, what stopped halfway, and how to resume it
argument-hint: (no arguments)
allowed-tools: Bash(node:*), Read, Glob, Grep
---

Queue status:

!\`node "${cli}" list\`

---

Using that, give me a direct, concise **English** report:

**1. What happened.** One bullet per launch, in order. For each one, **read its output** in
\`${out}/<id>.txt\`: what was requested (one line, do not copy the whole prompt), what it actually
did, and how it ended - completed, failed, or **stopped halfway**.

**2. What stopped halfway.** For each one, tell me **which part was completed and what remains**:
just saying "it failed" is not enough. Check the real repository state - it may have left half the
work completed and committed. The most common cause is **running out of quota** mid-launch; that
is not a bug, it means there were no tokens left.

**3. How to resume it.** If anything stopped halfway, prepare the continuation prompt - **not the
original again**, but one that starts where it stopped, taking completed work for granted. Propose
it and, if I approve, queue it with **the same \`--target\`** (this resumes the conversation with
its context already loaded and does not spend quota rereading it):

\`\`\`
kaip add "<continuation prompt>" --at <time> --target <the same one> --dir <the same folder>
\`\`\`

**4. Tell me** whether something is processing the queue at that time (a \`run\` or the daemon). If
not, the scheduled work will not fire and will have been pointless.
`,
  };
}

// --- the note in ~/.claude ----------------------------------------------------
/**
 * Its OWN file, never CLAUDE.md. Six months from now this folder is where someone looks to
 * find out what all these commands are — and by then they may well have forgotten installing
 * it. Appending to their CLAUDE.md would put our text inside a file they wrote and maintain,
 * and taking it back out cleanly on uninstall means editing around their content. A separate
 * file has neither problem: writing it cannot damage anything, and removing it is one unlink.
 */
export function noteBody(root) {
  return `# kaiprompt

Queues prompts for Claude Code and launches them unattended — on a schedule, or as soon as
your quota comes back. Installed from: \`${posix(root)}\`

    kaip                     the guided GUI (queue · chats · projects)
    kaip add "…" --at 03:00  queue a launch
    kaip run                 process the queue (stays up; feed it more)
    kaip daemon start        fire scheduled jobs with no terminal open
    kaip serve               the API + QR for the phone app

Slash commands: \`/prompt\` (turns an idea into a launch-ready prompt file) and
\`/kaip-summary\` (what the last batch did, and what the quota cut short).

Uninstall: \`node "${posix(path.join(root, 'uninstall.mjs'))}"\`
`;
}

// --- where the user keeps their projects --------------------------------------
/** A likely projects folder, so the install can offer a default instead of an empty prompt. */
export function detectBase(home = os.homedir()) {
  const guesses = ['Projects', 'projects', 'repos', 'Repos', 'code', 'Code', 'dev', 'Dev',
    'src', 'workspace', path.join('Documents', 'GitHub')];
  for (const g of guesses) {
    const p = path.join(home, g);
    try { if (fs.statSync(p).isDirectory()) return posix(p); } catch { /* not there */ }
  }
  return null;
}

// --- the shell shortcut -------------------------------------------------------
export function shellSnippets(root) {
  const cli = posix(path.join(root, 'kaip.mjs'));
  return {
    powershell: `function kaip { node "${cli}" @args }`,
    bash: `alias kaip='node "${cli}"'`,
  };
}

// --- install / uninstall ------------------------------------------------------
/**
 * Wire this clone into Claude Code. `base` is the projects folder (optional).
 * Nothing that already exists is overwritten — not the commands, not the note,
 * not projects.json. Running this twice is a no-op, by construction.
 */
export function install({ root, claudeDir = claudeHome(), opencodeDir = opencodeHome(), base = null } = {}) {
  const done = [];
  const cmds = commandsDir(claudeDir);
  fs.mkdirSync(cmds, { recursive: true });

  for (const [name, body] of Object.entries(commandFiles(root))) {
    const f = path.join(cmds, name);
    if (fs.existsSync(f)) {
      done.push(`command  ${name} already there (left alone — yours wins)`);
    } else {
      fs.writeFileSync(f, body);
      done.push(`command  ${posix(f)}`);
    }
  }

  const note = notePath(claudeDir);
  if (fs.existsSync(note)) {
    done.push('note     kaiprompt.md already there (left alone)');
  } else {
    fs.writeFileSync(note, noteBody(root));
    done.push(`note     ${posix(note)}`);
  }

  const opencodePlugin = opencodePluginPath(opencodeDir);
  fs.mkdirSync(path.dirname(opencodePlugin), { recursive: true });
  if (fs.existsSync(opencodePlugin)) {
    done.push('plugin   kaiprompt-usage.js already there (left alone)');
  } else {
    fs.writeFileSync(opencodePlugin, opencodePluginBody(root));
    done.push(`plugin   ${posix(opencodePlugin)}`);
  }

  const projects = path.join(root, 'projects.json');
  if (fs.existsSync(projects)) {
    done.push('projects projects.json already there (left alone)');
  } else if (base) {
    writeJSON(projects, { _base: posix(base) });
    done.push(`projects _base → ${posix(base)}`);
  } else {
    writeJSON(projects, {});
    done.push('projects projects.json created (no base folder set)');
  }

  return done;
}

/** Undo it. User data (queue, out, projects.json) is never touched. */
export function uninstall({ root, claudeDir = claudeHome(), opencodeDir = opencodeHome() } = {}) {
  const done = [];
  const cmds = commandsDir(claudeDir);

  for (const name of Object.keys(commandFiles(root))) {
    const f = path.join(cmds, name);
    if (fs.existsSync(f)) { fs.rmSync(f); done.push(`removed  ${posix(f)}`); }
  }

  const note = notePath(claudeDir);
  if (fs.existsSync(note)) { fs.rmSync(note); done.push(`removed  ${posix(note)}`); }

  const opencodePlugin = opencodePluginPath(opencodeDir);
  if (fs.existsSync(opencodePlugin)) {
    let body = null;
    try { body = fs.readFileSync(opencodePlugin, 'utf8'); } catch { /* leave it alone */ }
    if (body === opencodePluginBody(root)) {
      fs.rmSync(opencodePlugin);
      done.push(`removed  ${posix(opencodePlugin)}`);
    } else {
      done.push('kept     kaiprompt-usage.js (modified or user-owned)');
    }
  }

  // settings.json is not ours to edit any more — we register nothing in it. Reading it here
  // only to leave it exactly as it is would be a good way to corrupt it for no reason.
  done.push('kept     settings.json (we put nothing in it)');
  done.push('kept     data/, out/, projects.json (your data)');
  return done;
}
