// El PC llamando al movil cuando un lanzamiento termina.
//
// Yo habia construido el RECEPTOR en el movil y no el emisor: la notificacion no habria
// llegado nunca y no habria forma de darse cuenta salvo con el movil en la mano a las 3am.
// Este test es el que lo impide.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-notify-'));
process.env.KAIP_HOME = TMP;

const { saveQueue } = await import('../lib/store.mjs');
const { addJob } = await import('../lib/queue.mjs');
const { notifyFinished } = await import('../lib/notify.mjs');
const { saveServerConfig, serverConfig } = await import('../lib/server.mjs');

// Un movil de mentira: escucha como escucha el de verdad (un POST con JSON).
const recibidos = [];
let phone;
const PORT = 8901;

before(async () => {
  phone = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      recibidos.push(JSON.parse(body || '{}'));
      res.writeHead(204).end();
    });
  });
  phone.listen(PORT, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 150));
});

after(() => phone?.close());

const emparejar = (url) => {
  const conf = serverConfig();
  conf.devices = url ? [{ url, name: 'movil-de-prueba', pairedAt: Date.now() }] : [];
  saveServerConfig(conf);
};

test('un job terminado hace que el PC llame al movil', async () => {
  recibidos.length = 0;
  emparejar(`http://127.0.0.1:${PORT}/job-done`);
  saveQueue([]);

  const j = addJob({ prompt: 'corre los tests', adapter: 'mock' });
  j.status = 'done';
  j.finishedAt = Date.now();

  const r = await notifyFinished(j);

  assert.equal(r.sent, 1);
  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].id, j.id);
  assert.equal(recibidos[0].status, 'done');
  assert.match(recibidos[0].preview, /corre los tests/);
});

test('un job FALLADO tambien avisa, y con el motivo', async () => {
  recibidos.length = 0;
  emparejar(`http://127.0.0.1:${PORT}/job-done`);

  const j = addJob({ prompt: 'algo', adapter: 'mock' });
  j.status = 'error';
  j.error = 'se acabo el cupo';
  j.finishedAt = Date.now();

  await notifyFinished(j);
  assert.equal(recibidos[0].status, 'error');
  assert.equal(recibidos[0].error, 'se acabo el cupo');
});

test('sin movil emparejado no se llama a nadie (y no revienta)', async () => {
  recibidos.length = 0;
  emparejar(null);

  const j = addJob({ prompt: 'x', adapter: 'mock' });
  j.status = 'done';

  const r = await notifyFinished(j);
  assert.equal(r.sent, 0);
  assert.equal(recibidos.length, 0);
});

test('un movil APAGADO no rompe nada: el lanzamiento SI termino', async () => {
  // Lo importante de verdad. Un lanzamiento no puede darse por fallido porque no se haya
  // podido entregar una notificacion. El trabajo se hizo; el movil se perdio la noticia,
  // y el poll de la app lo recogera luego.
  recibidos.length = 0;
  emparejar('http://127.0.0.1:9/nadie-escucha-aqui');

  const j = addJob({ prompt: 'x', adapter: 'mock' });
  j.status = 'done';

  const r = await notifyFinished(j);       // no debe lanzar
  assert.equal(r.sent, 0);
  assert.equal(r.dropped, 1);
});

test('el movil no se DESEMPAREJA por no contestar una vez', async () => {
  // Si lo borraramos al primer fallo, un tunel de la autopista te desemparejaria el movil.
  emparejar('http://127.0.0.1:9/nadie');
  const j = addJob({ prompt: 'x', adapter: 'mock' });
  j.status = 'done';

  await notifyFinished(j);
  assert.equal(serverConfig().devices.length, 1, 'sigue emparejado');
});
