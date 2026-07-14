import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  altEnter, altExit, bar, bigText, bigWidth, box, c, centerBlock, centerLine, clear, fit, paint,
  restoreTitle, setTitle, strip, titleText, toolLines, toolSummary,
  trunc, width, wrap, writeLines,
} from '../lib/ui.mjs';

/** Pretend stdout is a terminal and capture what gets written to it. */
function asTTY(fn) {
  const { isTTY, write } = process.stdout;
  const out = [];
  process.stdout.isTTY = true;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { fn(); } finally {
    process.stdout.write = write;
    process.stdout.isTTY = isTTY;
  }
  return out.join('');
}

// With no TTY (the tests run with output redirected) the colour helpers paint nothing:
// that is exactly what guarantees the unattended mode comes out as plain text.

test('with no TTY no colour codes are emitted', () => {
  assert.equal(c.accent('hello'), 'hello');
  assert.equal(c.bold('hello'), 'hello');
});

test('strip/width ignore the ANSI codes', () => {
  const s = '\x1b[38;2;1;2;3mhello\x1b[39m';
  assert.equal(strip(s), 'hello');
  assert.equal(width(s), 5);
});

test('trunc: cuts and adds an ellipsis, collapses spaces', () => {
  assert.equal(trunc('hello   world', 20), 'hello world');
  assert.equal(trunc('x'.repeat(30), 10).length, 10);
  assert.ok(trunc('x'.repeat(30), 10).endsWith('…'));
  assert.equal(trunc(undefined, 5), '');
});

test('centerLine centres by visible width', () => {
  assert.equal(centerLine('ab', 10), ' '.repeat(4) + 'ab');
  assert.equal(width(centerLine('ab', 10)), 6);
});

// --- centerBlock -------------------------------------------------------------
// Visual regression: centring EACH line on its own throws the whole thing out of square —
// a short bar drifted off to one side while the wide box sat in the middle. A block is
// centred as a block: every line starts in the same column.

test('centerBlock: every line starts in the SAME column', () => {
  const lines = centerBlock(['a very wide box from here to there', 'short', 'x'], 60);
  const indents = lines.map((l) => l.length - l.trimStart().length);
  assert.equal(new Set(indents).size, 1, 'one single indent for all of them');
});

test('centerBlock: the block is centred by its widest line', () => {
  const wide = 'x'.repeat(20);
  const [first] = centerBlock([wide, 'y'], 40);
  assert.equal(first.length - first.trimStart().length, 10, '(40 - 20) / 2');
});

test('centerBlock: measures by visible width, colours do not shift it', () => {
  const lines = centerBlock([c.accent('hello'), 'hello'], 20);
  const indents = lines.map((l) => strip(l).length - strip(l).trimStart().length);
  assert.equal(new Set(indents).size, 1, 'colour must not push the line along');
});

test('centerBlock: nothing overflows the terminal', () => {
  const lines = centerBlock(['x'.repeat(200)], 40);
  assert.ok(lines.every((l) => width(l) <= 40));
});

// --- fit (no line may overflow the terminal) --------------------------------
test('fit: lets through what fits, cuts what does not', () => {
  assert.equal(fit('hello', 10), 'hello');
  assert.equal(width(fit('x'.repeat(30), 10)), 10);
});

test('fit: measures by visible width, not bytes (ANSI takes no room)', () => {
  const coloured = '\x1b[38;2;1;2;3mhello\x1b[39m';
  assert.equal(fit(coloured, 10), coloured, 'it fits: the colour is kept');
  assert.ok(width(fit(coloured, 2)) <= 2, 'it does not fit: cut to the visible width');
});

// --- wrap (the chat viewer's paragraphs) ------------------------------------
test('wrap: breaks on words without going over the width', () => {
  const lines = wrap('one two three four five six', 10);
  assert.ok(lines.every((l) => l.length <= 10));
  assert.equal(lines.join(' '), 'one two three four five six', 'not a single word lost');
});

