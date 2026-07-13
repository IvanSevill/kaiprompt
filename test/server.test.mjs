// `kaip serve` — la API que consume el móvil.
//
// Va por Tailscale, así que el móvil y este PC están en la misma red privada (WireGuard,
// cifrado extremo a extremo) y no pasa por servidores de nadie. Esa es la razón por la
// que la API NO recorta nada: sirve la conversación entera. Con un relay en la nube
// habría que ir con cuidado; aquí no hay nada de lo que ir con cuidado.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-server-'));
process.env.KAIP_HOME = TMP;

const { patchJob, saveQueue, saveSessions } = await import('../lib/store.mjs');
const { addJob } = await import('../lib/queue.mjs');
const { executeJob } = await import('../lib/runner.mjs');
const {
  addresses, createServer, pairingPayload, publish, resetToken, serverConfig,
} = await import('../lib/server.mjs');

const PORT = 7899;
let server;
let token;

const get = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  headers: opts.noAuth ? {} : { authorization: `Bearer ${opts.token ?? token}` },
  ...opts,
});

/** Una peticion cruda, para poder mandar cabeceras que fetch() prohibe (Host). */
const rawGet = (p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: p, method: 'GET', headers },
    (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    },
  );
  req.on('error', reject);
  req.end();
});

before(async () => {
  token = serverConfig().token;
  server = createServer({ port: PORT });
  await new Promise((r) => setTimeout(r, 200));
});

after(() => server?.close());

// --- quién puede entrar -------------------------------------------------------
test('sin token: 401. Aunque el cable ya sea privado, otro cacharro de tu tailnet no lee tus prompts', async () => {
  const r = await get('/api/state', { noAuth: true });
  assert.equal(r.status, 401);
});

test('con un token equivocado: 401', async () => {
  const r = await get('/api/state', { token: 'x'.repeat(32) });
  assert.equal(r.status, 401);
});

test('/api/ping NO pide token: es como el móvil sabe que el PC está encendido', async () => {
  const r = await get('/api/ping', { noAuth: true });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(body.host);
});

test('el token vale también en la query (el SSE de Android no manda cabeceras fácil)', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/state?token=${token}`);
  assert.equal(r.status, 200);
});

// --- la pantalla principal ----------------------------------------------------
test('/api/state: la cola, los contadores, el daemon y el cupo en UNA llamada', async () => {
  saveQueue([]);
  addJob({ prompt: 'pendiente', adapter: 'mock' });

  const s = await (await get('/api/state')).json();

  assert.equal(s.jobs.length, 1);
  assert.equal(s.counts.pending, 1);
  assert.ok('running' in s.daemon, 'el móvil necesita saber si algo va a dispararse siquiera');
  assert.ok('quota' in s);
});

test('/api/state: el prompt va ENTERO, no recortado (no sale de la máquina)', async () => {
  saveQueue([]);
  const largo = 'linea\n'.repeat(200);
  addJob({ prompt: largo, adapter: 'mock' });

  const s = await (await get('/api/state')).json();
  assert.equal(s.jobs[0].prompt, largo.trim(), 'sin truncar');
});

test('/api/state: un job enlazado (--from) resuelve su archivo', async () => {
  saveQueue([]);
  const f = path.join(TMP, 'p.md');
  fs.writeFileSync(f, 'vengo de un archivo');
  addJob({ from: f, adapter: 'mock' });

  const s = await (await get('/api/state')).json();
  assert.equal(s.jobs[0].prompt, 'vengo de un archivo');
  assert.ok(s.jobs[0].promptFile.endsWith('p.md'));
});

test('/api/state: si el archivo de un job enlazado ya no está, se dice — no se calla', async () => {
  saveQueue([]);
  const f = path.join(TMP, 'fugaz.md');
  fs.writeFileSync(f, 'x');
  addJob({ from: f, adapter: 'mock' });
  fs.rmSync(f);

  const s = await (await get('/api/state')).json();
  assert.equal(s.jobs[0].prompt, null);
  assert.match(s.jobs[0].promptError, /gone/i);
});

// --- la salida y la conversación ----------------------------------------------
test('/api/job/:id: el job con su respuesta final', async () => {
  saveQueue([]);
  const j = addJob({ prompt: 'hola', adapter: 'mock' });
  await executeJob(j);
  patchJob(j);                                          // igual que hace el runner

  const body = await (await get(`/api/job/${j.id}`)).json();
  assert.equal(body.id, j.id);
  assert.equal(body.status, 'done');
  assert.match(body.output, /\[mock\]/);
});

test('/api/job/:id de algo que no existe: 404 limpio', async () => {
  const r = await get('/api/job/noexiste');
  assert.equal(r.status, 404);
});

test('/api/targets: las conversaciones, agrupadas — varios jobs comparten un chat', async () => {
  saveQueue([]);
  saveSessions({ fixes: { sessionId: 'sess-9', adapter: 'claude', updatedAt: 5 } });
  addJob({ prompt: 'a', target: 'fixes', adapter: 'mock' });
  addJob({ prompt: 'b', target: 'fixes', adapter: 'mock' });

  const [t] = await (await get('/api/targets')).json();
  assert.equal(t.target, 'fixes');
  assert.equal(t.sessionId, 'sess-9');
  assert.equal(t.jobs.length, 2, 'los dos jobs cuelgan de la misma conversación');
});

test('/api/job/:id/chat sin transcript: 404 con motivo, no un 500', async () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x', adapter: 'mock' });
  await executeJob(j);
  patchJob(j);                                           // el mock no escribe transcript
  const r = await get(`/api/job/${j.id}/chat`);
  assert.equal(r.status, 404);
});

// --- emparejar ----------------------------------------------------------------
test('pairingPayload: lleva a dónde conectarse y con qué', () => {
  const p = pairingPayload(PORT);
  assert.equal(p.v, 1);
  assert.match(p.url, /^http:\/\//);
  assert.equal(p.token, serverConfig().token);
  assert.ok(p.host);
});

test('addresses: la de Tailscale va PRIMERO (es la única que sirve fuera de casa)', () => {
  const list = addresses(PORT);
  const i = list.findIndex((a) => a.tailscale);
  if (i >= 0) assert.equal(i, 0, 'si hay Tailscale, tiene que ir la primera');
});

test('el token se conserva entre llamadas (re-emparejar no debe echar al móvil de la mesilla)', () => {
  assert.equal(serverConfig().token, serverConfig().token);
});

test('serve --reset rota el token: los móviles emparejados dejan de entrar', async () => {
  const viejo = serverConfig().token;
  const nuevo = resetToken();
  assert.notEqual(nuevo, viejo);

  const r = await get('/api/state', { token: viejo });
  assert.equal(r.status, 401, 'el token viejo ya no vale');

  token = nuevo;
  assert.equal((await get('/api/state')).status, 200);
});

// --- registrar el móvil para los avisos ---------------------------------------
test('POST /api/device: el móvil dice dónde avisarle (el webhook PC → móvil)', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/device`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://100.1.2.3:8899/job-done', name: 'pixel' }),
  });
  assert.equal(r.status, 200);
  assert.ok(serverConfig().devices.some((d) => d.name === 'pixel'));
});

