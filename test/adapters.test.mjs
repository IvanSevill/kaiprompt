import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as claude from '../adapters/claude.mjs';
import * as mock from '../adapters/mock.mjs';
import * as opencode from '../adapters/opencode.mjs';

const dry = (over = {}) => claude.run({ prompt: 'p', dryRun: true, ...over });

test('claude: por defecto BYPASS (autonomía total en lanzamientos desatendidos)', async () => {
  const { output } = await dry();
  assert.match(output, /--dangerously-skip-permissions/);
  assert.doesNotMatch(output, /--permission-mode/);
});

test('claude: --perm acceptEdits baja el modo de permisos', async () => {
  const { output } = await dry({ permMode: 'acceptEdits' });
  assert.match(output, /--permission-mode acceptEdits/);
  assert.doesNotMatch(output, /--dangerously-skip-permissions/);
});

test('claude: con sessionId reanuda la conversación', async () => {
  const { output } = await dry({ sessionId: 'abc-123' });
  assert.match(output, /--resume abc-123/);
  assert.match(output, /resumes abc-123…/);
});

test('claude: sin sessionId abre sesión nueva', async () => {
  const { output } = await dry();
  assert.match(output, /new session/);
  assert.doesNotMatch(output, /--resume/);
});

test('claude: onEvent activa el streaming (para la vista en vivo)', async () => {
  const { output } = await dry({ onEvent: () => {} });
  assert.match(output, /--output-format stream-json/);
  assert.match(output, /--verbose/, 'stream-json exige --verbose');
});

test('claude: sin onEvent usa JSON de una tacada (scripts, dry-run)', async () => {
  const { output } = await dry();
  assert.match(output, /--output-format json/);
  assert.doesNotMatch(output, /stream-json/);
});

test('claude: el dry-run NO ejecuta nada y devuelve ok', async () => {
  const res = await dry();
  assert.equal(res.ok, true);
  assert.match(res.output, /^\[dry-run\]/);
});

test('mock: emite un flujo de eventos realista y termina con result', async () => {
  const tipos = [];
  const res = await mock.run({ prompt: 'x', onEvent: (e) => tipos.push(e.type) });

  assert.equal(res.ok, true);
  assert.equal(tipos.at(0), 'system', 'arranca con el init');
  assert.equal(tipos.at(-1), 'result', 'y cierra con el resultado');
  assert.ok(tipos.filter((t) => t === 'assistant').length >= 3);
  assert.ok(res.sessionId.startsWith('mock-'));
});

test('mock: respeta una sesión ya existente', async () => {
  const res = await mock.run({ prompt: 'x', sessionId: 'previa' });
  assert.equal(res.sessionId, 'previa');
});

test('opencode: aún no implementado, pero falla limpio (no revienta la cola)', async () => {
  const res = await opencode.run({ prompt: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not implemented|no implementado/i);
});
