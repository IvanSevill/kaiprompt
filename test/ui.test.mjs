import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bar, bigText, bigWidth, box, c, centerBlock, centerLine, fit, paint, strip, toolLines, toolSummary,
  trunc, width, wrap, writeLines,
} from '../lib/ui.mjs';

/** Pretend stdout is a terminal and capture what gets written to it. */
function asTTY(fn) {
  const { isTTY, write } = process.stdout;
  const out = [];
  process.stdout.isTTY = true;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { fn(); } finally {
    process.stdout.write = write;
    process.stdout.isTTY = isTTY;
  }
  return out.join('');
}

// Sin TTY (los tests corren con la salida redirigida) los helpers de color no pintan:
// eso es justo lo que garantiza que el modo desatendido salga en texto plano.

test('sin TTY no se emiten códigos de color', () => {
  assert.equal(c.accent('hola'), 'hola');
  assert.equal(c.bold('hola'), 'hola');
});

test('strip/width ignoran los códigos ANSI', () => {
  const s = '\x1b[38;2;1;2;3mhola\x1b[39m';
  assert.equal(strip(s), 'hola');
  assert.equal(width(s), 4);
});

test('trunc: recorta y añade elipsis, colapsa espacios', () => {
  assert.equal(trunc('hola   mundo', 20), 'hola mundo');
  assert.equal(trunc('x'.repeat(30), 10).length, 10);
  assert.ok(trunc('x'.repeat(30), 10).endsWith('…'));
  assert.equal(trunc(undefined, 5), '');
});

test('centerLine centra por ancho visible', () => {
  assert.equal(centerLine('ab', 10), ' '.repeat(4) + 'ab');
  assert.equal(width(centerLine('ab', 10)), 6);
});

// --- centerBlock -------------------------------------------------------------
// Regresión visual: centrar CADA línea por su cuenta descuadra el conjunto — una barra
// corta se iba flotando a un lado mientras la caja ancha quedaba en el medio. Un bloque
// se centra como bloque: todas las líneas arrancan en la misma columna.

test('centerBlock: todas las líneas empiezan en la MISMA columna', () => {
  const lines = centerBlock(['caja muy ancha de aqui a alli', 'corto', 'x'], 60);
  const sangrias = lines.map((l) => l.length - l.trimStart().length);
  assert.equal(new Set(sangrias).size, 1, 'una sola sangría para todas');
});

test('centerBlock: el bloque queda centrado por su línea más ancha', () => {
  const ancha = 'x'.repeat(20);
  const [primera] = centerBlock([ancha, 'y'], 40);
  assert.equal(primera.length - primera.trimStart().length, 10, '(40 - 20) / 2');
});

test('centerBlock: mide por ancho visible, los colores no descuadran', () => {
  const lines = centerBlock([c.accent('hola'), 'hola'], 20);
  const sangrias = lines.map((l) => strip(l).length - strip(l).trimStart().length);
  assert.equal(new Set(sangrias).size, 1, 'el color no debe empujar la línea');
});

test('centerBlock: nada desborda la terminal', () => {
  const lines = centerBlock(['x'.repeat(200)], 40);
  assert.ok(lines.every((l) => width(l) <= 40));
});

// --- fit (ninguna línea puede desbordar la terminal) ------------------------
test('fit: deja pasar lo que cabe, recorta lo que no', () => {
  assert.equal(fit('hola', 10), 'hola');
  assert.equal(width(fit('x'.repeat(30), 10)), 10);
});

test('fit: mide por ancho visible, no por bytes (los ANSI no ocupan)', () => {
  const coloreada = '\x1b[38;2;1;2;3mhola\x1b[39m';
  assert.equal(fit(coloreada, 10), coloreada, 'cabe: se respeta el color');
  assert.ok(width(fit(coloreada, 2)) <= 2, 'no cabe: se recorta al ancho visible');
});

// --- wrap (párrafos del visor de chat) --------------------------------------
test('wrap: parte por palabras sin pasarse del ancho', () => {
  const lineas = wrap('uno dos tres cuatro cinco seis', 10);
  assert.ok(lineas.every((l) => l.length <= 10));
  assert.equal(lineas.join(' '), 'uno dos tres cuatro cinco seis', 'sin perder ni una palabra');
});

test('wrap: respeta los saltos de línea que ya había', () => {
  assert.deepEqual(wrap('uno\ndos', 20), ['uno', 'dos']);
});

test('wrap: una palabra más larga que el ancho se trocea (si no, descuadra la caja)', () => {
  const lineas = wrap('x'.repeat(25), 10);
  assert.ok(lineas.every((l) => l.length <= 10));
  assert.equal(lineas.join(''), 'x'.repeat(25));
});

