import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Este repo es PÚBLICO. Una ruta de home absoluta (del tipo "C:\Users\<...>" o "/home/<...>")
// filtra el nombre del usuario y, además, no funcionaría en la máquina de nadie más: la
// herramienta se instala donde se clone. El instalador ya escribe las rutas reales en tiempo
// de instalación, así que en el código fuente NO debe quedar ninguna.
//
// Este test es el cerrojo: si alguien vuelve a incrustar una ruta personal, salta aquí.

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'out', '.tasks']);
// Datos del usuario: viven en disco pero están en .gitignore, no se publican.
const SKIP_FILES = new Set(['projects.json', 'programados.jsonl']);
const SCAN_EXT = new Set(['.mjs', '.js', '.json', '.md', '.cmd', '.sh', '.yml', '.txt', '']);

// Marcadores de sitio: no son datos personales, son plantillas.
const PLACEHOLDERS = ['<your-user>', '<you>', '$USER', '%USERNAME%', '$env:USERPROFILE', '$HOME'];

/** Una carpeta de usuario con nombre: Users\<...>, Users/<...>, home/<...> (con o sin "C:"). */
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

test('sanitizado: ningún fichero del repo lleva una ruta de home personal', () => {
  const hits = [];

  for (const file of walk(REPO)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [match, user] of text.matchAll(HOME_PATH)) {
      if (PLACEHOLDERS.some((p) => match.includes(p) || user === p)) continue;
      const line = text.slice(0, text.indexOf(match)).split('\n').length;
      hits.push(`${path.relative(REPO, file)}:${line}  ${match}`);
    }
  }

  assert.deepEqual(hits, [], `rutas personales encontradas:\n  ${hits.join('\n  ')}`);
});

test('sanitizado: el barrido mira de verdad los ficheros (si no, no probaría nada)', () => {
  // Un test que no lee nada pasaría siempre: aquí verificamos que el walk encuentra el código.
  const files = walk(REPO).map((f) => path.relative(REPO, f).replace(/\\/g, '/'));
  assert.ok(files.includes('kaip.mjs'));
  assert.ok(files.includes('lib/install.mjs'));
  assert.ok(files.includes('README.md'));
  assert.ok(files.length > 15, `esperaba barrer el repo entero, solo vi ${files.length} ficheros`);
});

test('sanitizado: el detector reconoce una ruta personal si se cuela', () => {
  // El usuario se compone en tiempo de ejecución: escrito literal aquí, este mismo
  // fichero sería una ruta personal y el barrido de arriba se cazaría a sí mismo.
  const u = 'alguien';
  const malas = [
    `node "C:\\Users\\${u}\\.claude\\tools\\kaip\\kaip.mjs"`,
    `/home/${u}/.claude/tools/kaiprompt`,
    `/Users/${u}/.claude`,
  ];
  for (const mala of malas) {
    assert.equal([...mala.matchAll(HOME_PATH)].length, 1, `debe cazar: ${mala}`);
  }

  const buena = 'node "$env:USERPROFILE\\.claude\\tools\\kaip\\kaip.mjs"';
  assert.equal([...buena.matchAll(HOME_PATH)].length, 0, 'y dejar pasar el marcador de sitio');
});
