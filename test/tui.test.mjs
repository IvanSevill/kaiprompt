import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tui-'));
process.env.KAIP_HOME = TMP;
// Añadir un job con hora arma el daemon (esa es la gracia). Aquí no: un test no puede
// dejar procesos de fondo vivos. Que se arme de verdad se prueba en daemon.test.mjs.
process.env.KAIP_NO_DAEMON = '1';
const { loadQueue, saveQueue, saveProjects, saveSessions } = await import('../lib/store.mjs');
const { addJob } = await import('../lib/queue.mjs');
const { strip } = await import('../lib/ui.mjs');
const {
  applyEffect, decodeKey, initialState, reduce, refresh, render, rows, selected, VIEWS,
} = await import('../lib/tui.mjs');

const DIMS = { cols: 100, rows: 30 };
const view = (state) => strip(render(state, DIMS).join('\n'));

/** Teclear una secuencia entera, como haría el usuario. Devuelve el estado y el último efecto. */
function press(state, keys) {
  let effect = null;
  for (const k of keys) ({ state, effect } = reduce(state, k));
  return { state, effect };
}

const fresh = () => refresh(initialState());

// --- teclas ------------------------------------------------------------------
test('decodeKey: flechas, enter, esc, backspace y Ctrl+C', () => {
  assert.equal(decodeKey('\x1b[A'), 'up');
  assert.equal(decodeKey('\x1b[B'), 'down');
  assert.equal(decodeKey('\x1b[C'), 'right');
  assert.equal(decodeKey('\x1b[D'), 'left');
  assert.equal(decodeKey('\r'), 'enter');
  assert.equal(decodeKey('\x1b'), 'esc');
  assert.equal(decodeKey('\x7f'), 'backspace');
  assert.equal(decodeKey('\x03'), 'ctrl-c');
  assert.equal(decodeKey(Buffer.from('a')), 'a', 'un carácter normal se devuelve tal cual');
});

// --- navegación --------------------------------------------------------------
test('vistas: tab y 1-4 cambian de vista, y dan la vuelta', () => {
  saveQueue([]);
  let s = fresh();
  assert.equal(s.view, 'queue');

  s = press(s, ['tab']).state;
  assert.equal(s.view, 'sessions');
  s = press(s, ['3']).state;
  assert.equal(s.view, 'projects');
  s = press(s, ['?']).state;
  assert.equal(s.view, 'help');
  s = press(s, ['tab']).state;
  assert.equal(s.view, 'queue', 'la última vuelve a la primera');
  s = press(s, ['left']).state;
  assert.equal(s.view, 'help', 'y hacia atrás igual');
});

test('↑↓ mueven la selección sin salirse de la lista', () => {
  saveQueue([]);
  addJob({ prompt: 'uno' }); addJob({ prompt: 'dos' });
  let s = fresh();

  assert.equal(s.sel, 0);
  s = press(s, ['up']).state;
  assert.equal(s.sel, 0, 'arriba del todo no se pasa');

  s = press(s, ['down', 'down', 'down']).state;
  assert.equal(s.sel, 1, 'ni abajo del todo');
  assert.equal(selected(s).prompt, 'dos');
});

test('q y Ctrl+C piden salir', () => {
  assert.deepEqual(reduce(fresh(), 'q').effect, { type: 'quit' });
  assert.deepEqual(reduce(fresh(), 'ctrl-c').effect, { type: 'quit' });
});

test('r lanza la cola (el reloj del runner)', () => {
  assert.deepEqual(reduce(fresh(), 'r').effect, { type: 'run' });
});

test('enter abre el detalle del job seleccionado, y esc lo cierra', () => {
  saveQueue([]); addJob({ prompt: 'revisa el PR' });
  let s = fresh();

  s = press(s, ['enter']).state;
  assert.ok(s.detail, 'hay overlay de detalle');
  assert.match(view(s), /revisa el PR/);

  s = press(s, ['esc']).state;
  assert.equal(s.detail, null);
});

test('o y c piden salida y chat del job seleccionado', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x' });
  const s = fresh();

  assert.deepEqual(reduce(s, 'o').effect, { type: 'out', id: j.id });
  assert.deepEqual(reduce(s, 'c').effect, { type: 'chat', ref: j.id });
});