test('wrap: keeps the line breaks that were already there', () => {
  assert.deepEqual(wrap('one\ntwo', 20), ['one', 'two']);
});

test('wrap: a word longer than the width is split (otherwise the box breaks)', () => {
  const lines = wrap('x'.repeat(25), 10);
  assert.ok(lines.every((l) => l.length <= 10));
  assert.equal(lines.join(''), 'x'.repeat(25));
});

test('wrap: empty or null does not break it', () => {
  assert.deepEqual(wrap('', 10), ['']);
  assert.deepEqual(wrap(undefined, 10), ['']);
});

// --- toolSummary (one tool call on one line) --------------------------------
test('toolSummary: picks the argument that matters for each tool', () => {
  assert.deepEqual(toolSummary('Read', { file_path: 'app/main.py' }), { name: 'Read', arg: 'app/main.py' });
  assert.deepEqual(toolSummary('Bash', { command: 'npm test' }), { name: 'Bash', arg: 'npm test' });
  assert.deepEqual(toolSummary('Grep', { pattern: 'TODO' }), { name: 'Grep', arg: 'TODO' });
});

test('toolSummary: with no argument it recognises, just the name', () => {
  assert.deepEqual(toolSummary('TodoWrite', { todos: [] }), { name: 'TodoWrite', arg: '' });
  assert.deepEqual(toolSummary('X', undefined), { name: 'X', arg: '' });
});

test('toolSummary: a long argument is cut to the width available', () => {
  const { arg } = toolSummary('Bash', { command: 'x'.repeat(200) }, 40);
  assert.ok(arg.length <= 40);
  assert.ok(arg.endsWith('…'));
});

// --- giant digits (the clock) -----------------------------------------------
test('bigText: always 5 rows', () => {
  assert.equal(bigText('00:00:00').length, 5);
  assert.equal(bigText('12:34:56').length, 5);
});

test('bigText: every row is the same width, and bigWidth predicts it', () => {
  const txt = '02:34:11';
  const rows = bigText(txt);
  const widths = rows.map(width);
  assert.equal(new Set(widths).size, 1, 'uneven rows would break the centring');
  assert.equal(widths[0], bigWidth(txt), 'bigWidth must match the real width');
});

test('bigText: draws all 10 digits and the colon', () => {
  for (const ch of '0123456789') {
    const rows = bigText(ch);
    assert.ok(rows.some((r) => r.includes('█')), `digit ${ch} must paint something`);
  }
  assert.ok(bigText(':').some((r) => r.includes('█')));
});

test('bigText: ignores unsupported characters without breaking', () => {
  assert.equal(bigText('ab').length, 5);
  assert.equal(bigWidth('ab'), 0);
});

test('bigText: the scale changes the width, not the height', () => {
  assert.equal(bigText('12', { scale: 1 }).length, 5);
  assert.ok(bigWidth('12', { scale: 2 }) > bigWidth('12', { scale: 1 }));
});

// --- the window title --------------------------------------------------------
// The terminal is called "node" and it should be called after whatever it is doing: with the
// window minimised, the taskbar is all you can see. But an unattended run has no taskbar at
// all, so nothing is written there.

test('with no TTY no title is written (the unattended path is left alone)', () => {
  const out = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { setTitle('⏳ 04:12:33 → voice invoice'); restoreTitle(); }
  finally { process.stdout.write = write; }

  assert.equal(out.join(''), '', 'not one byte: plain output stays plain');
});

test('with a TTY the title is the clock, and the old name comes back on exit', () => {
  const out = asTTY(() => { setTitle('⏳ 04:12:33 → voice invoice'); restoreTitle(); });

  assert.ok(out.includes('\x1b]0;⏳ 04:12:33 → voice invoice\x07'), 'OSC 0 with the text');
  assert.ok(out.includes('\x1b[22;0t'), 'first, save the name it had');
  assert.ok(out.includes('\x1b[23;0t'), 'and give it back on the way out');
  assert.ok(out.indexOf('\x1b]0;\x07') < out.indexOf('\x1b[23;0t'),
    'with an empty title first, in case the terminal knows nothing about stacks');
});

