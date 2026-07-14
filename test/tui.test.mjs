import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tui-'));
process.env.KAIP_HOME = TMP;
// Adding a job with a time arms the daemon (that is the whole point). Not here: a test
// cannot leave background processes alive. That it really does arm it is proved in
// daemon.test.mjs.
process.env.KAIP_NO_DAEMON = '1';
const { loadQueue, saveQueue, saveProjects, saveSessions } = await import('../lib/store.mjs');
const { addJob } = await import('../lib/queue.mjs');
const { strip } = await import('../lib/ui.mjs');
const {
  applyEffect, asPaste, decodeKey, initialState, keyReader, pasteText,
  reduce, refresh, render, rows, selected, VIEWS,
} = await import('../lib/tui.mjs');

const DIMS = { cols: 100, rows: 30 };
const view = (state) => strip(render(state, DIMS).join('\n'));

/** Type a whole sequence, as the user would. Returns the state and the last effect. */
function press(state, keys) {
  let effect = null;
  for (const k of keys) ({ state, effect } = reduce(state, k));
  return { state, effect };
}

const fresh = () => refresh(initialState());

test('refresh: picks up jobs added by another Kaiprompt process without losing wizard input', () => {
  saveQueue([]);
  let state = fresh();
  state = reduce(state, 'a').state;
  state = reduce(state, asPaste('draft prompt')).state;

  addJob({ prompt: 'arrived elsewhere', adapter: 'mock' });
  state = refresh(state);

  assert.equal(state.data.queue.length, 1);
  assert.equal(state.wizard.buffer, 'draft prompt');
});

// --- keys --------------------------------------------------------------------
test('decodeKey: arrows, enter, esc, backspace and Ctrl+C', () => {
  assert.equal(decodeKey('\x1b[A'), 'up');
  assert.equal(decodeKey('\x1b[B'), 'down');
  assert.equal(decodeKey('\x1b[C'), 'right');
  assert.equal(decodeKey('\x1b[D'), 'left');
  assert.equal(decodeKey('\r'), 'enter');
  assert.equal(decodeKey('\x1b'), 'esc');
  assert.equal(decodeKey('\x7f'), 'backspace');
  assert.equal(decodeKey('\x03'), 'ctrl-c');
  assert.equal(decodeKey(Buffer.from('a')), 'a', 'an ordinary character comes back as it is');
});

// --- pasting -----------------------------------------------------------------
// In raw mode a paste is NOT an event: it is a burst of characters in a single `data`. The
// reader treated each burst as ONE keypress and threw the rest away — which is why Ctrl+V did
// nothing, and typing a long prompt by hand was the only option.
test('keyReader: a burst of characters is a paste, not a key', () => {
  const read = keyReader();
  const keys = read('x'.repeat(200));

  assert.equal(keys.length, 1, 'a paste is ONE thing, not 200 separate keypresses');
  assert.equal(pasteText(keys[0]), 'x'.repeat(200), 'and it carries the whole text');
});

test('keyReader: real keys are still keys (not everything is a paste)', () => {
  const read = keyReader();
  assert.deepEqual(read('\x1b[A'), ['up']);
  assert.deepEqual(read('\r'), ['enter'], 'Windows Terminal sends \\r, not \\n');
  assert.deepEqual(read('a'), ['a']);
  assert.equal(pasteText('tab'), null, 'a key name has several letters too');
});

test('keyReader: a paste split across two chunks is stitched back before delivery', () => {
  const read = keyReader();

  assert.deepEqual(read('\x1b[200~hello '), [], 'without the end marker there is no key yet');
  const keys = read('world\x1b[201~');

  assert.equal(pasteText(keys[0]), 'hello world');
});

test('pasting 200 characters into the wizard puts all 200 in', () => {
  saveQueue([]);
  const text = 'x'.repeat(200);

  let { state } = press(fresh(), ['a']);
  ({ state } = reduce(state, asPaste(text)));

  assert.equal(state.wizard.buffer.length, 200, 'it does not keep only the first character');
  assert.equal(state.wizard.buffer, text);
});

