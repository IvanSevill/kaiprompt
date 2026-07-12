// How kaip leaves the screen — the same way from the GUI and from `run`, including on
// Ctrl+C.
//
// It clears, so you are not left staring at the wreck of a full-screen interface. And it
// answers the one question that matters as you walk away: is anything still going to
// happen, and is there anything left running to make it happen? Closing up with work
// scheduled and the daemon off is precisely the mistake this tool exists to prevent, so
// it gets said out loud on the way out.

import { loadQueue } from './store.mjs';
import { fmt } from './time.mjs';
import { altExit, c, hardClear, writeLines } from './ui.mjs';
import * as daemon from './daemon.mjs';

export function farewellLines() {
  const pending = loadQueue().filter((j) => j.status === 'pending');
  const scheduled = pending.filter((j) => j.when);
  const d = daemon.status();

  const out = ['', c.accent('  ✦ kaip') + c.muted('  — hasta luego'), ''];

  if (!pending.length) {
    out.push(c.muted('  la cola está vacía. Nada pendiente.'));
    return out;
  }

  const next = scheduled.length ? Math.min(...scheduled.map((j) => j.when)) : null;
  out.push(`  ${c.bold(String(pending.length))} pendiente${pending.length === 1 ? '' : 's'}`
    + (next ? c.muted(`  ·  el próximo: ${fmt(next)}`) : ''));

  if (scheduled.length && !d.running) {
    out.push('',
      c.err('  ⚠ el daemon está apagado: lo agendado NO se va a lanzar.'),
      c.muted('    arráncalo con:  ') + c.accent('kaip daemon start'));
  } else if (scheduled.length) {
    out.push(c.ok(`  ◆ daemon encendido (pid ${d.pid})`) + c.muted(' — saldrá solo a su hora.'));
  }

  const seq = pending.length - scheduled.length;
  if (seq) {
    out.push(c.muted(`  ${seq} sin hora: espera${seq === 1 ? '' : 'n'} a un `)
      + c.accent('kaip run') + c.muted('.'));
  }
  return out;
}

/**
 * Leave the full-screen buffer, clear, and say goodbye. Safe to call twice — only the
 * first one prints.
 *
 * altExit() has to come FIRST. Printing while the alternate screen is still up puts the
 * farewell on the buffer we are about to throw away: it was being written, correctly, onto
 * a screen that then vanished. Hence "no hace el clear" — it did, just somewhere you never
 * got to see.
 */
let said = false;
export function goodbye() {
  if (said) return;
  said = true;
  altExit();                    // back to the real screen…
  hardClear();                  // …wipe it for real (conhost ignores the ANSI erase)…
  writeLines(farewellLines().join('\n') + '\n');   // …and say it where it can be read
}