test('POST /api/device sin url: 400 (sin dirección no hay a quién avisar)', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/device`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'sin-url' }),
  });
  assert.equal(r.status, 400);
});

// --- la vista en vivo ----------------------------------------------------------
test('/api/events: SSE, y lo que publique el runner llega al móvil', async () => {
  const ctrl = new AbortController();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/events?token=${token}`, { signal: ctrl.signal });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');

  const reader = r.body.getReader();
  await new Promise((res) => setTimeout(res, 100));
  publish({ type: 'job', id: 'j1', status: 'running' });

  let got = '';
  const deadline = Date.now() + 3000;
  while (!got.includes('"id":"j1"') && Date.now() < deadline) {
    const { value } = await reader.read();
    got += new TextDecoder().decode(value ?? new Uint8Array());
  }
  ctrl.abort();

  assert.match(got, /"type":"job"/);
  assert.match(got, /"status":"running"/);
});

// --- lo que ve Cloudflare -----------------------------------------------------
// El tunel pasa por Cloudflare, que termina el TLS. Estos tests fijan la unica cosa
// que hace eso aceptable: que lo que viaja sea ilegible para quien mueve el cable.

test('la app pide sobre sellado y el prompt NO viaja en claro por el tunel', async () => {
  const { open } = await import('../lib/crypto.mjs');
  saveQueue([]);
  addJob({ prompt: 'la clave del servidor es hunter2', adapter: 'mock' });

  const r = await fetch(`http://127.0.0.1:${PORT}/api/state`, {
    headers: { authorization: `Bearer ${token}`, 'x-kaip-enc': '1' },
  });
  const crudo = await r.text();

  assert.equal(r.headers.get('x-kaip-enc'), '1', 'avisa de que va sellado');
  assert.ok(!crudo.includes('hunter2'), 'Cloudflare NO puede leer el prompt');
  assert.ok(!crudo.includes('prompt'), 'ni los nombres de los campos');

  // Y el movil, que si tiene la clave, lo abre entero.
  const s = open(JSON.parse(crudo), serverConfig().key);
  assert.equal(s.jobs[0].prompt, 'la clave del servidor es hunter2');
});

test('sin pedirlo, sigue saliendo JSON plano (curl, tests, y una LAN donde no hay nada que esconder)', async () => {
  saveQueue([]);
  addJob({ prompt: 'a la vista', adapter: 'mock' });
  const s = await (await get('/api/state')).json();
  assert.equal(s.jobs[0].prompt, 'a la vista');
});