test('a paste with line breaks does NOT confirm the form', () => {
  // The bug that turns one Ctrl+V into "I have confirmed the form three times": every \n in
  // the pasted text was read as an enter. Line breaks are text, not keypresses.
  saveQueue([]);
  const text = 'fix the bug\n\n- this first\n- then the other thing';

  let { state } = press(fresh(), ['a']);
  let effect;
  ({ state, effect } = reduce(state, asPaste(text)));

  assert.equal(effect, null, 'nothing gets queued');
  assert.equal(state.wizard.step, 0, 'and we are still on the first step of the wizard');
  assert.equal(state.wizard.buffer, text, 'with the line breaks inside the prompt');
});

test('outside the wizard a paste presses no keys (it could carry a "d" inside)', () => {
  saveQueue([]);
  addJob({ prompt: 'do not delete me' });

  const { state, effect } = reduce(fresh(), asPaste('dxq'));

  assert.equal(effect, null, 'no deleting, no quitting: it is text');
  assert.equal(state.confirm, null);
});

// --- navigation --------------------------------------------------------------
test('views: tab and 1-4 switch view, and wrap around', () => {
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
  assert.equal(s.view, 'queue', 'the last one goes back to the first');
  s = press(s, ['left']).state;
  assert.equal(s.view, 'help', 'and backwards the same');
});

test('↑↓ move the selection without falling off the list', () => {
  saveQueue([]);
  addJob({ prompt: 'one' }); addJob({ prompt: 'two' });
  let s = fresh();

  assert.equal(s.sel, 0);
  s = press(s, ['up']).state;
  assert.equal(s.sel, 0, 'it does not go past the top');

  s = press(s, ['down', 'down', 'down']).state;
  assert.equal(s.sel, 1, 'nor past the bottom');
  assert.equal(selected(s).prompt, 'two');
});

test('q and Ctrl+C ask to quit', () => {
  assert.deepEqual(reduce(fresh(), 'q').effect, { type: 'quit' });
  assert.deepEqual(reduce(fresh(), 'ctrl-c').effect, { type: 'quit' });
});

test('r runs the queue (the runner clock)', () => {
  assert.deepEqual(reduce(fresh(), 'r').effect, { type: 'run' });
});

test('enter opens the detail of the selected job, and esc closes it', () => {
  saveQueue([]); addJob({ prompt: 'review the PR' });
  let s = fresh();

  s = press(s, ['enter']).state;
  assert.ok(s.detail, 'there is a detail overlay');
  assert.match(view(s), /review the PR/);

  s = press(s, ['esc']).state;
  assert.equal(s.detail, null);
});

test('o and c ask for the output and the chat of the selected job', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x' });
  const s = fresh();

  assert.deepEqual(reduce(s, 'o').effect, { type: 'out', id: j.id });
  assert.deepEqual(reduce(s, 'c').effect, { type: 'chat', ref: j.id });
});

test('with an empty queue, the job keys do not blow up', () => {
  saveQueue([]);
  const s = fresh();
  for (const k of ['enter', 'e', 'd', 'o', 'c']) {
    const { state, effect } = reduce(s, k);
    assert.equal(effect, null, `"${k}" must do nothing with no selection`);
    assert.match(strip(state.message || ''), /nothing selected/);
  }
});

test('in the chats view, enter opens that target conversation', () => {
  saveSessions({ fixes: { sessionId: 'sid-1', adapter: 'claude', updatedAt: 1 } });
  const s = press(fresh(), ['2']).state;
  assert.equal(rows(s).length, 1);
  assert.deepEqual(reduce(s, 'enter').effect, { type: 'chat', ref: 'fixes' });
});