test('wrap: vacío o nulo no rompe', () => {
  assert.deepEqual(wrap('', 10), ['']);
  assert.deepEqual(wrap(undefined, 10), ['']);
});

// --- toolSummary (una llamada a herramienta en una línea) -------------------
test('toolSummary: elige el argumento que importa de cada herramienta', () => {
  assert.deepEqual(toolSummary('Read', { file_path: 'app/main.py' }), { name: 'Read', arg: 'app/main.py' });
  assert.deepEqual(toolSummary('Bash', { command: 'npm test' }), { name: 'Bash', arg: 'npm test' });
  assert.deepEqual(toolSummary('Grep', { pattern: 'TODO' }), { name: 'Grep', arg: 'TODO' });
});

test('toolSummary: sin argumento reconocible, solo el nombre', () => {
  assert.deepEqual(toolSummary('TodoWrite', { todos: [] }), { name: 'TodoWrite', arg: '' });
  assert.deepEqual(toolSummary('X', undefined), { name: 'X', arg: '' });
});

test('toolSummary: recorta el argumento largo al ancho disponible', () => {
  const { arg } = toolSummary('Bash', { command: 'x'.repeat(200) }, 40);
  assert.ok(arg.length <= 40);
  assert.ok(arg.endsWith('…'));
});

// --- dígitos gigantes (el reloj) --------------------------------------------
test('bigText: siempre 5 filas', () => {
  assert.equal(bigText('00:00:00').length, 5);
  assert.equal(bigText('12:34:56').length, 5);
});

test('bigText: todas las filas miden lo mismo, y bigWidth lo predice', () => {
  const txt = '02:34:11';
  const rows = bigText(txt);
  const anchos = rows.map(width);
  assert.equal(new Set(anchos).size, 1, 'filas desiguales romperían el centrado');
  assert.equal(anchos[0], bigWidth(txt), 'bigWidth debe coincidir con el ancho real');
});

test('bigText: dibuja los 10 dígitos y los dos puntos', () => {
  for (const ch of '0123456789') {
    const rows = bigText(ch);
    assert.ok(rows.some((r) => r.includes('█')), `el dígito ${ch} debe pintar algo`);
  }
  assert.ok(bigText(':').some((r) => r.includes('█')));
});

test('bigText: ignora caracteres no soportados sin romper', () => {
  assert.equal(bigText('ab').length, 5);
  assert.equal(bigWidth('ab'), 0);
});

test('bigText: la escala cambia el ancho, no la altura', () => {
  assert.equal(bigText('12', { scale: 1 }).length, 5);
  assert.ok(bigWidth('12', { scale: 2 }) > bigWidth('12', { scale: 1 }));
});

// --- toolLines (lo que se ve mientras el lanzamiento corre) -----------------
// Un "Edit(archivo)" pelado no dice QUÉ cambió, y un "TodoWrite" pelado no dice nada.

test('toolLines: TodoWrite enseña las tareas, no una llamada vacía', () => {
  const lines = toolLines('TodoWrite', {
    todos: [
      { content: 'leer el codigo', status: 'completed' },
      { content: 'arreglar el bug', status: 'in_progress' },
      { content: 'correr los tests', status: 'pending' },
    ],
  }, 60).map(strip);

  assert.ok(lines[0].includes('TodoWrite'));
  assert.ok(lines.some((l) => l.includes('✓') && l.includes('leer el codigo')));
  assert.ok(lines.some((l) => l.includes('▶') && l.includes('arreglar el bug')));
  assert.ok(lines.some((l) => l.includes('·') && l.includes('correr los tests')));
});

test('toolLines: TodoWrite sin tareas no revienta', () => {
  assert.equal(toolLines('TodoWrite', {}, 60).length, 1);
  assert.equal(toolLines('TodoWrite', undefined, 60).length, 1);
});

test('toolLines: Edit enseña el cambio, lo que sale y lo que entra', () => {
  const lines = toolLines('Edit', {
    file_path: 'lib/ui.mjs', old_string: 'join("\\n")', new_string: 'join("\\r\\n")',
  }, 60).map(strip);

  assert.ok(lines[0].includes('Edit') && lines[0].includes('lib/ui.mjs'));
  assert.ok(lines.some((l) => l.trim().startsWith('-') && l.includes('join')));
  assert.ok(lines.some((l) => l.trim().startsWith('+') && l.includes('join')));
});