test('el 401 NO va sellado: quien trae la clave mal debe poder leer POR QUE se le echa', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/state`, {
    headers: { authorization: 'Bearer noesvalido', 'x-kaip-enc': '1' },
  });
  assert.equal(r.status, 401);
  assert.match(await r.text(), /unauthorized/);
});

test('serve --reset rota TAMBIEN la clave: un movil perdido no puede seguir descifrando', async () => {
  const { resetToken: rota } = await import('../lib/server.mjs');
  const claveVieja = serverConfig().key;
  rota();
  assert.notEqual(serverConfig().key, claveVieja, 'la clave se va con el token');
  token = serverConfig().token;
});

// --- el APK: dónde lo deja Gradle de verdad ----------------------------------
// apkPath miraba en app/build/… pero Gradle escribe en app/APP/build/… (el módulo se llama
// "app" y vive dentro de la carpeta "app"). Nunca encontraba nada: "kaip app build" decía
// "✓ APK listo" y a continuación imprimía null, y /apk contestaba "no apk built yet" con el
// APK ahí mismo, en disco. El móvil no podía descargarse la app desde el PC.
test('apkPath: encuentra el APK donde Gradle lo deja de verdad', async () => {
  const { apkPath } = await import('../lib/server.mjs');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-apk-'));

  assert.equal(apkPath(raiz), null, 'sin compilar, null (y así lo puede decir)');

  const dir = path.join(raiz, 'app', 'app', 'build', 'outputs', 'apk', 'release');
  fs.mkdirSync(dir, { recursive: true });
  const apk = path.join(dir, 'app-release.apk');
  fs.writeFileSync(apk, 'no soy un apk, pero existo');

  assert.equal(apkPath(raiz), apk, 'la ruta que produce ":app:assembleRelease"');
});

test('apkPath: un APK puesto a mano gana al de la compilación', async () => {
  const { apkPath } = await import('../lib/server.mjs');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-apk-'));

  const build = path.join(raiz, 'app', 'app', 'build', 'outputs', 'apk', 'debug');
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, 'app-debug.apk'), 'x');

  const aMano = path.join(raiz, 'app', 'kaiprompt.apk');
  fs.writeFileSync(aMano, 'x');

  assert.equal(apkPath(raiz), aMano, 'una release descargada manda sobre un debug viejo');
});

// --- /pair: la página que regala las llaves -----------------------------------
// Sirve el token Y la clave de cifrado SIN autenticación: solo vale porque únicamente se
// llega a ella desde esta máquina. Mirar la IP del socket no basta — con DNS rebinding, una
// web (evil.com apuntando a 127.0.0.1) hace que sea el NAVEGADOR DE LA VÍCTIMA quien abra la
// conexión: el socket es loopback y pasa el filtro, pero el origen sigue siendo evil.com, así
// que su JavaScript puede leer la respuesta. Se llevaría la caja fuerte entera con solo
// visitar una página. La cabecera Host es lo que lo cierra: el navegador manda el nombre que
// tecleó el usuario, no la IP a la que resolvió.
test('/pair desde localhost: sirve la página de emparejamiento', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/pair`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
});

test('/pair con un Host ajeno (DNS rebinding): 404, aunque el socket sea loopback', async () => {
  // fetch() no deja falsificar Host (es cabecera prohibida), y el ataque real lo hace el
  // navegador solito. Con node:http mandamos la petición TAL CUAL llegaría: socket loopback
  // —lo abre la víctima— y Host: evil.com, que es el nombre que ella tecleó.
  const { status, body } = await rawGet('/pair', { host: 'evil.com' });

  assert.equal(status, 404, 'esto es exactamente el ataque: no puede devolver la página');
  assert.doesNotMatch(body, /token|key/i, 'y desde luego no las llaves');
});

test('/pair no se deja enmarcar ni hablar por scripts de fuera', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/pair`);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
});

test('fromLoopback: pide las DOS cosas — socket local y Host local', async () => {
  const { fromLoopback } = await import('../lib/server.mjs');
  const req = (address, host) => ({ socket: { remoteAddress: address }, headers: { host } });

  assert.equal(fromLoopback(req('127.0.0.1', 'localhost:7777')), true);
  assert.equal(fromLoopback(req('::1', '[::1]:7777')), true);

  assert.equal(fromLoopback(req('127.0.0.1', 'evil.com')), false, 'DNS rebinding');
  assert.equal(fromLoopback(req('192.168.1.50', 'localhost:7777')), false, 'otra máquina de la red');
  assert.equal(fromLoopback(req('127.0.0.1', undefined)), false, 'sin Host no se fía');
});
