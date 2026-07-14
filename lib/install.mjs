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

import { writeJSON } from './store.mjs';
import { claudeHome } from './chat.mjs';

export { claudeHome };

/** Node wants forward slashes in the JSON we write; Windows backslashes would need escaping. */
export const posix = (p) => String(p).replace(/\\/g, '/');

export const commandsDir = (claudeDir = claudeHome()) => path.join(claudeDir, 'commands');
export const notePath = (claudeDir = claudeHome()) => path.join(claudeDir, 'kaiprompt.md');

// --- the two slash commands ---------------------------------------------------
// In Spanish on purpose: they are what the person at the keyboard types, and this repo's
// user types Spanish. The README is English because it is read by strangers; these are not.
export function commandFiles(root) {
  const cli = posix(path.join(root, 'kaip.mjs'));
  const out = posix(path.join(root, 'out'));

  return {
    'prompt.md': `---
description: Convierte una idea cruda en un prompt afilado y autosuficiente, y te lo deja en un archivo
argument-hint: <tu idea, tal cual te salga>
allowed-tools: Bash(node:*), Read, Write, Glob, Grep
---

El usuario quiere convertir esto en un prompt de verdad:

**$ARGUMENTS**

Conversaciones y proyectos que ya existen (por si el prompt debe continuar uno en vez de
empezar de cero):

!\`node "${cli}" sessions; node "${cli}" projects\`

---

# Tu trabajo

Convertir esa idea en un **prompt final, específico y autosuficiente**, y **escribirlo en un
archivo**. **NO ejecutes el prompt. NO hagas el trabajo que describe.** Tu entregable es el
archivo y su ruta absoluta, nada más.

## Si no lo entiendes, PREGUNTA

Un lanzamiento se ejecuta **sin nadie delante**, con autonomía total sobre un proyecto real.
Nadie va a estar ahí para corregir un malentendido. Así que una idea a medio entender no se
convierte en un prompt: se convierte en preguntas.

Lo que puedas averiguar tú leyendo el proyecto (stack, tests, convenciones), léelo. Pregunta
solo lo que **únicamente él** puede decidir.

## La estructura del prompt final

En español, dirigido a Claude Code, y que contenga siempre:

1. **OBJETIVO** — qué hay que conseguir, en una o dos frases.
2. **CONTEXTO** — dónde está el código, qué leer antes de tocar nada. Aquí aportas valor:
   investiga el proyecto y déjaselo masticado, para que el lanzamiento no gaste cupo
   redescubriéndolo.
3. **QUÉ HACER** — pasos concretos y ordenados.
4. **REGLAS DURAS** — qué NO puede tocar, renombrar ni borrar. Un lanzamiento con bypass
   hace *literalmente* lo que le dejes hacer.
5. **CRITERIO DE TERMINADO** — cómo se sabe que acabó bien. Casi siempre: los tests en
   verde, y commit al terminar.
6. **SI TE QUEDAS SIN CUPO** — que pare en un estado consistente y commiteado, no a medias.

Si el trabajo es grande, **trocéalo** en varios prompts encadenados que compartan
\`--target\`: retoman la conversación con el contexto ya cargado, así que salen más baratos
y es mucho más probable que terminen.

## Cómo terminas

1. La **ruta absoluta** del archivo, sola y clara.
2. Un resumen de tres líneas.
3. **Qué has asumido tú** sin preguntar — si asumiste mal, quiere enterarse ahora.
4. El comando, ya montado:

\`\`\`
kaip add --from "<la ruta>" --at <cuándo> --dir <proyecto> --target <conversación>
\`\`\`

Recuérdale que \`--from\` lee el archivo **al lanzar**, así que puede seguir editándolo hasta
el último segundo. Y que **encolar no es lanzar**: hace falta el daemon o un \`run\` a esa hora.
`,

    'kaip-summary.md': `---
description: Resumen de la última tanda de lanzamientos: qué corrió, qué se quedó a medias y cómo retomarlo
argument-hint: (sin argumentos)
allowed-tools: Bash(node:*), Read, Glob, Grep
---

Estado de la cola:

!\`node "${cli}" list\`

---

Con eso, hazme un informe **en español**, directo y sin paja:

**1. Qué pasó.** Una viñeta por lanzamiento, en orden. Para cada uno **lee su salida** en
\`${out}/<id>.txt\`: qué se pidió (una línea, no me copies el prompt entero), qué hizo
realmente, y cómo acabó — terminado, fallado o **cortado a medias**.

**2. Lo que se quedó a medias.** Para cada uno, dime **qué parte llegó a hacerse y qué
falta**: no basta con decir "falló". Mira el estado real del repo — puede que dejara la
mitad hecha y commiteada. La causa más habitual es que se **acabó el cupo** en mitad del
lanzamiento; eso no es un bug, es que no quedaban tokens.

**3. Cómo retomarlo.** Si hay algo a medias, prepárame el prompt de continuación — **no el
original otra vez**, sino uno que arranque desde donde se quedó, dando por hecho lo que ya
está hecho. Propónmelo y, si le doy el OK, encólalo reutilizando **el mismo \`--target\`**
(así retoma la conversación que ya tenía el contexto cargado y no gasta cupo releyéndolo):

\`\`\`
kaip add "<prompt de continuación>" --at <hora> --target <el mismo> --dir <la misma carpeta>
\`\`\`

**4. Avísame** de si hay algo procesando la cola a esa hora (un \`run\` o el daemon). Si no
lo hay, lo agendado no se disparará y no habrá servido de nada.
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
export function install({ root, claudeDir = claudeHome(), base = null } = {}) {
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
export function uninstall({ root, claudeDir = claudeHome() } = {}) {
  const done = [];
  const cmds = commandsDir(claudeDir);

  for (const name of Object.keys(commandFiles(root))) {
    const f = path.join(cmds, name);
    if (fs.existsSync(f)) { fs.rmSync(f); done.push(`removed  ${posix(f)}`); }
  }

  const note = notePath(claudeDir);
  if (fs.existsSync(note)) { fs.rmSync(note); done.push(`removed  ${posix(note)}`); }

  // settings.json is not ours to edit any more — we register nothing in it. Reading it here
  // only to leave it exactly as it is would be a good way to corrupt it for no reason.
  done.push('kept     settings.json (we put nothing in it)');
  done.push('kept     data/, out/, projects.json (your data)');
  return done;
}