test('con la cola vacía, las teclas de job no revientan', () => {
  saveQueue([]);
  const s = fresh();
  for (const k of ['enter', 'e', 'd', 'o', 'c']) {
    const { state, effect } = reduce(s, k);
    assert.equal(effect, null, `"${k}" no debe hacer nada sin selección`);
    assert.match(strip(state.message || ''), /nothing selected/);
  }
});

test('en la vista de chats, enter abre la conversación de ese target', () => {
  saveSessions({ fixes: { sessionId: 'sid-1', adapter: 'claude', updatedAt: 1 } });
  const s = press(fresh(), ['2']).state;
  assert.equal(rows(s).length, 1);
  assert.deepEqual(reduce(s, 'enter').effect, { type: 'chat', ref: 'fixes' });
});

// --- asistente de alta --------------------------------------------------------
test('a: el asistente recorre prompt → cuándo → target → carpeta → permisos', () => {
  saveQueue([]);
  let s = press(fresh(), ['a']).state;
  assert.ok(s.wizard, 'se abre el asistente');
  assert.equal(s.wizard.step, 0);

  // escribir el prompt letra a letra
  s = press(s, [...'/test']).state;
  assert.equal(s.wizard.buffer, '/test');
  assert.match(view(s), /Prompt/);

  s = press(s, ['enter']).state;
  assert.equal(s.wizard.step, 1, 'pasa a "cuándo"');
  s = press(s, [...'+2h', 'enter']).state;
  assert.equal(s.wizard.step, 2);
  s = press(s, [...'fixes', 'enter']).state;
  assert.equal(s.wizard.step, 3);
  s = press(s, ['enter']).state;                       // carpeta vacía → la actual
  assert.equal(s.wizard.step, 4, 'último paso: permisos');

  // los permisos se eligen con ← →, no se escriben
  assert.equal(s.wizard.values.perm, 'bypass');
  const conFlechas = press(s, ['right']).state;
  assert.equal(conFlechas.wizard.values.perm, 'acceptEdits');

  const { effect } = press(conFlechas, ['enter']);
  assert.equal(effect.type, 'add');
  assert.equal(effect.values.prompt, '/test');
  assert.equal(effect.values.when, '+2h');
  assert.equal(effect.values.target, 'fixes');
  assert.equal(effect.values.perm, 'acceptEdits');
});

test('asistente: backspace borra y esc cancela sin tocar la cola', () => {
  saveQueue([]);
  let s = press(fresh(), ['a', ...'hol', 'backspace']).state;
  assert.equal(s.wizard.buffer, 'ho');

  s = press(s, ['esc']).state;
  assert.equal(s.wizard, null);
  assert.equal(loadQueue().length, 0, 'cancelar no crea nada');
});

test('asistente: prompt vacío no avanza', () => {
  const { state, effect } = press(fresh(), ['a', 'enter']);
  assert.equal(effect, null);
  assert.equal(state.wizard.step, 0, 'sigue en el prompt');
  assert.match(strip(state.message), /cannot be empty/);
});

test('asistente: una hora imposible se caza aquí, no al lanzarse de madrugada', () => {
  const { state } = press(fresh(), ['a', ...'x', 'enter', ...'a las tantas', 'enter']);
  assert.equal(state.wizard.step, 1, 'se queda en "cuándo" para reescribirla');
  assert.match(strip(state.message), /can't parse time/);
});

// --- editar y borrar ----------------------------------------------------------
test('e: el asistente arranca con los valores del job', () => {
  saveQueue([]);
  addJob({ prompt: 'original', target: 'fixes', perm: 'acceptEdits' });
  const s = press(fresh(), ['e']).state;

  assert.equal(s.wizard.mode, 'edit');
  assert.equal(s.wizard.buffer, 'original', 'el prompt viene precargado');
  assert.equal(s.wizard.values.target, 'fixes');
  assert.equal(s.wizard.values.perm, 'acceptEdits');
});

test('e: un job done NO se edita (lo dice, y no abre el asistente)', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x' });
  saveQueue(loadQueue().map((x) => ({ ...x, status: 'done' })));
  const { state, effect } = press(fresh(), ['e']);

  assert.equal(state.wizard, null);
  assert.equal(effect, null);
  assert.match(strip(state.message), /only pending \(or missed\) jobs can be edited/);
  assert.equal(loadQueue()[0].id, j.id);
});

