// Comandos fantasma: referencias a comandos que YA NO EXISTEN.
//
// `pair` se absorbió dentro de `serve`, y el nombre viejo se quedó vivo en el README, en un
// par de comentarios y —la que llegó al usuario— en la pantalla de emparejamiento de la app,
// que durante semanas mandó a la gente a teclear un comando que fallaba. Renombrar un
// comando es fácil; acordarse de los ocho sitios donde estaba escrito, no.
//
// Este test cierra los dos extremos:
//   1. la lista de lib/commands.mjs sigue siendo la del switch de kaip.mjs (no se desincroniza);
//   2. ninguna referencia del repo —README, HELP, GUI, skills, slash commands, la app— apunta
//      a un comando que no está en esa lista.
//
// Si mañana desaparece `mobile`, esto se pone rojo antes de que nadie lo teclee.

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

// --- 1. la lista no puede desincronizarse del dispatch ------------------------
test('la lista de comandos es EXACTAMENTE la que despacha kaip.mjs', () => {
  const src = fs.readFileSync(path.join(REPO, 'kaip.mjs'), 'utf8');
  const dispatch = src.slice(src.indexOf('// --- dispatch'));
  assert.ok(dispatch.length > 200, 'no encuentro el bloque de dispatch en kaip.mjs');

  const cases = [...dispatch.matchAll(/case '([^']+)':/g)]
    .map((m) => m[1])
    .filter((w) => !w.startsWith('-'));            // --help y -h son banderas, no comandos

  assert.deepEqual(
    [...new Set(cases)].sort(),
    [...COMMANDS].sort(),
    'lib/commands.mjs y el switch de kaip.mjs se han separado: uno de los dos miente',
  );
});

test('los subcomandos declarados son los que el switch de daemon acepta', () => {
  const src = fs.readFileSync(path.join(REPO, 'kaip.mjs'), 'utf8');
  const body = src.slice(src.indexOf('async function cmdDaemon'), src.indexOf('const APK_RELEASE'));
  const cases = [...body.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]);

  assert.deepEqual([...new Set(cases)].sort(), [...SUBCOMMANDS.daemon].sort());
});

// --- 2. nadie puede citar un comando que no existe ----------------------------
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
 * Una INVOCACIÓN, no la palabra "kaip" en una frase.
 *
 * Solo cuenta cuando el texto está escrito como se teclea: entre comillas, entre backticks,
 * entre «», o al principio de una línea (bloques de código y ejemplos del HELP). Si no, un
 * comentario como "how kaip leaves the screen" saldría como comando inexistente "leaves", y
 * un test que grita en falso se acaba ignorando — que es como se cuelan los de verdad.
 */
const INVOCATION = /(?:^\s*|[`'"«(])kaip ([a-z][a-z-]*)((?: [a-z][a-z-]*)?)/gm;

/** Cada referencia del repo: de dónde sale, qué comando cita y qué subcomando. */
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
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }   // fuera de este PC: se salta
    if (file === path.join(REPO, 'lib', 'commands.mjs')) continue;      // la propia lista
    if (file === fileURLToPath(import.meta.url)) continue;              // y este test

    for (const m of text.matchAll(INVOCATION)) {
      let [word, rest] = [m[1], m[2].trim()];
      if (ENGINES.includes(word)) {                 // "kaip claude add" → el motor no es el comando
        if (!rest) continue;
        [word, rest] = [rest, ''];
      }
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ file: path.relative(REPO, file), line, word, rest, text: m[0].trim() });
    }
  }
  return out;
}

test('el barrido encuentra las referencias de verdad (si no, no probaría nada)', () => {
  const refs = references();
  const files = new Set(refs.map((r) => r.file));

  assert.ok(refs.length > 30, `esperaba decenas de referencias, encontré ${refs.length}`);
  assert.ok([...files].some((f) => f === 'README.md'), 'el README debe entrar en el barrido');
  assert.ok([...files].some((f) => f === 'kaip.mjs'), 'el HELP de kaip.mjs también');
  assert.ok([...files].some((f) => f.endsWith('MainActivity.kt')), 'y la app de Android');
});

test('NINGUNA referencia apunta a un comando que no existe', () => {
  const fantasmas = references()
    .filter((r) => !isCommand(r.word))
    .map((r) => `${r.file}:${r.line}  «${r.text}» → no existe "${r.word}"`);

  assert.deepEqual(fantasmas, [], 'comandos fantasma:\n  ' + fantasmas.join('\n  '));
});

test('tampoco a un subcomando que no existe (kaip daemon <x>, kaip app <x>)', () => {
  const fantasmas = references()
    .filter((r) => SUBCOMMANDS[r.word] && r.rest && !SUBCOMMANDS[r.word].includes(r.rest))
    .map((r) => `${r.file}:${r.line}  «${r.text}» → "${r.word}" no tiene subcomando "${r.rest}"`);

  assert.deepEqual(fantasmas, [], 'subcomandos fantasma:\n  ' + fantasmas.join('\n  '));
});

test('"pair" está muerto y enterrado: lo absorbió "serve"', () => {
  // La regresión concreta que trajo aquí: la app mandaba a teclear «kaip pair».
  assert.equal(isCommand('pair'), false, 'pair ya no es un comando');

  const citas = references().filter((r) => r.word === 'pair');
  assert.deepEqual(citas.map((r) => `${r.file}:${r.line}`), [], 'todavía hay quien lo cita');
});

// --- el detector, probado: un test que no caza nada no protege de nada --------
test('el detector distingue una invocación de la palabra suelta en prosa', () => {
  const invocaciones = ['`kaip pair`', '"kaip pair"', '«kaip pair»', '  kaip pair --reset'];
  for (const s of invocaciones) {
    assert.deepEqual([...s.matchAll(INVOCATION)].map((m) => m[1]), ['pair'], `debe cazar: ${s}`);
  }

  const prosa = ['// how kaip leaves the screen', 'pregunte por kaip o kaip'];
  for (const s of prosa) {
    assert.deepEqual([...s.matchAll(INVOCATION)].map((m) => m[1]), [], `no debe saltar en prosa: ${s}`);
  }
});

test('el detector ve el comando detrás del motor (kaip claude add)', () => {
  const refs = [...'`kaip claude add "x"`'.matchAll(INVOCATION)];
  assert.equal(refs[0][1], 'claude');
  assert.equal(refs[0][2].trim(), 'add', 'y "add" es lo que hay que validar');
});
