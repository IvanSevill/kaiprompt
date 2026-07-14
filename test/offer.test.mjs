import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-offer-'));
process.env.KAIP_HOME = TMP;
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.KAIP_NO_DAEMON = '1';          // a test leaves no background processes alive

const { loadQueue, saveQueue } = await import('../lib/store.mjs');
const { strip } = await import('../lib/ui.mjs');
const { dismissed } = await import('../lib/cutshort.mjs');
const { applyEffect, initialState, reduce, refresh, render } = await import('../lib/tui.mjs');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIMS = { cols: 100, rows: 30 };
const view = (s) => strip(render(s, DIMS).join('\n'));

const DIR = path.join(TMP, 'myapp');
fs.mkdirSync(DIR, { recursive: true });

const hit = (over = {}) => ({
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  file: path.join(TMP, 'x.jsonl'),
  dir: DIR,
  at: Date.now() - 12 * 60_000,
  ask: 'still need to wire up the network config',
  resetsAt: null,
  ...over,
});

const withOffer = (hits) => refresh(initialState({ offer: { hits, sel: 0 } }));

// --- the offer ---------------------------------------------------------------
test('the offer comes up at the top, with project, when, and what was asked for', () => {
  const out = view(withOffer([hit()]));
  assert.match(out, /A conversation looks like it was cut off/);
  assert.match(out, /myapp/);
  assert.match(out, /12 min ago/);
  assert.match(out, /still need to wire up the network config/);
  assert.match(out, /Finish it as soon as the quota is back\?/);
  assert.match(out, /\[enter\] yes/);
  assert.match(out, /\[esc\] no/);
});

test('with no cut-short sessions, the offer does NOT exist', () => {
  const out = view(refresh(initialState()));
  assert.doesNotMatch(out, /cut off/);
  assert.doesNotMatch(out, /\[enter\] yes/);
});

test('it is an OFFER: showing it queues nothing', () => {
  saveQueue([]);
  render(withOffer([hit()]), DIMS);
  assert.equal(loadQueue().length, 0, 'nothing is queued without saying yes');
});

// --- answering ---------------------------------------------------------------
test('enter = yes → queues a priority continuation, and the offer goes away', () => {
  saveQueue([]);
  const h = hit();
  const { state, effect } = reduce(withOffer([h]), 'enter');

  assert.equal(effect.type, 'resume-cut');
  assert.equal(effect.hit.sessionId, h.sessionId);
  assert.equal(state.offer, null, 'answered: the offer disappears');

  applyEffect(effect);
  const [job] = loadQueue();
  assert.equal(job.sessionId, h.sessionId);
  assert.equal(job.continuation, true);
  assert.equal(job.priority, true);
  assert.equal(job.when, null);
});

test('esc = no → silences it, and queues nothing', () => {
  saveQueue([]);
  const h = hit({ sessionId: 'bbbbbbbb-1111-2222-3333-444444444444' });
  const { state, effect } = reduce(withOffer([h]), 'esc');

  assert.equal(effect.type, 'dismiss-cut');
  assert.equal(state.offer, null);

  applyEffect(effect);
  assert.equal(loadQueue().length, 0, 'saying no queues nothing');
  assert.equal(dismissed().has(h.sessionId), true, 'and it is never asked about again');
});

test('with several, ↑↓ chooses and enter only answers the selected one', () => {
  saveQueue([]);
  const a = hit({ sessionId: 'aaaa1111-0000-0000-0000-000000000000', ask: 'the first one' });
  const b = hit({ sessionId: 'bbbb2222-0000-0000-0000-000000000000', ask: 'the second one' });

  let s = withOffer([a, b]);
  assert.match(view(s), /Finish the selected one/);

  s = reduce(s, 'down').state;
  assert.equal(s.offer.sel, 1);

  const { state, effect } = reduce(s, 'enter');
  assert.equal(effect.hit.sessionId, b.sessionId, 'the selected one, not the first');

  // The other is still on offer: answering one does not answer for the rest.
  assert.equal(state.offer.hits.length, 1);
  assert.equal(state.offer.hits[0].sessionId, a.sessionId);
});

test('the offer owns the keyboard: neither "d" nor "x" nor "a" do anything', () => {
  const s = withOffer([hit()]);
  for (const key of ['d', 'x', 'a', 'e', 'r', 'D']) {
    const { state, effect } = reduce(s, key);
    assert.equal(effect, null, `"${key}" should do nothing while the offer is up`);
    assert.equal(state.offer, s.offer);
  }
});

test('…but q and ctrl-c still quit: a question you cannot walk away from is a trap', () => {
  const s = withOffer([hit()]);
  assert.equal(reduce(s, 'q').effect.type, 'quit');
  assert.equal(reduce(s, 'ctrl-c').effect.type, 'quit');
});

test('a refresh does not resurrect an offer that was already answered', () => {
  const { state } = reduce(withOffer([hit()]), 'esc');
  assert.equal(refresh(state).offer, null, 'it is worked out when the GUI opens, not on every repaint');
});

// --- and NONE of this comes out on the CLI ------------------------------------
test('with no GUI, kaip behaves exactly as it did before', () => {
  // `list` is the view a careless eye would expect to "warn" as well. It does not: with no
  // TTY there is nobody to ask, and asking anyway is noise in a log.
  const out = execFileSync(process.execPath, [path.join(ROOT, 'kaip.mjs'), 'list'], {
    env: { ...process.env, KAIP_HOME: TMP, CLAUDE_CONFIG_DIR: path.join(TMP, 'claude') },
    encoding: 'utf8',
  });
  assert.doesNotMatch(out, /cut off/);
  assert.doesNotMatch(out, /quota is back/);
});