test('d: pregunta antes de borrar; "n" no borra, "y" sí', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'a borrar' });

  let s = press(fresh(), ['d']).state;
  assert.ok(s.confirm, 'pide confirmación');
  assert.match(strip(view(s)), /delete .*\[y\/n\]/s);

  const no = press(s, ['n']);
  assert.equal(no.effect, null);
  assert.equal(no.state.confirm, null);

  const si = press(s, ['y']);
  assert.deepEqual(si.effect, { type: 'delete', id: j.id });
});

// --- efectos que tocan el store ----------------------------------------------
test('applyEffect add: crea el job de verdad (mismo camino que la CLI)', () => {
  saveQueue([]);
  saveProjects({ mialias: 'C:/algun/sitio/MiApp' });
  const line = applyEffect({
    type: 'add',
    values: { prompt: '/test', when: '+2h', target: 'fixes', dir: 'mialias', perm: 'acceptEdits' },
  });

  const [j] = loadQueue();
  assert.equal(j.prompt, '/test');
  assert.equal(j.target, 'fixes');
  assert.equal(j.dir, 'C:/algun/sitio/MiApp', 'la carpeta se resuelve como en add');
  assert.equal(j.permMode, 'acceptEdits');
  assert.ok(j.when > Date.now());
  assert.match(strip(line), new RegExp(`\\+ ${j.id}`));
});

test('applyEffect add: "bypass" se guarda como null (el defecto de siempre)', () => {
  saveQueue([]);
  applyEffect({ type: 'add', values: { prompt: 'x', when: '', target: '', dir: '', perm: 'bypass' } });
  assert.equal(loadQueue()[0].permMode, null);
});

test('applyEffect edit: cambia el job, y vaciar un campo lo limpia', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'viejo', target: 'fixes', at: '+2h' });
  applyEffect({
    type: 'edit', id: j.id,
    values: { prompt: 'nuevo', when: '', target: '', dir: '', perm: 'bypass' },
  });

  const [n] = loadQueue();
  assert.equal(n.prompt, 'nuevo');
  assert.equal(n.when, null, 'vaciar "cuándo" lo devuelve a secuencial');
  assert.equal(n.target, null);
});

test('applyEffect delete: borra ese job', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x' });
  assert.match(strip(applyEffect({ type: 'delete', id: j.id })), /removed/);
  assert.equal(loadQueue().length, 0);
});

test('applyEffect: un error se enseña en la barra, no revienta la GUI', () => {
  saveQueue([]);
  const line = applyEffect({ type: 'edit', id: 'no-existe', values: { prompt: 'x', perm: 'bypass' } });
  assert.match(strip(line), /no job found/);
});

// --- pintado ------------------------------------------------------------------
test('render: pestañas, jobs, barra de atajos y marca de selección', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'revisa el PR', target: 'review' });
  const out = view(fresh());

  assert.match(out, /kaip/);
  assert.match(out, /Queue \(1\).*Chats.*Projects.*Help/s, 'las cuatro vistas');
  assert.match(out, new RegExp(j.id));
  assert.match(out, /revisa el PR/);
  assert.match(out, /▸/, 'la fila seleccionada va marcada');
  assert.match(out, /a add · e edit · d del · D daemon · r run now/, 'la barra de atajos');
});

// --- programar no es lanzar ---------------------------------------------------
// El malentendido que originó todo esto: abrir la GUI y que el prompt saliera disparado.
// La GUI no lanza NADA por su cuenta; solo escribe en la cola. Esto lo deja clavado.
test('la cabecera dice si el daemon está apagado (o los programados no saldrían)', () => {
  saveQueue([]);
  const out = view(fresh());
  assert.match(out, /daemon off/, 'apagado hay que decirlo, no esconderlo');
  assert.match(out, /will NOT fire/, 'y explicar la consecuencia');
});

