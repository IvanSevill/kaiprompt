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

// --- vectores de referencia (los que habrian cazado los dos bugs) --------------
//
// Un QR mal hecho no "parece" mal: la camara lo encuentra, lo lee... y devuelve basura.
// Los tests estructurales de arriba pasaban con las dos manos rotas. Estos no: son
// matrices generadas por una implementacion de referencia (python-qrcode) y comparadas
// modulo a modulo.
//
// Los dos bugs que dejaron pasar:
//   1. Reed-Solomon: el polinomio generador se construye en potencias ASCENDENTES y el
//      bucle de division lo leia DESCENDENTE. Los bytes de datos salian perfectos y los
//      de correccion eran ruido, asi que el movil leia el codigo, fallaba el checksum y
//      no devolvia nada.
//   2. La info de formato iba TRANSPUESTA (fila 8 en vez de columna 8). El movil leia una
//      mascara equivocada y desenmascaraba los datos a basura: "ese QR no es de la app".

/**
 * La matriz EXACTA que produce una implementación de referencia (python-qrcode) para
 * "kaip-pair-abcdefghijklmnop" en v2, ECC M, máscara 1. 25x25, fila a fila.
 *
 * Esto es lo que de verdad habría cazado los dos bugs, y lo que los tests estructurales
 * de arriba dejaron pasar tan tranquilos.
 */
const REF_V2 = '1111111011100010001111111100000100000100010100000110111010110101100010111011011101000111110001011101101110100111101000101110110000010111100000010000011111111010101010101111111000000000001101110000000010100011010110011001001010010010100110101101000101010000101011101100010010100010000100100001100010100100011111101001101000011001011000010010110110000111111011110110111110111010010110010000010110010011110101110001000111111101000000000101111001000111011111111011010100101010101100000100011100110001100110111010000010011111100101011101001111101110010010101110101101110111001111110000010000110101001010001111111011001000110111001';

test('la matriz coincide MÓDULO A MÓDULO con una implementación de referencia', () => {
  // Con la máscara FIJADA: elegirla es una heurística de penalización, y dos codificadores
  // correctos pueden aterrizar legítimamente en máscaras distintas. Fijarla es la única
  // forma de distinguir "otra máscara" de "mal".
  const m = encode('kaip-pair-abcdefghijklmnop', { mask: 1 });
  assert.equal(m.length, 25, 'v2');

  const mio = m.flat().join('');
  assert.equal(mio.length, REF_V2.length);

  let distintos = 0;
  for (let i = 0; i < REF_V2.length; i++) if (mio[i] !== REF_V2[i]) distintos++;
  assert.equal(distintos, 0, distintos + ' módulos distintos de la referencia');
});

test('la información de formato NO va transpuesta (fila 8 vs columna 8)', () => {
  // Los 15 bits van dos veces, en angulo recto. Escribirlos girados deja un codigo que
  // sigue pareciendo un QR, que la camara encuentra... y que no decodifica: el movil lee
  // una mascara equivocada y desenmascara los datos a basura.
  const m = encode('kaip-pair-abcdefghijklmnop');
  const size = m.length;

  const leer = () => {
    const b = [];
    for (let i = 0; i <= 5; i++) b[i] = m[i][8];
    b[6] = m[7][8];
    b[7] = m[8][8];
    b[8] = m[8][7];
    for (let i = 9; i < 15; i++) b[i] = m[8][14 - i];
    return b.reduce((a, x, i) => a | (x << i), 0);
  };

  const validos = [];
  for (let lvl = 0; lvl < 4; lvl++) {
    for (let msk = 0; msk < 8; msk++) {
      const data = (lvl << 3) | msk;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      validos.push(((data << 10) | rem) ^ 0x5412);
    }
  }
  assert.ok(validos.includes(leer()), 'los bits de formato no decodifican a nada valido');

  const b2 = [];
  for (let i = 0; i < 8; i++) b2[i] = m[8][size - 1 - i];
  for (let i = 8; i < 15; i++) b2[i] = m[size - 15 + i][8];
  assert.equal(b2.reduce((a, x, i) => a | (x << i), 0), leer(), 'las dos copias se contradicen');
});

test('el módulo que SIEMPRE es oscuro lo es', () => {
  const m = encode('x');
  assert.equal(m[m.length - 8][8], 1);
});
