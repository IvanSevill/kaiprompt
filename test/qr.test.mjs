// El QR no es adorno: es la frontera de seguridad.
//
// Es lo que permite que la clave de cifrado llegue al móvil SIN pasar por el túnel que
// protege — la escaneas de tu propia pantalla. Si el QR no escanea, no hay emparejamiento;
// y si tuviéramos que traernos una librería de npm para pintarlo, romperíamos la única
// promesa que la herramienta hace sobre sí misma (cero dependencias).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encode, render } from '../lib/qr.mjs';

const size = (m) => m.length;
const version = (m) => (m.length - 17) / 4;

test('la matriz es cuadrada y de un tamaño válido (4v+17)', () => {
  const m = encode('hola');
  assert.equal(size(m), m[0].length);
  assert.ok(Number.isInteger(version(m)) && version(m) >= 1);
});

test('los tres patrones de localización están donde tienen que estar', () => {
  // Sin ellos el móvil ni siquiera encuentra el código en la foto.
  const m = encode('https://example.com');
  const n = size(m);

  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(m[r0][c0], 1, 'esquina exterior del finder');
    assert.equal(m[r0 + 3][c0 + 3], 1, 'el cuadrado central');
    assert.equal(m[r0 + 1][c0 + 1], 0, 'el anillo blanco');
  }
});

test('los patrones de sincronía alternan (es la regla que da la escala)', () => {
  const m = encode('algo mas largo para subir de version');
  for (let i = 8; i < size(m) - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0 ? 1 : 0, `fila de timing en ${i}`);
    assert.equal(m[i][6], i % 2 === 0 ? 1 : 0, `columna de timing en ${i}`);
  }
});

test('el módulo oscuro fijo está puesto (el estándar lo exige, siempre)', () => {
  const m = encode('x');
  assert.equal(m[size(m) - 8][8], 1);
});

test('toda la matriz es 0 o 1: ni un hueco sin rellenar', () => {
  // Un null suelto significa que un módulo se quedó sin escribir, y ahí el escáner lee basura.
  const m = encode('la clave del emparejamiento va aqui dentro');
  for (const row of m) for (const v of row) assert.ok(v === 0 || v === 1, `módulo inválido: ${v}`);
});

test('sube de versión según crece el contenido', () => {
  const corto = version(encode('hola'));
  const largo = version(encode('x'.repeat(300)));
  assert.ok(largo > corto, 'más datos, código más grande');
});

test('aguanta un payload de emparejamiento entero', () => {
  // Es EL caso de uso: url + token + clave de 32 bytes + host.
  const payload = JSON.stringify({
    v: 1,
    url: 'https://cansada-jirafa-verde-1234.trycloudflare.com',
    lan: 'http://192.168.1.23:7777',
    token: 'a'.repeat(32),
    key: 'b'.repeat(43),
    host: 'MI-ORDENADOR',
    tunnel: true,
  });
  const m = encode(payload);
  assert.ok(size(m) > 0);
  assert.ok(version(m) <= 20, 'tiene que caber en las versiones que soportamos');
});

test('un payload imposible falla claro, no calla', () => {
  assert.throws(() => encode('x'.repeat(5000)), /too much data/);
});

test('UTF-8 sin romperse (los acentos ocupan dos bytes)', () => {
  const m = encode('emparejar el móvil · configuración');
  assert.ok(size(m) > 0);
});

// --- pintado -------------------------------------------------------------------
test('render: incluye zona de silencio (sin margen, la mayoría de móviles lo ignoran)', () => {
  const m = encode('hola');
  const lines = render('hola', { quiet: 2 }).split('\n');

  // 2 de margen arriba y abajo, y dos filas por carácter.
  assert.equal(lines.length, Math.ceil((size(m) + 4) / 2));
  assert.equal(lines[0].length, size(m) + 4, 'margen a los lados también');

  // La primera fila cae entera dentro del margen: todo claro.
  assert.ok(/^█+$/.test(lines[0]), 'la zona de silencio tiene que estar vacía de verdad');
});

test('render: todas las líneas del mismo ancho (si no, el código sale torcido)', () => {
  const lines = render('https://github.com/algo/kaiprompt').split('\n');
  assert.equal(new Set(lines.map((l) => l.length)).size, 1);
});

test('render: el mismo texto da siempre el mismo código (es determinista)', () => {
  assert.equal(render('estable'), render('estable'));
});