test('"D" pide encender/apagar el daemon (y no lanza la cola)', () => {
  const { effect } = press(fresh(), ['D']);
  assert.deepEqual(effect, { type: 'daemon' });
});

test('"r" sigue siendo lo único que lanza la cola a mano', () => {
  const { effect } = press(fresh(), ['r']);
  assert.deepEqual(effect, { type: 'run' });
});

test('el asistente encola, no envía: ninguna tecla del alta dispara un lanzamiento', () => {
  saveQueue([]);
  const keys = [...'a', ...'hola', 'enter', ...'+2h', 'enter', 'enter', 'enter', 'enter'];
  let state = fresh(); let effect = null;
  for (const k of keys) {
    ({ state, effect } = reduce(state, k));
    assert.notEqual(effect?.type, 'run', 'en ningún momento se lanza nada');
  }
  assert.equal(effect.type, 'add', 'al final del asistente solo hay un alta');

  applyEffect(effect);
  const [job] = loadQueue();
  assert.equal(job.status, 'pending', 'queda pendiente: nadie lo ha enviado');
  assert.ok(job.when > Date.now(), 'con su hora, para que el daemon lo lance luego');
});

test('un alta SIN hora avisa de que solo saldrá en un run manual', () => {
  saveQueue([]);
  const line = strip(applyEffect({
    type: 'add',
    values: { prompt: 'sin hora', when: '', target: '', dir: '', perm: 'bypass' },
  }));
  assert.match(line, /sequential/i);
  assert.match(line, /only runs when you press "r"/i, 'sin sorpresas: no se lanza solo');
  assert.equal(loadQueue()[0].when, null);
});

test('render: las filas quedan en columnas (no se comen los espacios)', () => {
  // Regresión: recortar con trunc colapsaba los espacios seguidos y desalineaba
  // toda la lista ("pending seq claude/fixes" en vez de columnas).
  saveQueue([]);
  addJob({ prompt: 'uno' }); addJob({ prompt: 'dos' });
  const filas = render(fresh(), DIMS).map(strip).filter((l) => /pending/.test(l));

  assert.equal(filas.length, 2);
  for (const columna of ['pending', 'claude']) {
    const [a, b] = filas.map((l) => l.indexOf(columna));
    assert.equal(a, b, `la columna "${columna}" debe caer en el mismo sitio en todas las filas`);
  }
  assert.match(filas[0], / {2,}/, 'el relleno entre columnas debe sobrevivir al recorte');
});

test('render: la ayuda lista todas las teclas', () => {
  const out = view(press(fresh(), ['?']).state);
  for (const k of ['↑ ↓', 'enter', 'a', 'e', 'd', 'r', 'o', 'c', 'q']) {
    assert.ok(out.includes(k), `falta la tecla ${k}`);
  }
});

test('render: cola vacía invita a añadir, no se ve rota', () => {
  saveQueue([]);
  assert.match(view(fresh()), /empty queue/);
});

test('render: el marco no se pasa del ancho de la terminal', () => {
  saveQueue([]);
  addJob({ prompt: 'x'.repeat(300), target: 'largisimo-target-que-no-cabe' });
  const dims = { cols: 60, rows: 20 };
  for (const line of render(fresh(), dims)) {
    assert.ok(strip(line).length <= 60, `línea demasiado ancha: ${strip(line).length}`);
  }
});

test('render: con más jobs que filas, la selección sigue a la vista', () => {
  saveQueue([]);
  for (let i = 0; i < 40; i++) addJob({ prompt: `job ${i}` });
  let s = fresh();
  for (let i = 0; i < 39; i++) s = reduce(s, 'down').state;

  const out = view(s);
  assert.match(out, /job 39/, 'el seleccionado del final se ve');
  assert.doesNotMatch(out, /job 0\b/, 'y los de arriba han salido de pantalla');
});

test('render: el asistente se pinta con sus pasos y la pista de ayuda', () => {
  const s = press(fresh(), ['a', ...'hola']).state;
  const out = view(s);
  assert.match(out, /new launch · step 1\/5/);
  assert.match(out, /Prompt:/);
  assert.match(out, /hola/);
  assert.match(out, /enter: next · esc: cancel/);
});

