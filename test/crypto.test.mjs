// El cifrado extremo a extremo: lo que hace que el túnel de Cloudflare sea seguro.
//
// El túnel pasa por Cloudflare, que termina el TLS y PODRÍA leer lo que va dentro: tus
// prompts, tu código y todo lo que Claude conteste. Con esto, mueven bytes que no pueden
// abrir. La clave nace en el PC y llega al móvil por el QR — la escaneas de tu propia
// pantalla, así que nunca viaja por el cable que protege.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKey, open, seal, wantsSealed } from '../lib/crypto.mjs';

test('ida y vuelta: lo que sale es exactamente lo que entró', () => {
  const key = newKey();
  const dato = { jobs: [{ id: 'j1', prompt: 'no es asunto de Cloudflare' }], n: 42, ok: true };
  assert.deepEqual(open(seal(dato, key), key), dato);
});

test('el sobre NO lleva el texto en claro (es lo único que de verdad importa aquí)', () => {
  const key = newKey();
  const sobre = seal({ secreto: 'la clave del banco es 1234' }, key);
  const crudo = JSON.stringify(sobre);

  assert.ok(!crudo.includes('1234'), 'no puede aparecer el contenido');
  assert.ok(!crudo.includes('banco'), 'ni una palabra del original');
  assert.ok(!crudo.includes('secreto'), 'ni siquiera los nombres de los campos');
});

test('con la clave equivocada NO se descifra (no devuelve basura: falla)', () => {
  const sobre = seal({ a: 1 }, newKey());
  assert.throws(() => open(sobre, newKey()));
});

test('si alguien manipula el sobre por el camino, se rechaza', () => {
  // AES-GCM autentica además de cifrar: un payload tocado se rompe en vez de descifrarse
  // en silencio a otra cosa. Si Cloudflare cambiara un byte, nos enteramos.
  const key = newKey();
  const sobre = seal({ jobs: ['bueno'] }, key);

  const tocado = { ...sobre, ct: Buffer.from(sobre.ct, 'base64') };
  tocado.ct[0] ^= 0xff;                                  // un bit distinto
  tocado.ct = tocado.ct.toString('base64');

  assert.throws(() => open(tocado, key), /auth|tag|decrypt/i);
});

test('manipular la etiqueta de autenticidad tampoco cuela', () => {
  const key = newKey();
  const sobre = seal({ a: 1 }, key);
  assert.throws(() => open({ ...sobre, tag: Buffer.alloc(16).toString('base64') }, key));
});

test('cada sobre es distinto aunque el contenido sea el mismo (nonce nuevo cada vez)', () => {
  // Si no, un observador vería que dos respuestas son iguales sin abrirlas.
  const key = newKey();
  const a = seal({ mismo: 'dato' }, key);
  const b = seal({ mismo: 'dato' }, key);
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.iv, b.iv);
});

test('un sobre que no es un sobre no revienta el servidor', () => {
  assert.throws(() => open(null, newKey()), /not a sealed payload/);
  assert.throws(() => open({ hola: 1 }, newKey()), /not a sealed payload/);
});

test('las claves son distintas cada vez', () => {
  const claves = new Set(Array.from({ length: 100 }, () => newKey()));
  assert.equal(claves.size, 100);
});

test('wantsSealed: la app pide sobre por cabecera o por query', () => {
  const req = (headers, url = '/api/state') => ({ headers, url });
  assert.equal(wantsSealed(req({ 'x-kaip-enc': '1' })), true);
  assert.equal(wantsSealed(req({}, '/api/state?enc=1')), true);
  assert.equal(wantsSealed(req({})), false, 'curl y los tests siguen viendo JSON plano');
});