// --- the add wizard -----------------------------------------------------------
test('a: the wizard walks prompt → prompt file → when → target → folder → engine → provider → model → permissions', () => {
  saveQueue([]);
  let s = press(fresh(), ['a']).state;
  assert.ok(s.wizard, 'the wizard opens');
  assert.equal(s.wizard.step, 0);

  // type the prompt letter by letter
  s = press(s, [...'/test']).state;
  assert.equal(s.wizard.buffer, '/test');
  assert.match(view(s), /Prompt/);

  s = press(s, ['enter']).state;
  assert.equal(s.wizard.step, 1, 'moves on to optional prompt file');
  s = press(s, ['enter']).state;
  assert.equal(s.wizard.step, 2, 'moves on to "when"');
  s = press(s, [...'+2h', 'enter']).state;
  assert.equal(s.wizard.step, 3);
  s = press(s, [...'fixes', 'enter']).state;
  assert.equal(s.wizard.step, 4);
  s = press(s, ['enter']).state;                       // empty folder → the current one
  assert.equal(s.wizard.step, 5, 'engine step');
  assert.equal(s.wizard.values.engine, 'claude');
  s = press(s, ['enter']).state;                       // engine
  s = press(s, ['enter']).state;                       // provider is empty for Claude
  s = press(s, ['enter']).state;                       // model is optional for Claude
  assert.equal(s.wizard.step, 8, 'last step: permissions');

  // permissions are chosen with ← →, not typed
  assert.equal(s.wizard.values.perm, 'bypass');
  const withArrows = press(s, ['right']).state;
  assert.equal(withArrows.wizard.values.perm, 'acceptEdits');

  const { effect } = press(withArrows, ['enter']);
  assert.equal(effect.type, 'add');
  assert.equal(effect.values.prompt, '/test');
  assert.equal(effect.values.when, '+2h');
  assert.equal(effect.values.target, 'fixes');
  assert.equal(effect.values.perm, 'acceptEdits');
});

test('wizard: backspace deletes and esc cancels without touching the queue', () => {
  saveQueue([]);
  let s = press(fresh(), ['a', ...'hel', 'backspace']).state;
  assert.equal(s.wizard.buffer, 'he');

  s = press(s, ['esc']).state;
  assert.equal(s.wizard, null);
  assert.equal(loadQueue().length, 0, 'cancelling creates nothing');
});

test('wizard: an empty prompt does not move on', () => {
  const { state, effect } = press(fresh(), ['a', 'enter']);
  assert.equal(effect, null);
  assert.equal(state.wizard.step, 0, 'still on the prompt');
  assert.match(strip(state.message), /cannot be empty/);
});

test('wizard: an impossible time is caught here, not at 3am on launch', () => {
  const { state } = press(fresh(), ['a', ...'x', 'enter', 'enter', ...'whenever', 'enter']);
  assert.equal(state.wizard.step, 2, 'it stays on "when" so you can retype it');
  assert.match(strip(state.message), /can't parse time/);
});

// --- editing and deleting ------------------------------------------------------
test('e: the wizard starts with the job values', () => {
  saveQueue([]);
  addJob({ prompt: 'original', target: 'fixes', perm: 'acceptEdits' });
  const s = press(fresh(), ['e']).state;

  assert.equal(s.wizard.mode, 'edit');
  assert.equal(s.wizard.buffer, 'original', 'the prompt comes preloaded');
  assert.equal(s.wizard.values.target, 'fixes');
  assert.equal(s.wizard.values.perm, 'acceptEdits');
});

test('e: a done job is NOT editable (it says so, and does not open the wizard)', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x' });
  saveQueue(loadQueue().map((x) => ({ ...x, status: 'done' })));
  const { state, effect } = press(fresh(), ['e']);

  assert.equal(state.wizard, null);
  assert.equal(effect, null);
  assert.match(strip(state.message), /only pending \(or missed\) jobs can be edited/);
  assert.equal(loadQueue()[0].id, j.id);
});

test('d: asks before deleting; "n" does not delete, "y" does', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'to be deleted' });

  let s = press(fresh(), ['d']).state;
  assert.ok(s.confirm, 'it asks for confirmation');
  // "ONLY this one", spelled out: the other delete key is right next door and takes half
  // the queue with it.
  assert.match(strip(view(s)), /delete ONLY this job.*\[y\/n\]/s);

  const no = press(s, ['n']);
  assert.equal(no.effect, null);
  assert.equal(no.state.confirm, null);

  const yes = press(s, ['y']);
  assert.deepEqual(yes.effect, { type: 'delete', id: j.id });
});

// --- effects that touch the store ---------------------------------------------
test('applyEffect add: really creates the job (the same path as the CLI)', () => {
  saveQueue([]);
  saveProjects({ myalias: 'C:/some/where/MyApp' });
  const line = applyEffect({
    type: 'add',
    values: { prompt: '/test', when: '+2h', target: 'fixes', dir: 'myalias', perm: 'acceptEdits' },
  });

  const [j] = loadQueue();
  assert.equal(j.prompt, '/test');
  assert.equal(j.target, 'fixes');
  assert.equal(j.dir, 'C:/some/where/MyApp', 'the folder resolves as it does in add');
  assert.equal(j.permMode, 'acceptEdits');
  assert.ok(j.when > Date.now());
  assert.match(strip(line), new RegExp(`\\+ ${j.id}`));
});