test('the title may not carry colours, nor close the sequence early', () => {
  assert.equal(titleText('\x1b[38;2;217;119;87mkaip\x1b[39m'), 'kaip');
  assert.equal(titleText('bad\x07title\x1b'), 'bad title');
  assert.equal(titleText('  several   spaces  '), 'several spaces');
});

// --- toolLines (what you see while the launch is running) -------------------
// A bare "Edit(file)" does not say WHAT changed, and a bare "TodoWrite" says nothing at all.

test('toolLines: TodoWrite shows the tasks, not an empty call', () => {
  const lines = toolLines('TodoWrite', {
    todos: [
      { content: 'read the code', status: 'completed' },
      { content: 'fix the bug', status: 'in_progress' },
      { content: 'run the tests', status: 'pending' },
    ],
  }, 60).map(strip);

  assert.ok(lines[0].includes('TodoWrite'));
  assert.ok(lines.some((l) => l.includes('✓') && l.includes('read the code')));
  assert.ok(lines.some((l) => l.includes('▶') && l.includes('fix the bug')));
  assert.ok(lines.some((l) => l.includes('·') && l.includes('run the tests')));
});

test('toolLines: TodoWrite with no tasks does not blow up', () => {
  assert.equal(toolLines('TodoWrite', {}, 60).length, 1);
  assert.equal(toolLines('TodoWrite', undefined, 60).length, 1);
});

test('toolLines: Edit shows the change, what goes out and what comes in', () => {
  const lines = toolLines('Edit', {
    file_path: 'lib/ui.mjs', old_string: 'join("\\n")', new_string: 'join("\\r\\n")',
  }, 60).map(strip);

  assert.ok(lines[0].includes('Edit') && lines[0].includes('lib/ui.mjs'));
  assert.ok(lines.some((l) => l.trim().startsWith('-') && l.includes('join')));
  assert.ok(lines.some((l) => l.trim().startsWith('+') && l.includes('join')));
});

test('toolLines: a huge Edit gets cut back (otherwise it swallows the screen)', () => {
  const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const lines = toolLines('Edit', { file_path: 'x', old_string: big, new_string: big }, 60).map(strip);
  assert.ok(lines.length < 12, `too many lines: ${lines.length}`);
  assert.ok(lines.some((l) => l.includes('…')), 'it must say what it is hiding');
});

test('toolLines: MultiEdit shows every change', () => {
  const lines = toolLines('MultiEdit', {
    file_path: 'a.mjs',
    edits: [
      { old_string: 'one', new_string: 'ONE' },
      { old_string: 'two', new_string: 'TWO' },
    ],
  }, 60).map(strip).join('\n');
  for (const s of ['one', 'ONE', 'two', 'TWO']) assert.ok(lines.includes(s), s);
});

test('toolLines: Write says how many lines it writes', () => {
  const lines = toolLines('Write', { file_path: 'x.mjs', content: 'a\nb\nc' }, 60).map(strip);
  assert.ok(lines.some((l) => l.includes('3 lines')));
});

test('toolLines: any other tool is still one single line', () => {
  const lines = toolLines('Bash', { command: 'npm test' }, 60);
  assert.equal(lines.length, 1);
  assert.ok(strip(lines[0]).includes('Bash') && strip(lines[0]).includes('npm test'));
});

// --- raw painting ------------------------------------------------------------
// Regression: the GUI came out in a staircase. Raw mode (needed to read single keys) also
// turns off the LF→CRLF translation on OUTPUT, so a bare "\n" drops one row but does NOT
// return to column 0. With CRLF it works in both modes.

