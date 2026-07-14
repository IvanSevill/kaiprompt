// El tunel: como el movil llega al PC desde cualquier red.
//
// No se abre un tunel de verdad aqui (eso depende de la red y de un binario externo, y un
// test que depende de internet es un test que falla los viernes). Se prueba lo que SI es
// nuestro: encontrar el binario, y explicarse cuando no esta.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TunnelError, findCloudflared, startTunnel } from '../lib/tunnel.mjs';

test('encuentra cloudflared aunque NO este en el PATH', () => {
  // El caso real, y el primero que le pasa a cualquiera: lo instalas con winget y lo
  // reintentas EN LA MISMA ventana, donde el PATH todavia no se ha refrescado. Mandarle a
  // abrir otro terminal es una respuesta pobre cuando podemos mirar donde vive.
  const bin = findCloudflared();
  assert.ok(typeof bin === 'string' && bin.length > 0);
});

test('si no esta instalado, el error DICE COMO instalarlo', async () => {
  // Un "ENOENT" pelado deja a la persona buscando en Google. El mensaje trae el comando.
  await assert.rejects(
    () => startTunnel(7999, { bin: 'no-existe-este-binario', timeoutMs: 3000 }),
    (e) => {
      assert.ok(e instanceof TunnelError);
      assert.match(e.message, /not installed/i);
      assert.match(e.message, /winget|brew/, 'tiene que traer el comando de instalacion');
      assert.match(e.message, /no Cloudflare account needed/i, 'y decir que no hace falta cuenta');
      return true;
    },
  );
});

test('una ruta con ESPACIOS se entrecomilla (cloudflared vive en "Program Files (x86)")', async () => {
  // El bug que se comio el primer intento: con shell:true, cmd leia "C:\Program" como el
  // comando y el resto como argumentos. No es un caso raro — es la ruta por defecto.
  await assert.rejects(
    () => startTunnel(7998, { bin: 'C:/ruta con espacios/no-existe.exe', timeoutMs: 4000 }),
    (e) => {
      assert.ok(e instanceof TunnelError);
      assert.doesNotMatch(e.message, /'C:\Program' is not recognized/i);
      assert.doesNotMatch(e.message, /'C:.ruta' is not recognized/i, 'la ruta NO puede partirse');
      return true;
    },
  );
});

// --- BUG 2: el movil no conectaba a la primera, y al rato si -------------------
//
// cloudflared imprime la URL cuando Cloudflare se la ASIGNA, no cuando su edge ya sabe
// enrutarla. Durante unos segundos ese dominio existe en DNS y contesta 502: la ruta todavia
// no esta montada.
//
// El QR se pintaba justo ahi. Y tu estas delante con el movil en la mano, asi que la
// PRIMERISIMA peticion que hace la app cae dentro de ese hueco. Falla, y parece un
// emparejamiento roto en vez de un tunel que aun no estaba. Esperas, reintentas, y va.
//
// Por eso ahora se le pregunta al tunel ANTES de repartir el QR.
test('waitForTunnel no da el visto bueno hasta que la URL contesta de verdad', async () => {
  const { waitForTunnel } = await import('../lib/tunnel.mjs');

  // Los dos primeros intentos: 502. El edge todavia no enruta. Justo el hueco del bug.
  const respuestas = [
    { ok: false, status: 502 },
    { ok: false, status: 502 },
    { ok: true, status: 200 },
  ];
  const pedidas = [];
  const fetchFn = async (url) => { pedidas.push(url); return respuestas.shift(); };

  const r = await waitForTunnel('https://algo.trycloudflare.com', {
    fetchFn,
    sleep: async () => {},
    timeoutMs: 30_000,
  });

  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3, 'insiste hasta que contesta: no se cree el primer 502');
  assert.ok(
    pedidas.every((u) => u === 'https://algo.trycloudflare.com/api/ping'),
    'sondea /api/ping, que es el unico endpoint sin token: prueba el camino entero',
  );
});

test('waitForTunnel se rinde sin romper: mejor un QR con reintento que ningun QR', async () => {
  const { waitForTunnel } = await import('../lib/tunnel.mjs');

  let t = 0;
  const r = await waitForTunnel('https://muerto.trycloudflare.com', {
    fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    sleep: async () => { t += 1000; },
    now: () => t,
    timeoutMs: 3000,
  });

  assert.equal(r.ok, false);
  assert.match(r.error, /ENOTFOUND/, 'dice POR QUE no contesta');
});