test('applyEffect add: "bypass" is stored as null (the default it always was)', () => {
  saveQueue([]);
  applyEffect({ type: 'add', values: { prompt: 'x', when: '', target: '', dir: '', perm: 'bypass' } });
  assert.equal(loadQueue()[0].permMode, null);
});

test('applyEffect edit: changes the job, and emptying a field clears it', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'old', target: 'fixes', at: '+2h' });
  applyEffect({
    type: 'edit', id: j.id,
    values: { prompt: 'new', when: '', target: '', dir: '', perm: 'bypass' },
  });

  const [n] = loadQueue();
  assert.equal(n.prompt, 'new');
  assert.equal(n.when, null, 'emptying "when" puts it back to sequential');
  assert.equal(n.target, null);
});

test('applyEffect delete: deletes that job', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x' });
  assert.match(strip(applyEffect({ type: 'delete', id: j.id })), /removed/);
  assert.equal(loadQueue().length, 0);
});

test('space selects pending jobs and m applies one engine selection to all of them', () => {
  saveQueue([]);
  const a = addJob({ prompt: 'one' }); const b = addJob({ prompt: 'two' });
  let st = fresh();
  st = reduce(st, 'space').state;
  st = reduce(st, 'down').state;
  st = reduce(st, 'space').state;
  assert.deepEqual(st.selectedIds, [a.id, b.id]);
  st = reduce(st, 'm').state;
  assert.equal(st.wizard.mode, 'bulk-engine');
  const effect = press(st, ['right', 'right', 'enter', ...'google', 'enter', ...'gemini-2.5-flash', 'enter']).effect;
  assert.equal(effect.type, 'bulk-engine');
  applyEffect(effect);
  for (const job of loadQueue()) {
    assert.equal(job.adapter, 'opencode');
    assert.equal(job.provider, 'google');
    assert.equal(job.model, 'gemini-2.5-flash');
  }
});

test('applyEffect: an error shows up in the bar, it does not kill the GUI', () => {
  saveQueue([]);
  const line = applyEffect({ type: 'edit', id: 'does-not-exist', values: { prompt: 'x', perm: 'bypass' } });
  assert.match(strip(line), /no job found/);
});

// --- painting ------------------------------------------------------------------
test('render: tabs, jobs, the shortcut bar and the selection marker', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'review the PR', target: 'review' });
  const out = view(fresh());

  assert.match(out, /kaip/);
  assert.match(out, /Queue \(1\).*Chats.*Projects.*Help/s, 'the four views');
  assert.match(out, new RegExp(j.id));
  assert.match(out, /review the PR/);
  assert.match(out, /▸/, 'the selected row is marked');
  assert.match(out, /a add · e edit/, 'the shortcut bar');
  assert.match(out, /d — delete ONLY this one/);
  // "out" and "chat" said nothing about how they differ. The bar says what you GET.
  assert.match(out, /space select · m change engine/, 'bulk engine selection is discoverable');
});

test('BOTH deletes appear together and spelled out: they are astonishingly easy to confuse', () => {
  // One takes the row under the cursor; the other, the finished half of the queue. They are
  // one key apart.
  saveQueue([]);
  addJob({ prompt: 'pending one' });
  addJob({ prompt: 'finished one' });
  saveQueue(loadQueue().map((j, i) => (i === 1 ? { ...j, status: 'done' } : j)));

  const out = view(fresh());
  assert.match(out, /d — delete ONLY this one/);
  assert.match(out, /x — delete the 1 FINISHED ones/);
});

test('with nothing finished, the bulk delete is NOT offered (there is nothing to sweep)', () => {
  saveQueue([]);
  addJob({ prompt: 'pending only' });

  const out = view(fresh());
  assert.match(out, /d — delete ONLY this one/);
  assert.doesNotMatch(out, /FINISHED/);
});

