// Raw stdin bytes → keys. Nothing here knows what a job is.
//
// Split out of tui.mjs because it is the one part of the GUI with no opinion about the GUI:
// it turns a terminal's noise into names ('up', 'enter', 'esc') and marks what was pasted.
// It is also the part most worth testing on its own, and now it can be.

// --- bracketed paste ----------------------------------------------------------
// The terminal wraps pasted text in these two markers, which is the only way to tell
// "the user pasted this" from "the user typed this very fast" without guessing.
export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** Pasted text, marked as such. A key name ('up', 'tab') is text too — this is what tells them apart. */
export const asPaste = (text) => PASTE_START + String(text).replace(/\r\n?/g, '\n') + PASTE_END;

/** A burst of printable characters in one chunk is a paste: nobody types 200 characters at once. */
const looksPasted = (s) => s.length > 1 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s);

/** Raw stdin chunk → a key name ('up', 'enter', 'esc'…) or the character(s) typed. */
export function decodeKey(data) {
  const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  // Windows Terminal sends \r for Enter, and a pasted line break arrives as \r\n. Normalising
  // here means the rest of the file only ever has to know about \n.
  const s = raw.replace(/\r\n?/g, '\n');
  const named = {
    '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
    '\n': 'enter', '\x1b': 'esc', '\x7f': 'backspace', '\b': 'backspace',
    '\t': 'tab', '\x03': 'ctrl-c', '\x0c': 'ctrl-l', ' ': 'space',
  };
  return named[s] ?? s;
}

/**
 * Is this key actually a paste? Then the text of it — otherwise null.
 *
 * In raw mode a paste is not an event: it is a burst of characters in one `data` chunk. The
 * key reader was treating each burst as ONE keypress and dropping the rest, which is why
 * Ctrl+V did nothing at all in the wizard.
 */
export function pasteText(key) {
  const s = String(key ?? '');
  if (!s.startsWith(PASTE_START) || !s.endsWith(PASTE_END)) return null;
  return s.slice(PASTE_START.length, -PASTE_END.length);
}

/**
 * A stdin chunk → the keys it carries.
 *
 * Stateful, and only for one reason: a big bracketed paste can arrive split across chunks, so
 * the text between the markers has to be stitched back together before it counts as one key.
 * Terminals that do not do bracketed paste get the burst heuristic instead, and either way
 * what comes out is one marked paste key.
 */
export function keyReader() {
  let pending = null;                     // an open paste, still waiting for its end marker

  return function read(data) {
    const s = (Buffer.isBuffer(data) ? data.toString('utf8') : String(data)).replace(/\r\n?/g, '\n');
    if (!s) return [];

    if (pending !== null) {
      const buf = pending + s;
      const end = buf.indexOf(PASTE_END);
      if (end === -1) { pending = buf; return []; }              // more of it is still coming
      pending = null;
      return [asPaste(buf.slice(0, end)), ...read(buf.slice(end + PASTE_END.length))];
    }

    const start = s.indexOf(PASTE_START);
    if (start !== -1) {
      const before = start ? read(s.slice(0, start)) : [];
      const rest = s.slice(start + PASTE_START.length);
      const end = rest.indexOf(PASTE_END);
      if (end === -1) { pending = rest; return before; }
      return [...before, asPaste(rest.slice(0, end)), ...read(rest.slice(end + PASTE_END.length))];
    }

    const key = decodeKey(s);
    // decodeKey gave back the text unchanged ⇒ it is not a named key. Several characters of
    // plain text in one chunk did not come off a keyboard: they were pasted.
    return [key === s && looksPasted(s) ? asPaste(s) : key];
  };
}
