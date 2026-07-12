#!/usr/bin/env node
// programar.mjs — añade lanzamientos a programados.jsonl.
//
// Dos modos:
//   1) HOOK (stdin JSON): lo llama el hook UserPromptSubmit. Si el usuario escribió
//      "/programar ..." o "programar ...", añade la línea y hace exit 2 (bloquea el
//      turno → NO llama al modelo → 0 tokens). Si no coincide, exit 0 (no molesta).
//   2) CLI (--cli "<cuándo> | <prompt> [| <target>]"): red de seguridad para el
//      comando /programar (commands/programar.md). Añade la línea y exit 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
// Los datos pueden vivir fuera del código (tests / instalación); por defecto, aquí mismo.
const HOME = process.env.PROGRAM_PROMPT_HOME || __dir;
const PROG = path.join(HOME, 'programados.jsonl');
const PROYECTOS = path.join(HOME, 'projects.json');

// resuelve carpeta: alias de projects.json → subcarpeta de _base (por nombre) → ruta literal
function resolveDir(v, fallback) {
  if (!v || typeof v !== 'string') return fallback || null;
  const raw = v.trim();
  let map = {};
  try { map = JSON.parse(fs.readFileSync(PROYECTOS, 'utf8')); } catch { /* sin config */ }
  const alias = Object.entries(map).find(([k]) => k !== '_base' && k.toLowerCase() === raw.toLowerCase());
  if (alias) return alias[1];
  if (map._base) {
    try {
      const hit = fs.readdirSync(map._base, { withFileTypes: true })
        .find((d) => d.isDirectory() && d.name.toLowerCase() === raw.toLowerCase());
      if (hit) return String(map._base).replace(/[\\/]+$/, '') + '/' + hit.name;
    } catch { /* _base no accesible */ }
  }
  return raw;
}

const EXIT_PASS = 0;   // dejar pasar el prompt
const EXIT_BLOCK = 2;  // bloquear el turno (0 tokens)

const nid = () => 'p' + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');

const USAGE = 'uso: /programar <cuándo> | <prompt> [| <target>] [| <carpeta>]\n' +
  '  cuándo:  09:00 · mañana 09:00 · +2h · lun 09:00 · 2026-07-12 09:00\n' +
  '  carpeta: nombre de proyecto (p.ej. miapp), alias o ruta. Por defecto, la actual.\n' +
  '  ej: /programar mañana 08:30 | revisa el PR y resume | repaso | miapp';

function parseWhen(input) {
  const s = String(input).trim().toLowerCase();
  let m;
  if ((m = s.match(/^\+(\d+)\s*([mhd])$/))) {
    const mult = { m: 60000, h: 3600000, d: 86400000 }[m[2]];
    return Date.now() + Number(m[1]) * mult;
  }
  if ((m = s.match(/^(mañana|manana|hoy)\s+(\d{1,2}):(\d{2})$/))) {
    const d = new Date(); d.setSeconds(0, 0); d.setHours(Number(m[2]), Number(m[3]));
    if (m[1] !== 'hoy') d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const wd = { dom: 0, lun: 1, mar: 2, 'mié': 3, mie: 3, jue: 4, vie: 5, 'sáb': 6, sab: 6 };
  if ((m = s.match(/^(dom|lun|mar|mié|mie|jue|vie|sáb|sab)\s+(\d{1,2}):(\d{2})$/))) {
    const d = new Date(); d.setSeconds(0, 0); d.setHours(Number(m[2]), Number(m[3]));
    let add = (wd[m[1]] - d.getDay() + 7) % 7;
    if (add === 0 && d.getTime() <= Date.now()) add = 7;
    d.setDate(d.getDate() + add);
    return d.getTime();
  }
  if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) {
    const d = new Date(); d.setSeconds(0, 0); d.setHours(Number(m[1]), Number(m[2]));
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  throw new Error(`no entiendo la hora "${input}"`);
}

// "<cuándo> | <prompt> [| <target>] [| <carpeta>]" -> {entry} | {error}
// dirFallback = carpeta donde se escribió /programar (cwd). La 4ª parte la sobreescribe:
// acepta nombre de proyecto (subcarpeta del _base), alias de projects.json, o ruta.
function buildEntry(rest, dirFallback) {
  const parts = String(rest).split('|').map((x) => x.trim());
  const when = parts[0] || '';
  const prompt = parts[1] || '';
  const target = parts[2] || null;
  const folder = parts[3] || '';
  const dir = resolveDir(folder, dirFallback);
  if (!when || !prompt) return { error: 'faltan campos' };
  let whenMs;
  try { whenMs = parseWhen(when); } catch (e) { return { error: e.message }; }
  return {
    entry: {
      id: nid(),
      at: new Date(whenMs).toISOString(),
      when: whenMs,
      target,
      prompt,
      adapter: 'claude',
      dir: dir || null,
      createdAt: Date.now(),
    },
  };
}

const appendEntry = (e) => fs.appendFileSync(PROG, JSON.stringify(e) + '\n');
const proj = (d) => (d ? String(d).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');
const confirm = (e) => `✓ programado para ${new Date(e.when).toLocaleString()}${e.target ? '  [' + e.target + ']' : ''}${e.dir ? '  en ' + proj(e.dir) : ''}\n  → ${e.prompt}`;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main() {
  const argv = process.argv.slice(2);

  // --- modo CLI (red de seguridad del comando /programar) ---
  const cli = argv.indexOf('--cli');
  if (cli !== -1) {
    let rest = argv.slice(cli + 1).join(' ').trim();
    rest = rest.replace(/^\/?programar\b\s*/i, '');   // por si llega con el prefijo
    const r = buildEntry(rest, process.cwd());
    if (r.error) { process.stdout.write('⚠ ' + r.error + '\n' + USAGE + '\n'); return 1; }
    appendEntry(r.entry);
    process.stdout.write(confirm(r.entry) + '\n  (guardado en programados.jsonl; lánzalo con: cq run)\n');
    return 0;
  }

  // --- modo HOOK (stdin JSON) ---
  let j;
  try { j = JSON.parse(readStdin() || '{}'); } catch { return EXIT_PASS; }
  const input = String(j.input ?? j.prompt ?? '');

  // "programar" seguido de espacio o fin — NO casa "/programar-prompt" ni otras palabras
  const m = input.trim().match(/^\/?programar(?:\s+([\s\S]*))?$/i);
  if (!m) return EXIT_PASS;                            // no es /programar → prompt normal

  const r = buildEntry((m[1] || '').trim(), j.cwd);   // dir = carpeta donde se escribió /programar
  if (r.error) { process.stderr.write('⚠ ' + r.error + '\n' + USAGE + '\n'); return EXIT_BLOCK; }
  appendEntry(r.entry);
  process.stderr.write(confirm(r.entry) + '\n  (0 tokens; lánzalo con: cq run)\n');
  return EXIT_BLOCK;                                   // bloquea el turno → no gasta tokens
}

process.exit(main());