// --- scheduling is not launching -----------------------------------------------
// The misunderstanding that started all of this: open the GUI and watch the prompt fly off.
// The GUI launches NOTHING by itself; it only writes to the queue. This nails it down.
test('the header says when NOBODY is processing the queue (or scheduled work would not go out)', () => {
  // And that is the question, not "is the daemon on?". A `kaip run` left open processes the
  // queue exactly the same — and the header used to sit there swearing in red that nothing
  // would fire, while it fired. The tool lying about itself.
  saveQueue([]);
  const out = view(fresh());
  assert.match(out, /nothing is processing the queue/i, 'that nobody is processing it has to be said');
  assert.match(out, /will NOT fire/i, 'and the consequence spelled out');
});

test('"D" asks to turn the daemon on/off (and does not run the queue)', () => {
  const { effect } = press(fresh(), ['D']);
  assert.deepEqual(effect, { type: 'daemon' });
});

test('"r" is still the only thing that runs the queue by hand', () => {
  const { effect } = press(fresh(), ['r']);
  assert.deepEqual(effect, { type: 'run' });
});

test('the wizard queues, it does not send: no key in the add flow fires a launch', () => {
  saveQueue([]);
  const keys = [...'a', ...'hello', 'enter', 'enter', ...'+2h', 'enter', 'enter', 'enter', 'enter', 'enter', 'enter', 'enter'];
  let state = fresh(); let effect = null;
  for (const k of keys) {
    ({ state, effect } = reduce(state, k));
    assert.notEqual(effect?.type, 'run', 'at no point is anything launched');
  }
  assert.equal(effect.type, 'add', 'at the end of the wizard there is only an add');

  applyEffect(effect);
  const [job] = loadQueue();
  assert.equal(job.status, 'pending', 'it stays pending: nobody has sent it');
  assert.ok(job.when > Date.now(), 'with its time, so the daemon fires it later');
});

test('an add with NO time warns that it will only go out on a manual run', () => {
  saveQueue([]);
  const line = strip(applyEffect({
    type: 'add',
    values: { prompt: 'no time', when: '', target: '', dir: '', perm: 'bypass' },
  }));
  assert.match(line, /sequential/i);
  assert.match(line, /only runs when you press "r"/i, 'no surprises: it does not fire itself');
  assert.equal(loadQueue()[0].when, null);
});

test('render: the rows stay in columns (the spaces are not eaten)', () => {
  // Regression: cutting with trunc collapsed runs of spaces and threw the whole list out of
  // alignment ("pending seq claude/fixes" instead of columns).
  saveQueue([]);
  addJob({ prompt: 'one' }); addJob({ prompt: 'two' });
  const lines = render(fresh(), DIMS).map(strip).filter((l) => /pending/.test(l));

  assert.equal(lines.length, 2);
  for (const column of ['pending', 'claude']) {
    const [a, b] = lines.map((l) => l.indexOf(column));
    assert.equal(a, b, `column "${column}" must land in the same place on every row`);
  }
  assert.match(lines[0], / {2,}/, 'the padding between columns must survive the cut');
});

test('render: the help lists every key', () => {
  const out = view(press(fresh(), ['?']).state);
  for (const k of ['enter', 'a', 'e', 'd', 'r', 'o', 'c', 'q']) {
    assert.ok(out.includes(k), `key ${k} is missing`);
  }
  // And the two deletes, spelled out: they are the pair that is easiest to confuse.
  assert.match(out, /d\s+ONE/);
  assert.match(out, /x\s+ALL/);
});

test('render: an empty queue invites you to add, it does not look broken', () => {
  saveQueue([]);
  assert.match(view(fresh()), /empty queue/);
});

test('render: the frame does not go past the terminal width', () => {
  saveQueue([]);
  addJob({ prompt: 'x'.repeat(300), target: 'enormous-target-that-does-not-fit' });
  const dims = { cols: 60, rows: 20 };
  for (const line of render(fresh(), dims)) {
    assert.ok(strip(line).length <= 60, `line too wide: ${strip(line).length}`);
  }
});

test('render: with more jobs than rows, the selection stays on screen', () => {
  saveQueue([]);
  for (let i = 0; i < 40; i++) addJob({ prompt: `job ${i}` });
  let s = fresh();
  for (let i = 0; i < 39; i++) s = reduce(s, 'down').state;

  const out = view(s);
  assert.match(out, /job 39/, 'the one selected at the end is visible');
  assert.doesNotMatch(out, /job 0\b/, 'and the ones above have scrolled off');
});

