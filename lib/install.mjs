// What an install has to do on *this* machine: the slash commands, the hook and
// projects.json all need the real installation path, which only exists once cloned.
//
// Everything here is a pure function of (root, claudeDir) plus small file writes,
// so install and uninstall are the same logic read in both directions — and testable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readJSON, writeJSON } from './store.mjs';
import { claudeHome } from './chat.mjs';

export { claudeHome };

/** Node wants forward slashes in the JSON we write; Windows backslashes would need escaping. */
export const posix = (p) => String(p).replace(/\\/g, '/');

export const settingsPath = (claudeDir = claudeHome()) => path.join(claudeDir, 'settings.json');
export const commandsDir = (claudeDir = claudeHome()) => path.join(claudeDir, 'commands');

/** The hook line that makes /programar cost 0 tokens. Keyed by path: that's its identity. */
export const hookCommand = (root) => `node "${posix(path.join(root, 'programar.mjs'))}"`;

// --- the two slash commands --------------------------------------------------
export function commandFiles(root) {
  const prog = posix(path.join(root, 'programar.mjs'));
  const cli = posix(path.join(root, 'program-prompt.mjs'));

  return {
    'programar.md': `---
description: Programa un lanzamiento del chat-queue (lo procesa el hook, 0 tokens)
argument-hint: <cuándo> | <prompt> [| <target>] [| <carpeta>]
---

El programado lo gestiona el hook \`UserPromptSubmit\` (\`programar.mjs\`): intercepta este
mensaje, lo guarda en \`programados.jsonl\` y bloquea el turno **sin gastar tokens**. Este
comando existe solo para que \`/programar\` sea reconocido y llegue al hook.

Si estás leyendo esto, el hook **no** se ejecutó (debería haber bloqueado antes). Reinicia
Claude Code para activarlo; mientras tanto puedes programar desde la terminal con:

\`node "${prog}" --cli "$ARGUMENTS"\`
`,

    'resumen-prompts.md': `---
description: Resume qué hicieron los prompts lanzados (estado de la cola + respuestas)
argument-hint: (sin argumentos)
allowed-tools: Bash(node:*), Read, Glob
---

Estado actual de la cola de lanzamientos:

!\`node "${cli}" list\`

Ahora lee los archivos de salida más recientes en la carpeta \`${posix(path.join(root, 'out'))}\`
(usa Glob para listar los \`*.txt\` y Read para leerlos).

Resúmeme en español, de forma concisa, qué ocurrió con cada lanzamiento:
- qué se pidió (el prompt),
- qué respondió o hizo Claude (resumen breve del \`out\`),
- si terminó bien (\`done\`) o falló (\`error\`).

Una viñeta por lanzamiento. Si la cola está vacía o no hay salidas, dímelo claramente:
probablemente significa que \`program-prompt run\` no estaba activo a la hora programada y
los lanzamientos no llegaron a ejecutarse.
`,
  };
}

// --- the hook in settings.json -----------------------------------------------
/**
 * Add our UserPromptSubmit hook without touching anything else in settings.json.
 * Idempotent: installing twice must not leave two hooks (the turn would be blocked
 * twice and the launch queued twice).
 */
export function addHook(settings, root) {
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
  const cmd = hookCommand(root);
  const groups = Array.isArray(next.hooks.UserPromptSubmit) ? [...next.hooks.UserPromptSubmit] : [];

  const already = groups.some((g) => (g.hooks || []).some((h) => h.command === cmd));
  if (already) return { settings: next, changed: false };

  groups.push({ hooks: [{ type: 'command', command: cmd }] });
  next.hooks.UserPromptSubmit = groups;
  return { settings: next, changed: true };
}

/** Take our hook back out, leaving every other hook (and every other setting) alone. */
export function removeHook(settings, root) {
  const cmd = hookCommand(root);
  const groups = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return { settings, changed: false };

  const kept = groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => h.command !== cmd) }))
    .filter((g) => g.hooks.length);                  // drop groups we emptied out

  if (kept.length === groups.length && kept.every((g, i) => g.hooks.length === (groups[i].hooks || []).length)) {
    return { settings, changed: false };
  }

  const next = { ...settings, hooks: { ...settings.hooks } };
  if (kept.length) next.hooks.UserPromptSubmit = kept;
  else delete next.hooks.UserPromptSubmit;
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return { settings: next, changed: true };
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
  const cli = posix(path.join(root, 'program-prompt.mjs'));
  return {
    powershell: `function program-prompt { node "${cli}" @args }`,
    bash: `alias program-prompt='node "${cli}"'`,
  };
}

// --- install / uninstall ------------------------------------------------------
/**
 * Wire this clone into Claude Code. `base` is the projects folder (optional);
 * projects.json is never overwritten — it's user data.
 */
export function install({ root, claudeDir = claudeHome(), base = null } = {}) {
  const done = [];
  const cmds = commandsDir(claudeDir);
  fs.mkdirSync(cmds, { recursive: true });

  for (const [name, body] of Object.entries(commandFiles(root))) {
    fs.writeFileSync(path.join(cmds, name), body);
    done.push(`command  ${posix(path.join(cmds, name))}`);
  }

  const file = settingsPath(claudeDir);
  const { settings, changed } = addHook(readJSON(file, {}), root);
  if (changed) writeJSON(file, settings);
  done.push(changed ? `hook     UserPromptSubmit → programar.mjs` : 'hook     already registered');

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

/** Undo the three steps. User data (queue, out, projects.json) is never touched. */
export function uninstall({ root, claudeDir = claudeHome() } = {}) {
  const done = [];
  const cmds = commandsDir(claudeDir);

  for (const name of Object.keys(commandFiles(root))) {
    const f = path.join(cmds, name);
    if (fs.existsSync(f)) { fs.rmSync(f); done.push(`removed  ${posix(f)}`); }
  }

  const file = settingsPath(claudeDir);
  const { settings, changed } = removeHook(readJSON(file, {}), root);
  if (changed) { writeJSON(file, settings); done.push('removed  the UserPromptSubmit hook'); }
  else done.push('hook     was not registered');

  done.push('kept     data/, out/, projects.json (your data)');
  return done;
}