test('paint: separates the lines with CRLF, never with a bare LF', () => {
  const out = asTTY(() => paint(['one', 'two', 'three']));
  assert.ok(out.includes('one\r\ntwo\r\nthree'), 'the rows must go out with CRLF');
  assert.ok(!/[^\r]\n/.test(out), 'not one LF without its CR in front');
});

test('paint: clears the screen before painting (otherwise the last frame shows through)', () => {
  const out = asTTY(() => paint(['x']));
  assert.ok(out.includes('\x1b[2J'), 'it must erase');
  assert.ok(out.includes('\x1b[H'), 'and go back to the origin');
});

test('clear: erases the scrollback TOO', () => {
  // Regression: on leaving the alternate screen the terminal restores whatever was there
  // before, and "2J" only erases what is visible. Without "3J" there was debris underneath
  // and the farewell landed on top of it.
  const out = asTTY(() => clear());
  assert.ok(out.includes('\x1b[3J'), 'without this, the scrollback survives');
  assert.ok(out.includes('\x1b[2J'));
  assert.ok(out.includes('\x1b[H'));
});

test('paint: with no TTY it comes out as plain text, no ANSI codes (the unattended mode)', () => {
  const logged = [];
  const log = console.log;
  console.log = (s) => logged.push(s);
  try { paint([c.accent('hello'), 'bye']); } finally { console.log = log; }
  assert.equal(logged.join(''), 'hello\nbye');
});

test('writeLines: turns the text breaks into CRLF (the chat viewer in the GUI)', () => {
  const out = asTTY(() => writeLines('line1\nline2'));
  assert.ok(out.startsWith('line1\r\nline2'));
  assert.ok(!/[^\r]\n/.test(out));
});

// --- bar and box -------------------------------------------------------------
test('bar: clamps between 0 and 100', () => {
  assert.ok(strip(bar(0, 10)).startsWith('░'));
  assert.ok(strip(bar(100, 10)).startsWith('█'.repeat(10)));
  assert.ok(strip(bar(-50, 10)).includes('0%'));
  assert.ok(strip(bar(500, 10)).includes('100%'));
});

test('box: rounded borders and the content inside', () => {
  const b = box(['hello'], { title: 'test' });
  assert.ok(strip(b[0]).startsWith('╭'));
  assert.ok(strip(b.at(-1)).startsWith('╰'));
  assert.ok(b.some((l) => l.includes('hello')));
});

test('box: every line the same width (otherwise the frame goes crooked)', () => {
  const b = box(['short', 'a considerably longer line'], { title: 'x' });
  const widths = b.map(width);
  assert.equal(new Set(widths).size, 1);
});

test('box: a line WIDER than the box is cut, it does not push the border out', () => {
  // Regression: the right-hand border zigzagged its way down the screen, a different
  // distance on every long line. You could see it in the detail view with long prompts.
  const b = box(['x'.repeat(200), 'short'], { title: 'job', cols: 40 });
  const widths = b.map(width);
  assert.equal(new Set(widths).size, 1, 'every row at the same width');
  assert.equal(widths[0], 42, 'the width asked for, plus the two borders');
  for (const l of b.slice(1, -1)) {
    assert.ok(strip(l).startsWith('│') && strip(l).endsWith('│'), 'borders where they belong');
  }
});

// --- leaving the alternate screen ONCE and once only -------------------------
test('altExit twice does NOT restore the old screen (that was the flash on the way out)', () => {
  // "?1049l" does not mean "erase": it means "restore the screen you saved". Calling it a
  // second time, AFTER having left and printed the farewell, made the terminal dutifully
  // hand back the old buffer: the screen cleared itself and immediately got dirty again.
  const out = asTTY(() => { altEnter(); altExit(); altExit(); altExit(); });
  const exits = out.split('\x1b[?1049l').length - 1;
  assert.equal(exits, 1, 'it may only be left once');
});

test('altEnter twice does not enter twice either', () => {
  const out = asTTY(() => { altEnter(); altEnter(); altExit(); });
  assert.equal(out.split('\x1b[?1049h').length - 1, 1);
});
