// ANSI primitives: palette, boxes, centering, big block digits, alt-screen.
// Zero dependencies. Degrades to plain text when stdout is not a TTY.

export const isTTY = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const rgb = (r, g, b) => (s) => (isTTY() ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : String(s));
const sgr = (on, off) => (s) => (isTTY() ? `\x1b[${on}m${s}\x1b[${off}m` : String(s));

// Claude Code-ish palette.
export const c = {
  accent: rgb(217, 119, 87),     // #D97757 coral/orange
  accentDim: rgb(168, 92, 67),
  ok: rgb(76, 195, 138),
  warn: rgb(226, 178, 84),
  err: rgb(229, 83, 75),
  info: rgb(99, 184, 196),
  muted: rgb(124, 138, 154),
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  under: sgr(4, 24),
};

// --- measuring / layout ------------------------------------------------------
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
export const strip = (s) => String(s).replace(ANSI_RE, '');
export const width = (s) => strip(s).length;
export const size = () => ({
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
});

/** Pad a line so its *visible* content sits centered in `cols`. */
export const centerLine = (s, cols) => ' '.repeat(Math.max(0, Math.floor((cols - width(s)) / 2))) + s;

/** Truncate to a visible width, adding an ellipsis. ANSI-unaware: use on plain text. */
export const trunc = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t;
};

/**
 * Clamp an already-coloured line to `n` visible columns. A line wider than the
 * terminal wraps and breaks every frame below it, so cutting matters more than
 * colour: when it has to cut, the ANSI codes go with it.
 */
export const fit = (s, n) => (width(s) <= n ? s : trunc(strip(s), n));

/** Word-wrap plain text to `n` columns, keeping the existing line breaks. */
export function wrap(s, n) {
  const cols = Math.max(1, n);
  const out = [];
  for (const line of String(s ?? '').replace(/\t/g, '  ').split('\n')) {
    let cur = '';
    for (const word of line.split(' ')) {
      if (!cur.length) cur = word;
      else if (cur.length + 1 + word.length <= cols) cur += ' ' + word;
      else { out.push(cur); cur = word; }
      while (cur.length > cols) { out.push(cur.slice(0, cols)); cur = cur.slice(cols); }  // no spaces to break on
    }
    out.push(cur);
  }
  return out;
}

// --- tool calls --------------------------------------------------------------
// The argument worth showing, per tool. Shared by the live view (runner) and the
// transcript viewer (chat) so a tool call reads the same in both places.
const ARG_KEYS = ['file_path', 'command', 'pattern', 'path', 'url', 'prompt', 'query'];

/** A tool_use block → its one-line parts: `Read` + `lib/store.mjs` → "Read(lib/store.mjs)". */
export function toolSummary(name, input, max = 60) {
  const n = String(name ?? 'tool');
  const key = ARG_KEYS.find((k) => input?.[k]);
  const arg = key ? trunc(String(input[key]), Math.max(10, max - n.length - 2)) : '';
  return { name: n, arg };
}

// --- screen control ----------------------------------------------------------
const w = (s) => { if (isTTY()) process.stdout.write(s); };
export const altEnter = () => w('\x1b[?1049h\x1b[?25l');   // alt buffer + hide cursor
export const altExit = () => w('\x1b[?1049l\x1b[?25h');    // restore + show cursor
export const clear = () => w('\x1b[2J\x1b[H');
export const moveTo = (row, col = 1) => w(`\x1b[${row};${col}H`);
export const hideCursor = () => w('\x1b[?25l');
export const showCursor = () => w('\x1b[?25h');

/** Paint a full frame: clears and writes `lines` from the top. */
export function paint(lines) {
  if (!isTTY()) { console.log(lines.map(strip).join('\n')); return; }
  clear();
  process.stdout.write(lines.join('\n'));
}

/** Restore the terminal no matter how we leave (Ctrl+C, crash, normal exit). */
export function installCleanup(extra) {
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    try { extra?.(); } catch { /* best effort */ }
    altExit();
  };
  process.on('exit', restore);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restore(); process.exit(130); });
  }
  return restore;
}

// --- boxes -------------------------------------------------------------------
export function box(lines, { title = '', pad = 1, cols } = {}) {
  const inner = cols ?? Math.max(...lines.map(width), width(title) + 4) + pad * 2;
  const bar = '─'.repeat(inner);
  const head = title
    ? '╭─ ' + c.accent(title) + ' ' + '─'.repeat(Math.max(0, inner - width(title) - 3)) + '╮'
    : '╭' + bar + '╮';
  const body = lines.map((l) => '│' + ' '.repeat(pad) + l + ' '.repeat(Math.max(0, inner - pad - width(l))) + '│');
  return [c.muted(head), ...body, c.muted('╰' + bar + '╯')];
}

/** Progress bar: "████████░░░░░░  62%" */
export function bar(pct, len = 30, color = c.accent) {
  const p = Math.max(0, Math.min(100, pct));
  const fill = Math.round((p / 100) * len);
  return color('█'.repeat(fill)) + c.muted('░'.repeat(len - fill)) + '  ' + c.bold(`${Math.round(p)}%`);
}

export const SPINNER = ['✻', '✼', '✽', '✻', '✦', '✧'];

// --- big block digits (the countdown clock) ----------------------------------
// 5 rows tall, 3 cells wide per glyph. Rendered at 2x horizontally → chunky.
const GLYPHS = {
  '0': ['███', '█ █', '█ █', '█ █', '███'],
  '1': [' █ ', '██ ', ' █ ', ' █ ', '███'],
  '2': ['███', '  █', '███', '█  ', '███'],
  '3': ['███', '  █', '███', '  █', '███'],
  '4': ['█ █', '█ █', '███', '  █', '  █'],
  '5': ['███', '█  ', '███', '  █', '███'],
  '6': ['███', '█  ', '███', '█ █', '███'],
  '7': ['███', '  █', '  █', '  █', '  █'],
  '8': ['███', '█ █', '███', '█ █', '███'],
  '9': ['███', '█ █', '███', '  █', '███'],
  ':': ['   ', ' █ ', '   ', ' █ ', '   '],
  ' ': ['   ', '   ', '   ', '   ', '   '],
};

/**
 * Render text (digits and ':') as 5 big lines.
 * `scale` doubles each cell horizontally so the clock reads from across the room.
 */
export function bigText(text, { color = c.accent, scale = 2, gap = 1 } = {}) {
  const chars = [...String(text)].filter((ch) => ch in GLYPHS);
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const parts = chars.map((ch) =>
      GLYPHS[ch][r].split('').map((cell) => cell.repeat(scale)).join('')
    );
    rows.push(color(parts.join(' '.repeat(gap * scale))));
  }
  return rows;
}

export const bigWidth = (text, { scale = 2, gap = 1 } = {}) => {
  const n = [...String(text)].filter((ch) => ch in GLYPHS).length;
  return n * 3 * scale + Math.max(0, n - 1) * gap * scale;
};
