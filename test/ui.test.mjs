import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bar, bigText, bigWidth, box, c, centerLine, strip, toolSummary, trunc, width, wrap,
} from '../lib/ui.mjs';

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