test('refresh: si la cola encoge, la selección no se queda fuera', () => {
  saveQueue([]);
  addJob({ prompt: 'a' }); addJob({ prompt: 'b' });
  let s = press(fresh(), ['down']).state;
  assert.equal(s.sel, 1);

  saveQueue([loadQueue()[0]]);                 // alguien borra un job por la CLI
  s = refresh(s);
  assert.equal(s.sel, 0, 'la selección se recoloca');
  assert.ok(selected(s), 'y sigue apuntando a algo');
});

test('VIEWS: las cuatro vistas del plan, en orden', () => {
  assert.deepEqual(VIEWS, ['queue', 'sessions', 'projects', 'help']);
});

// --- lo desatendido no se puede romper ---------------------------------------
test('sin TTY, "kaip" a secas imprime la ayuda y NO abre la GUI', () => {
  // Esto es el caso del Task Scheduler y de las tuberías: la GUI en raw mode
  // se quedaría colgada para siempre esperando una tecla que nadie va a pulsar.
  const cli = fileURLToPath(new URL('../kaip.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [cli], {
    encoding: 'utf8',
    timeout: 10_000,                            // si abriera la GUI, colgaría aquí
    env: { ...process.env, KAIP_HOME: TMP },
  });

  assert.match(out, /Usage:/, 'debe salir la ayuda');
  assert.match(out, /Subcommands:/);
  assert.doesNotMatch(out, /\x1b\[\?1049h/, 'ni rastro de la pantalla alternativa');
});

// --- reiniciar la interfaz ---------------------------------------------------
// Cualquier cosa que escriba en el terminal por detrás de la GUI (la salida suelta de
// un lanzamiento, un resize que el terminal se comió) deja basura en pantalla, y no
// había forma de recuperar un frame limpio salvo salir.

test('R pide reiniciar la interfaz', () => {
  const { effect } = reduce(refresh(initialState()), 'R');
  assert.deepEqual(effect, { type: 'restart' });
});

test('R dentro del asistente NO reinicia: ahí es una letra que se escribe', () => {
  const st = reduce(refresh(initialState()), 'a').state;      // abre el asistente
  const { state: next, effect } = reduce(st, 'R');
  assert.equal(effect, null, 'no dispara efecto');
  assert.ok(next.wizard.buffer.endsWith('R'), 'se escribe en el prompt');
});

// --- conversaciones sugeridas ------------------------------------------------
// Reutilizar un target retoma una sesión que YA tiene el contexto cargado: es el mayor
// ahorro de tokens de la herramienta. Por eso el asistente las ofrece.

test('el asistente sugiere las conversaciones existentes, y ↑↓ las elige', () => {
  saveQueue([]);
  saveSessions({ fixes: { sessionId: 'sess-abcdef12', adapter: 'claude', updatedAt: Date.now() } });

  // add → prompt → when → llegamos al paso "target"
  let st = refresh(initialState());
  st = reduce(st, 'a').state;
  for (const ch of 'algo') st = reduce(st, ch).state;
  st = reduce(st, 'enter').state;                              // prompt hecho
  st = reduce(st, 'enter').state;                              // when vacío → secuencial

  assert.equal(st.wizard.step, 2, 'estamos en el paso del target');

  const pantalla = render(st).map(strip).join('\n');
  assert.ok(pantalla.includes('fixes'), 'la sesión existente se ofrece en pantalla');

  st = reduce(st, 'down').state;                               // elegirla con la flecha
  assert.equal(st.wizard.buffer, 'fixes');
  assert.equal(st.wizard.pick, 0);
});

test('escribir por encima de una sugerencia la descarta (es tu valor, no el suyo)', () => {
  saveQueue([]);
  saveSessions({ fixes: { sessionId: 's1', adapter: 'claude', updatedAt: 1 } });

  let st = refresh(initialState());
  st = reduce(st, 'a').state;
  for (const ch of 'algo') st = reduce(st, ch).state;
  st = reduce(st, 'enter').state;
  st = reduce(st, 'enter').state;
  st = reduce(st, 'down').state;                               // coge "fixes"
  assert.equal(st.wizard.pick, 0);

  st = reduce(st, 'X').state;                                  // y escribe encima
  assert.equal(st.wizard.pick, null, 'ya no está eligiendo de la lista');
  assert.equal(st.wizard.buffer, 'fixesX');
});

test('sin sesiones guardadas, las flechas no rompen el asistente', () => {
  saveQueue([]); saveSessions({});
  let st = refresh(initialState());
  st = reduce(st, 'a').state;
  for (const ch of 'algo') st = reduce(st, ch).state;
  st = reduce(st, 'enter').state;
  st = reduce(st, 'enter').state;
  const { state: next } = reduce(st, 'down');
  assert.ok(next.wizard, 'el asistente sigue en pie');
});

// --- borrar los jobs ya terminados ------------------------------------------
test('"x" pide confirmacion antes de borrar los terminados (no borra a la primera)', () => {
  saveQueue([]);
  const a = addJob({ prompt: 'pendiente', adapter: 'mock' });
  const b = addJob({ prompt: 'terminado', adapter: 'mock' });
  saveQueue(loadQueue().map((j) => (j.id === b.id ? { ...j, status: 'done' } : j)));

  const st = refresh(initialState());
  const { state: next, effect } = reduce(st, 'x');

  assert.equal(effect, null, 'todavia no borra nada');
  assert.ok(next.confirm, 'pregunta primero');
  assert.match(next.confirm.text, /1 finished/);
  assert.equal(loadQueue().length, 2, 'la cola sigue intacta');

  // Y al decir que si, se van los terminados y se quedan los pendientes.
  const { effect: go } = reduce(next, 'y');
  assert.deepEqual(go, { type: 'clear' });
  applyEffect(go);

  const ids = loadQueue().map((j) => j.id);
  assert.deepEqual(ids, [a.id], 'solo queda el pendiente');
});

test('"x" con nada terminado no pregunta, solo lo dice', () => {
  saveQueue([]);
  addJob({ prompt: 'pendiente', adapter: 'mock' });
  const { state: next, effect } = reduce(refresh(initialState()), 'x');
  assert.equal(effect, null);
  assert.equal(next.confirm, null, 'no monta un dialogo para nada');
  assert.match(strip(next.message), /nothing finished/);
});

test('cancelar la confirmacion con "n" no borra nada', () => {
  saveQueue([]);
  addJob({ prompt: 'terminado', adapter: 'mock' });
  saveQueue(loadQueue().map((j) => ({ ...j, status: 'done' })));

  const st = reduce(refresh(initialState()), 'x').state;
  const { state: next, effect } = reduce(st, 'n');
  assert.equal(effect, null);
  assert.equal(next.confirm, null);
  assert.equal(loadQueue().length, 1, 'sigue ahi');
});

// --- "y": entrar en el chat de Claude Code -----------------------------------
test('"y" sobre un job pide entrar en su conversación', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x', adapter: 'mock' });
  const { effect } = reduce(refresh(initialState()), 'y');
  assert.deepEqual(effect, { type: 'resume', ref: j.id });
});

test('"y" en la vista de Chats entra por el target', () => {
  saveQueue([]);
  saveSessions({ fixes: { sessionId: 's1', adapter: 'claude', updatedAt: 1 } });
  let st = refresh(initialState());
  st = reduce(st, '2').state;                       // vista Chats
  const { effect } = reduce(st, 'y');
  assert.deepEqual(effect, { type: 'resume', ref: 'fixes' });
});

test('"y" dentro de una confirmación sigue siendo "sí" (no entra en ningún chat)', () => {
  // La confirmación se resuelve ANTES que las teclas normales, así que no chocan.
  saveQueue([]);
  addJob({ prompt: 'x', adapter: 'mock' });
  const st = reduce(refresh(initialState()), 'd').state;   // pide confirmar el borrado
  assert.ok(st.confirm);
  const { effect } = reduce(st, 'y');
  assert.equal(effect.type, 'delete', 'aquí "y" confirma, no abre un chat');
});

test('"y" sin nada seleccionado no hace nada', () => {
  saveQueue([]);
  const { effect } = reduce(refresh(initialState()), 'y');
  assert.equal(effect, null);
});