test('toolLines: un Edit gigante se recorta (si no, tapa la pantalla)', () => {
  const big = Array.from({ length: 40 }, (_, i) => `linea ${i}`).join('\n');
  const lines = toolLines('Edit', { file_path: 'x', old_string: big, new_string: big }, 60).map(strip);
  assert.ok(lines.length < 12, `demasiadas lineas: ${lines.length}`);
  assert.ok(lines.some((l) => l.includes('…')), 'debe avisar de lo que oculta');
});

test('toolLines: MultiEdit muestra todos los cambios', () => {
  const lines = toolLines('MultiEdit', {
    file_path: 'a.mjs',
    edits: [
      { old_string: 'uno', new_string: 'UNO' },
      { old_string: 'dos', new_string: 'DOS' },
    ],
  }, 60).map(strip).join('\n');
  for (const s of ['uno', 'UNO', 'dos', 'DOS']) assert.ok(lines.includes(s), s);
});

test('toolLines: Write dice cuántas líneas escribe', () => {
  const lines = toolLines('Write', { file_path: 'x.mjs', content: 'a\nb\nc' }, 60).map(strip);
  assert.ok(lines.some((l) => l.includes('3 lines')));
});

test('toolLines: una herramienta cualquiera sigue siendo una sola línea', () => {
  const lines = toolLines('Bash', { command: 'npm test' }, 60);
  assert.equal(lines.length, 1);
  assert.ok(strip(lines[0]).includes('Bash') && strip(lines[0]).includes('npm test'));
});

// --- pintado en crudo -------------------------------------------------------
// Regresión: la GUI salía en escalera. El modo raw (necesario para leer teclas
// sueltas) también apaga la traducción LF→CRLF de SALIDA, así que un "\n" pelado
// baja una fila pero NO vuelve a la columna 0. Con CRLF va bien en ambos modos.

test('paint: separa las líneas con CRLF, nunca con LF pelado', () => {
  const out = asTTY(() => paint(['uno', 'dos', 'tres']));
  assert.ok(out.includes('uno\r\ndos\r\ntres'), 'las filas deben ir con CRLF');
  assert.ok(!/[^\r]\n/.test(out), 'ni un solo LF sin su CR delante');
});

test('paint: limpia la pantalla antes de pintar (si no, quedan restos del frame anterior)', () => {
  const out = asTTY(() => paint(['x']));
  assert.ok(out.includes('\x1b[2J'), 'debe borrar');
  assert.ok(out.includes('\x1b[H'), 'y volver al origen');
});

test('paint: sin TTY sale texto plano, sin códigos ANSI (el modo desatendido)', () => {
  const logged = [];
  const log = console.log;
  console.log = (s) => logged.push(s);
  try { paint([c.accent('hola'), 'adios']); } finally { console.log = log; }
  assert.equal(logged.join(''), 'hola\nadios');
});

test('writeLines: convierte los saltos del texto a CRLF (el visor de chat en la GUI)', () => {
  const out = asTTY(() => writeLines('linea1\nlinea2'));
  assert.ok(out.startsWith('linea1\r\nlinea2'));
  assert.ok(!/[^\r]\n/.test(out));
});

// --- barra y caja -----------------------------------------------------------
test('bar: acota entre 0 y 100', () => {
  assert.ok(strip(bar(0, 10)).startsWith('░'));
  assert.ok(strip(bar(100, 10)).startsWith('█'.repeat(10)));
  assert.ok(strip(bar(-50, 10)).includes('0%'));
  assert.ok(strip(bar(500, 10)).includes('100%'));
});

test('box: bordes redondeados y contenido dentro', () => {
  const b = box(['hola'], { title: 'test' });
  assert.ok(strip(b[0]).startsWith('╭'));
  assert.ok(strip(b.at(-1)).startsWith('╰'));
  assert.ok(b.some((l) => l.includes('hola')));
});

test('box: todas las líneas del mismo ancho (si no, el marco se descuadra)', () => {
  const b = box(['corto', 'una linea bastante mas larga'], { title: 'x' });
  const anchos = b.map(width);
  assert.equal(new Set(anchos).size, 1);
});

test('box: una línea MÁS ANCHA que la caja se recorta, no empuja el borde', () => {
  // Regresión: el borde derecho se iba zigzagueando pantalla abajo, una distancia
  // distinta por cada línea larga. Se veía en la vista de detalle con prompts largos.
  const b = box(['x'.repeat(200), 'corto'], { title: 'job', cols: 40 });
  const anchos = b.map(width);
  assert.equal(new Set(anchos).size, 1, 'todas las filas al mismo ancho');
  assert.equal(anchos[0], 42, 'el ancho pedido + los dos bordes');
  for (const l of b.slice(1, -1)) {
    assert.ok(strip(l).startsWith('│') && strip(l).endsWith('│'), 'bordes en su sitio');
  }
});