test('render: the wizard is painted with its steps and the help hint', () => {
  const s = press(fresh(), ['a', ...'hello']).state;
  const out = view(s);
  assert.match(out, /new launch · step 1\/9/);
  assert.match(out, /Prompt:/);
  assert.match(out, /hello/);
  assert.match(out, /enter: next · esc: cancel/);
});

test('refresh: if the queue shrinks, the selection is not left dangling', () => {
  saveQueue([]);
  addJob({ prompt: 'a' }); addJob({ prompt: 'b' });
  let s = press(fresh(), ['down']).state;
  assert.equal(s.sel, 1);

  saveQueue([loadQueue()[0]]);                 // somebody deletes a job from the CLI
  s = refresh(s);
  assert.equal(s.sel, 0, 'the selection is put back in range');
  assert.ok(selected(s), 'and it still points at something');
});

test('VIEWS: the four views, in order', () => {
  assert.deepEqual(VIEWS, ['queue', 'sessions', 'projects', 'help']);
});

// --- the unattended path cannot be broken --------------------------------------
test('with no TTY, a bare "kaip" prints the help and does NOT open the GUI', () => {
  // This is the Task Scheduler case, and the pipe case: the GUI in raw mode would hang
  // forever waiting for a key nobody is going to press.
  const cli = fileURLToPath(new URL('../kaip.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [cli], {
    encoding: 'utf8',
    timeout: 10_000,                            // if it opened the GUI, it would hang here
    env: { ...process.env, KAIP_HOME: TMP },
  });

  assert.match(out, /Usage:/, 'the help must come out');
  // The commands, not the section titles: reordering the help cannot break this test, which
  // exists for something else (that the GUI does NOT open and hang the unattended run).
  for (const cmd of [/\badd\b/, /\brun\b/, /\bdaemon\b/, /\bserve\b/]) assert.match(out, cmd);
  assert.doesNotMatch(out, /\x1b\[\?1049h/, 'not a trace of the alternate screen');
});

// --- restarting the interface --------------------------------------------------
// Anything that writes to the terminal behind the GUI's back (a launch's stray output, a
// resize the terminal swallowed) leaves debris on screen, and there was no way to get a
// clean frame back short of quitting.

test('R asks to restart the interface', () => {
  const { effect } = reduce(refresh(initialState()), 'R');
  assert.deepEqual(effect, { type: 'restart' });
});

test('R inside the wizard does NOT restart: there it is a letter you are typing', () => {
  const st = reduce(refresh(initialState()), 'a').state;      // opens the wizard
  const { state: next, effect } = reduce(st, 'R');
  assert.equal(effect, null, 'it fires no effect');
  assert.ok(next.wizard.buffer.endsWith('R'), 'it is typed into the prompt');
});

// --- suggested conversations ---------------------------------------------------
// Reusing a target resumes a session that ALREADY has the context loaded: it is the biggest
// token saving in the tool. Which is why the wizard offers them.

test('the wizard suggests the existing conversations, and ↑↓ picks one', () => {
  saveQueue([]);
  saveSessions({ fixes: { sessionId: 'sess-abcdef12', adapter: 'claude', updatedAt: Date.now() } });

  // add → prompt → optional file → when → we land on the "target" step
  let st = refresh(initialState());
  st = reduce(st, 'a').state;
  for (const ch of 'something') st = reduce(st, ch).state;
  st = reduce(st, 'enter').state;                              // prompt done
  st = reduce(st, 'enter').state;                              // optional file skipped
  st = reduce(st, 'enter').state;                              // empty when → sequential

  assert.equal(st.wizard.step, 3, 'we are on the target step');

  const screen = render(st).map(strip).join('\n');
  assert.ok(screen.includes('fixes'), 'the existing session is offered on screen');

  st = reduce(st, 'down').state;                               // pick it with the arrow
  assert.equal(st.wizard.buffer, 'fixes');
  assert.equal(st.wizard.pick, 0);
});

test('typing over a suggestion drops it (it is your value, not its)', () => {
  saveQueue([]);
  saveSessions({ fixes: { sessionId: 's1', adapter: 'claude', updatedAt: 1 } });

  let st = refresh(initialState());
  st = reduce(st, 'a').state;
  for (const ch of 'something') st = reduce(st, ch).state;
  st = reduce(st, 'enter').state;
  st = reduce(st, 'enter').state;
  st = reduce(st, 'enter').state;
  st = reduce(st, 'down').state;                               // takes "fixes"
  assert.equal(st.wizard.pick, 0);

  st = reduce(st, 'X').state;                                  // and types over it
  assert.equal(st.wizard.pick, null, 'it is no longer picking from the list');
  assert.equal(st.wizard.buffer, 'fixesX');
});

test('with no saved sessions, the arrows do not break the wizard', () => {
  saveQueue([]); saveSessions({});
  let st = refresh(initialState());
  st = reduce(st, 'a').state;
  for (const ch of 'something') st = reduce(st, ch).state;
  st = reduce(st, 'enter').state;
  st = reduce(st, 'enter').state;
  const { state: next } = reduce(st, 'down');
  assert.ok(next.wizard, 'the wizard is still standing');
});

// --- deleting the jobs that already ran ----------------------------------------
test('"x" asks for confirmation before deleting the finished ones (it does not delete straight away)', () => {
  saveQueue([]);
  const a = addJob({ prompt: 'pending one', adapter: 'mock' });
  const b = addJob({ prompt: 'finished one', adapter: 'mock' });
  saveQueue(loadQueue().map((j) => (j.id === b.id ? { ...j, status: 'done' } : j)));

  const st = refresh(initialState());
  const { state: next, effect } = reduce(st, 'x');

  assert.equal(effect, null, 'it deletes nothing yet');
  assert.ok(next.confirm, 'it asks first');
  assert.match(next.confirm.text, /ALL/);
  assert.equal(loadQueue().length, 2, 'the queue is still intact');

  // And on saying yes, the finished ones go and the pending ones stay.
  const { effect: go } = reduce(next, 'y');
  assert.deepEqual(go, { type: 'clear' });
  applyEffect(go);

  const ids = loadQueue().map((j) => j.id);
  assert.deepEqual(ids, [a.id], 'only the pending one is left');
});

test('"x" with nothing finished does not ask, it just says so', () => {
  saveQueue([]);
  addJob({ prompt: 'pending one', adapter: 'mock' });
  const { state: next, effect } = reduce(refresh(initialState()), 'x');
  assert.equal(effect, null);
  assert.equal(next.confirm, null, 'it does not put up a dialogue for nothing');
  assert.match(strip(next.message), /nothing finished/);
});

test('cancelling the confirmation with "n" deletes nothing', () => {
  saveQueue([]);
  addJob({ prompt: 'finished one', adapter: 'mock' });
  saveQueue(loadQueue().map((j) => ({ ...j, status: 'done' })));

  const st = reduce(refresh(initialState()), 'x').state;
  const { state: next, effect } = reduce(st, 'n');
  assert.equal(effect, null);
  assert.equal(next.confirm, null);
  assert.equal(loadQueue().length, 1, 'still there');
});

// --- "y": walking into the Claude Code chat ------------------------------------
test('"y" on a job asks to walk into its conversation', () => {
  saveQueue([]);
  const j = addJob({ prompt: 'x', adapter: 'mock' });
  const { effect } = reduce(refresh(initialState()), 'y');
  assert.deepEqual(effect, { type: 'resume', ref: j.id });
});

test('"y" in the Chats view goes in by target', () => {
  saveQueue([]);
  saveSessions({ fixes: { sessionId: 's1', adapter: 'claude', updatedAt: 1 } });
  let st = refresh(initialState());
  st = reduce(st, '2').state;                       // Chats view
  const { effect } = reduce(st, 'y');
  assert.deepEqual(effect, { type: 'resume', ref: 'fixes' });
});

test('"y" inside a confirmation still means "yes" (it walks into no chat)', () => {
  // The confirmation is resolved BEFORE the ordinary keys, so the two do not collide.
  saveQueue([]);
  addJob({ prompt: 'x', adapter: 'mock' });
  const st = reduce(refresh(initialState()), 'd').state;   // asks to confirm the delete
  assert.ok(st.confirm);
  const { effect } = reduce(st, 'y');
  assert.equal(effect.type, 'delete', 'here "y" confirms, it does not open a chat');
});

test('"y" with nothing selected does nothing', () => {
  saveQueue([]);
  const { effect } = reduce(refresh(initialState()), 'y');
  assert.equal(effect, null);
});
