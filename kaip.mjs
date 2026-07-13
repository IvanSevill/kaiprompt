#!/usr/bin/env node
// kaip — portable prompt queue for Claude Code (and opencode later).
//
// - Queues prompts and launches them headless, in order or at a scheduled time.
// - Persistent sessions: jobs sharing a --target resume the same conversation.
// - Each launch runs inside its own project folder (--dir).
// - Zero dependencies: plain Node only.
//
// CLI dispatch only — the real work lives in lib/.

import fs from 'node:fs';
import path from 'node:path';

import {
  importProgramados, loadProjects, loadQueue, loadSessions, nowMs,
  outPath, preview, saveProjects, saveSessions,
} from './lib/store.mjs';
import { fmt } from './lib/time.mjs';
import { reapStale, runQueue } from './lib/runner.mjs';
import { renderChat } from './lib/chat.mjs';
import { editJob } from './lib/edit.mjs';
import { addJob, clearFinished, jobDetails, removeJobs } from './lib/queue.mjs';
import { jobPreview } from './lib/prompt.mjs';
import { COMMANDS, ENGINES } from './lib/commands.mjs';
import { c, isTTY } from './lib/ui.mjs';

// --- argument parsing --------------------------------------------------------
function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}

// --- commands ----------------------------------------------------------------
async function cmdAdd({ flags, pos, engine }) {
  // --from LINKS the job to a file: the text is read at launch, not now. --file is the
  // opposite — it pastes the contents in as a snapshot, here and now.
  const from = typeof flags.from === 'string' ? flags.from : null;
  const prompt = from ? null : ((pos.join(' ').trim())
    || (typeof flags.file === 'string' ? fs.readFileSync(flags.file, 'utf8') : ''));

  if (!from && !prompt) {
    throw new Error('missing prompt.\n  usage: kaip add "your message" | --from <path/to/prompt.md>'
      + '\n         [--target name] [--at HH:MM|+30m] [--dir project] [--perm mode]');
  }
  const job = addJob({
    prompt,
    from,
    target: typeof flags.target === 'string' ? flags.target : null,
    at: typeof flags.at === 'string' ? flags.at : null,
    dir: typeof flags.dir === 'string' ? flags.dir : null,
    perm: typeof flags.perm === 'string' ? flags.perm : null,       // null → bypass
    adapter: typeof flags.adapter === 'string' ? flags.adapter : (engine || 'claude'),
    session: typeof flags.session === 'string' ? flags.session : null,
  });
  console.log(`+ ${job.id}  ${job.when ? '@ ' + fmt(job.when) : '(sequential)'}  `
    + `${job.target ? '[' + job.target + '] ' : ''}${preview(prompt ?? '')}`);
  if (job.promptFile) {
    console.log(`  ← ${job.promptFile}`);
    console.log('    (se lee al lanzar: puedes seguir editándolo hasta entonces)');
  }

  // Adding never launches. But a job with a time is a PROMISE, and something has to be
  // there to keep it — so make sure something is, and then say what actually is.
  if (!job.when) {
    console.log(c.muted('  secuencial: sale en tu próximo "run" (aquí no se lanza nada)'));
    return;
  }

  const { runnerLine, runnerStatus } = await import('./lib/runner-status.mjs');

  // Only arm the daemon if nothing is processing the queue. If a `run` is up, it will fire
  // this job perfectly well, and a daemon spawned now would just hit the lock and die —
  // after `add` had already announced it as "started, it will fire on time". Reporting a
  // process we then let die is the exact silent lie this tool exists to prevent.
  let st = runnerStatus();
  if (!st.willFire) {
    const d = await import('./lib/daemon.mjs');
    d.ensure();
    await new Promise((r) => setTimeout(r, 400));      // let it take the lock before we look
    st = runnerStatus();
  }

  // And now say what is TRUE, checked after the fact — not what we hoped would happen.
  const line = runnerLine(st);
  console.log('  ' + (line.ok ? c.ok('◆ ') + c.muted(line.text) : c.err('⚠ ') + c.muted(line.text)));
  if (line.hint) console.log(c.muted('    ') + c.accent(line.hint));
}

function cmdList({ flags, pos }) {
  const imp = importProgramados();
  if (imp) console.log(`(imported ${imp} from programados.jsonl)`);
  // A job whose runner died still says "running" until someone closes it out, and this
  // is the screen you actually read — a status that lies here is the worst place for it.
  const dead = reapStale();
  if (dead) console.log(`(${dead} job(s) left hanging by a dead runner marked as error)`);

  const q = loadQueue();
  if (!q.length) return console.log('(empty queue)');
  // parseArgs only understands "--" flags; short ones (-f/-l) land in pos.
  const full = flags.full || flags.f || flags.l || pos.includes('-f') || pos.includes('-l');
  const icon = { pending: '·', running: '▶', done: '✓', error: '✗', missed: '⊘' };
  for (const j of q) {
    if (full) { console.log(jobDetails(j), '\n'); continue; }
    const when = j.when ? '@ ' + fmt(j.when) : 'seq';
    console.log(`${icon[j.status] || '?'} ${j.id}  ${String(j.status).padEnd(7)} `
      + `${when.padEnd(22)} ${j.adapter}${j.target ? '/' + j.target : ''}  ${jobPreview(j)}`);
  }
}

function cmdShow({ flags, pos }) {
  if (!pos.length) throw new Error('usage: kaip show <id>');
  importProgramados();                    // the id may be a scheduled job not imported yet
  const job = loadQueue().find((j) => j.id === pos[0]);
  if (!job) return console.log(`no job found with id "${pos[0]}"`);

  console.log(jobDetails(job));

  // The details are only half the story. Once a launch has run, what you actually want
  // to see is the CONVERSATION it had — not the prompt you already know you wrote.
  if (!job.sessionId) {
    console.log(c.muted(`\n(no conversation yet: this job is ${job.status})`));
    return;
  }
  const last = typeof flags.last === 'string' ? Number(flags.last) : 20;
  try {
    console.log('\n' + renderChat(job.id, { last, full: !!flags.full }));
  } catch (e) {
    console.log(c.muted(`\n(no transcript: ${e.message.split('\n')[0]})`));
  }
}

function cmdChat({ flags, pos }) {
  importProgramados();                    // a job scheduled from the chat may not be in the queue yet
  const last = typeof flags.last === 'string' ? Number(flags.last) : 20;
  if (!Number.isFinite(last) || last < 1) throw new Error('--last needs a positive number of turns');
  console.log(renderChat(pos[0], { last, full: !!flags.full, raw: !!flags.raw }));
}

function cmdEdit({ flags, pos }) {
  const { job, changes } = editJob(pos[0], flags);
  console.log(`✎ ${job.id}  updated: ${changes.join(', ')}\n`);
  console.log(jobDetails(job));
}

function cmdRm({ pos }) {
  if (!pos.length) throw new Error('usage: kaip rm <id> [<id>...]');
  console.log(`removed ${removeJobs(pos)}`);
}

function cmdClear() {
  console.log(`cleared ${clearFinished()} finished entries`);
}

function cmdOut({ pos }) {
  const q = loadQueue();
  const job = pos.length
    ? q.find((j) => j.id === pos[0])
    : q.filter((j) => j.output).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0];
  if (!job) return console.log('(no outputs yet; run something with "kaip run")');
  console.log(`── ${job.id} [${job.status}]${job.target ? ' ' + job.target : ''}  ${jobPreview(job)} ──`);
  if (job.dir) console.log(`   folder: ${job.dir}`);
  if (job.sessionId) {
    console.log(`   session: ${job.sessionId}`);
    console.log(`   resume:  cd "${job.dir || '.'}" && claude --resume ${job.sessionId}`);
  }
  const f = outPath(job.id);                    // the file is always out/<id>.txt under HOME
  if (job.output && fs.existsSync(f)) console.log('\n' + fs.readFileSync(f, 'utf8').trimEnd());
  else console.log('(no output file yet)');
}

function cmdProjects({ pos }) {
  const map = loadProjects();
  if (pos.length >= 2) {                          // projects <alias> <path>
    const alias = pos[0]; map[alias] = pos.slice(1).join(' ');
    saveProjects(map);
    return console.log(`+ ${alias} → ${map[alias]}`);
  }
  if (map._base) {
    console.log(`base: ${map._base}`);
    try {
      const subs = fs.readdirSync(map._base, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
      if (subs.length) console.log('  projects (by name): ' + subs.join(', '));
    } catch { console.log('  (base not accessible)'); }
  }
  const alias = Object.keys(map).filter((k) => k !== '_base');
  if (alias.length) { console.log('aliases:'); for (const k of alias) console.log(`  ${k} → ${map[k]}`); }
  if (!map._base && !alias.length) console.log('(no projects; use: kaip projects <alias> <path>)');
}

// The daemon is what makes a scheduled launch fire on its own. `run` is the loop
// itself (what the detached child executes); the rest are controls around it.
async function cmdDaemon({ flags, pos }) {
  const d = await import('./lib/daemon.mjs');
  const sub = pos[0] || 'status';
  const seq = Boolean(flags.seq);

  switch (sub) {
    case 'run':                                   // foreground loop — this IS the daemon
      return runQueue({ loop: true, scheduledOnly: !seq });

    case 'start': {
      const r = d.start({ seq });
      // Not started is not always a failure — but it is always something we have to say
      // straight. Announcing a daemon we did not start (or started and let die on the lock)
      // is the lie this command used to tell.
      if (r.reason === d.RUN_IS_DRAINING) {
        console.log(c.ok('◆ ') + `${d.RUN_IS_DRAINING} (pid ${r.runner.pid})`);
        console.log(c.muted('  no daemon started: one thing drains the queue, and it already is.'));
        return console.log(c.muted('  it dies with that window, though — close it and run this again.'));
      }
      if (!r.started) return console.log(d.statusLine());
      console.log(`daemon started (pid ${r.pid})${seq ? ' · sequential jobs too' : ''}`);
      console.log(`  log: ${r.log}`);
      return console.log('  scheduled launches will now fire on their own.');
    }

    case 'stop': {
      const r = d.stop();
      return console.log(r.stopped ? `daemon stopped (pid ${r.pid})` : 'daemon was not running');
    }

    case 'restart': {
      d.stop();
      const r = d.start({ seq });
      return console.log(r.started ? `daemon restarted (pid ${r.pid})` : d.statusLine());
    }

    case 'status': {
      const st = d.status();
      const auto = d.autostartInstalled();
      console.log(d.statusLine(st));
      if (st.running) console.log(`  since ${fmt(st.startedAt)}`);

      // Count the actual processes, not the file. The file says what we THINK is up; a
      // leftover from a crash or a lost race says nothing at all, and only shows up here.
      const procs = d.daemonProcesses();
      const loose = d.unaccounted(procs, st.running ? st.pid : null);
      console.log(`  "daemon run" processes alive: ${procs.length}`);
      if (loose.length) {
        console.log(c.warn(`  ⚠ ${loose.length} of them nobody is tracking `)
          + c.muted(`(pid ${loose.map((p) => p.pid).join(', ')})`));
        console.log(c.muted('    they are not the daemon in daemon.json: leftovers from a crash or a race.'));
        console.log(c.muted('    sweep them with:  ') + c.accent('kaip daemon sweep'));
      }

      console.log(`  autostart at logon: ${auto ? 'installed' : 'not installed'}`
        + `${auto ? '' : '  (kaip daemon install)'}`);
      return console.log(`  log: ${st.log}`);
    }

    case 'sweep': {
      const killed = d.sweep();
      if (!killed.length) return console.log('no orphan daemons; nothing to sweep.');
      return console.log(c.ok(`swept ${killed.length} orphan daemon(s): `) + killed.join(', '));
    }

    case 'install': {
      const r = d.autostartInstall();
      if (!r.ok) throw new Error(r.error);
      console.log(`autostart installed (task "${r.task}"): the daemon comes back up when you log in.`);
      return console.log(d.statusLine(d.ensure({ seq })));
    }

    case 'uninstall': {
      const r = d.autostartRemove();
      if (!r.ok) throw new Error(r.error);
      return console.log('autostart removed (the daemon itself keeps running until you stop it)');
    }

    case 'log': {
      if (!fs.existsSync(d.LOG)) return console.log('(no log yet — the daemon has not run)');
      const n = Number(flags.last) || 30;
      const lines = fs.readFileSync(d.LOG, 'utf8').trimEnd().split('\n');
      return console.log(lines.slice(-n).join('\n'));
    }

    default:
      throw new Error(`unknown: daemon ${sub}`
        + '\n  use: start | stop | restart | status | sweep | install | uninstall | log');
  }
}

// The app, published. A permanent address beats one we serve ourselves: it survives this
// machine being off, and it survives the tunnel getting a new URL on every restart.
const APK_RELEASE = 'https://github.com/IvanSevill/kaiprompt/releases/latest/download/kaiprompt.apk';

/** Where the pairing info gets written, so the QR can be shown without re-tunnelling. */
async function saveLastUrl(url) {
  const { saveServerConfig, serverConfig } = await import('./lib/server.mjs');
  const conf = serverConfig();
  conf.publicUrl = url;
  conf.publicUrlAt = Date.now();
  saveServerConfig(conf);
}

async function cmdApp({ pos }) {
  const { spawnSync } = await import('node:child_process');
  const { ROOT } = await import('./lib/store.mjs');
  const { apkPath } = await import('./lib/server.mjs');
  const appDir = path.join(ROOT, 'app');

  // The wrapper by ABSOLUTE path, quoted. Naming it "gradlew.bat" and trusting cwd looked
  // fine and failed on every Windows box — cmd would not resolve it from the working
  // directory, so `kaip app build` and `kaip app test` were two more commands that told you
  // to run them and then didn't run.
  const gradlew = `"${path.join(appDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')}"`;
  const gradle = (task) => spawnSync(gradlew, [task], { cwd: appDir, stdio: 'inherit', shell: true });

  if (pos[0] === 'build' || !pos.length) {
    if (!fs.existsSync(path.join(appDir, 'local.properties'))) {
      // Gradle cannot find the Android SDK without this, and its own error message about it
      // is famously unhelpful.
      console.log(c.warn('falta app/local.properties (Gradle no sabe dónde está el SDK de Android).'));
      console.log(c.muted('  créalo con una línea:'));
      console.log(c.accent('  sdk.dir=C:/Users/<tu-usuario>/AppData/Local/Android/Sdk'));
      return;
    }

    console.log(c.muted('compilando el APK… (la primera vez tarda unos minutos)'));
    const r = gradle(':app:assembleRelease');
    if (r.status !== 0) return console.log(c.err('\nla compilación falló.'));

    const apk = apkPath();
    console.log('\n' + c.ok('✓ APK listo') + c.muted(`  ${apk}`));
    console.log(c.muted('  para enlazarlo con este PC: ') + c.accent('kaip serve') + c.muted(' (saca el QR de emparejamiento)'));
    return;
  }

  if (pos[0] === 'test') {
    const r = gradle(':app:testDebugUnitTest');
    if (r.status !== 0) return console.log(c.err('\nlos tests de la app fallaron.'));
    return console.log(c.ok('\n✓ tests de la app en verde'));
  }

  console.log('uso: kaip app [build|test]');
}

async function cmdServe({ flags }) {
  const { DEFAULT_PORT, addresses, createServer, resetToken, serverConfig } = await import('./lib/server.mjs');
  const { installCleanup, setTitle } = await import('./lib/ui.mjs');
  const port = Number(flags.port) || DEFAULT_PORT;

  // "I lost my phone." The token and the KEY are both thrown away and every paired device
  // is dropped, so the lost phone is locked out from the next request on. The ability was
  // here all along (resetToken); the command that reached it disappeared in a rename, which
  // left the tool with an unpair button you could not press.
  if (flags.reset) {
    resetToken();
    console.log(c.ok('✓ emparejamientos anulados') + c.muted(' — token y clave nuevos.'));
    console.log(c.muted('  los móviles que había quedan fuera desde ya; vuelve a escanear el QR.\n'));
  }

  // --wifi: nothing leaves the house. No tunnel, no Cloudflare, no third party at all —
  // the phone talks to this machine over the local network and that is the end of it. The
  // trade is that it only works while you are on the same wifi.
  const wifiOnly = !!flags.wifi || !!flags.local || !!flags['no-tunnel'] || flags.tunnel === false;

  createServer({ port });
  console.log(c.bold('kaip serve') + c.muted(`  ·  puerto ${port}`));

  // The window title says whether the phone is actually on the other end — the one thing you
  // want to know from a glance at the taskbar, and the one thing a terminal called "node"
  // cannot tell you. It changes the moment a phone pairs, and it is put back when we exit.
  installCleanup();
  const titleTick = () => {
    const n = (serverConfig().devices ?? []).length;
    setTitle(n ? `kaip · connected (${n})` : 'kaip · waiting');
  };
  titleTick();
  setInterval(titleTick, 1000).unref?.();

  const lan = addresses(port)[0];
  if (lan) console.log(c.muted('  en casa:  ') + (wifiOnly ? c.accent(lan.url) : lan.url));

  if (wifiOnly) {
    // Forget any tunnel URL from a previous run, or the QR would hand the phone an address
    // that died when that tunnel closed — and it would fail far from here, silently.
    await saveLastUrl(null);
    console.log(c.muted('\n  solo wifi: sin túnel, sin Cloudflare, sin terceros.'));
    console.log(c.muted('  el móvil tiene que estar en tu misma red.'));
  } else {
    const { startTunnel, TunnelError } = await import('./lib/tunnel.mjs');
    process.stdout.write(c.muted('  abriendo el túnel de Cloudflare… '));
    try {
      const { url } = await startTunnel(port);
      await saveLastUrl(url);
      console.log(c.ok('listo'));
      console.log(c.muted('  fuera:    ') + c.accent(url) + c.muted('   ← funciona desde cualquier red'));
      console.log(c.muted('\n  va cifrado extremo a extremo: Cloudflare mueve bytes que no puede leer.'));
      console.log(c.muted('  ¿lo quieres sin Cloudflare? → ') + c.accent('kaip serve --wifi'));
    } catch (e) {
      console.log(c.err('falló'));
      console.log(c.muted('  ' + (e instanceof TunnelError ? e.message : e.message).replace(/\n/g, '\n  ')));
      await saveLastUrl(null);
      console.log(c.muted('\n  seguimos en local: el móvil solo llega estando en tu wifi.'));
    }
  }

  // The pairing QR lives here, not behind a second command. You always need it right after
  // starting the server — and with a quick tunnel you need it EVERY time, because the URL
  // changes on each run. Making that a separate command you must remember to type was
  // friction with no upside.
  await showPairing(port);

  console.log(c.muted('\n  Ctrl+C para parar.  (el túnel muere con esta ventana)'));
}

/**
 * The pairing QR: where to connect, the token, and the key that makes the tunnel safe.
 *
 * It takes the screen back the moment the phone actually pairs. A QR left up after it has
 * done its job is not neutral — it is a secret sitting on your monitor, and the natural
 * thing to do with a code you no longer need is to stop looking at it, not to keep it
 * displayed while you go and make coffee.
 */
async function showPairing(port) {
  const { pairingCompact, serverConfig } = await import('./lib/server.mjs');
  const { render } = await import('./lib/qr.mjs');
  const { hardClear } = await import('./lib/ui.mjs');

  const before = (serverConfig().devices ?? []).map((d) => d.url);

  // The COMPACT payload: a terminal draws each module as half a character cell, so the code
  // ends up a couple of centimetres across and the camera has to resolve every module out of
  // that. Sixty bytes off the payload is two QR versions off the grid, and that is the
  // difference between "scans" and "worked yesterday, doesn't today".
  const p = pairingCompact(port, serverConfig().publicUrl || null);

  console.log('\n' + c.bold('  escanea esto DESDE la app') + c.muted('  — para enlazarla con este PC\n'));
  console.log(render(JSON.stringify(p)).replace(/^/gm, '  '));

  // And the escape hatch, because a terminal QR is always going to be the hard way to read
  // one: the same code in a browser, ten times the size, scans every time.
  console.log(c.muted('\n  ¿no lo pilla la cámara? ábrelo GRANDE en el navegador:'));
  console.log('  ' + c.accent(`http://localhost:${port}/pair`));

  // The key is why the tunnel is safe, and why it must go by QR and not down the wire.
  console.log(c.muted('\n  la clave de cifrado viaja DENTRO de ese código, no por el túnel:'));
  console.log(c.muted('  la escaneas de tu propia pantalla, así que Cloudflare nunca la ve.'));
  console.log(c.muted('\n  ¿aún no tienes la app? → ') + c.accent('kaip mobile'));

  if (before.length) console.log(c.muted('\n  ya emparejados: ') + before.length);

  // Watch for the phone announcing itself. It registers a callback URL the instant it
  // pairs, so a new device in the config IS the handshake completing.
  const timer = setInterval(() => {
    const now = serverConfig().devices ?? [];
    const fresh = now.find((d) => !before.includes(d.url));
    if (!fresh) return;

    clearInterval(timer);
    hardClear();
    console.log(c.bold(c.accent('  ✦ kaip')) + c.muted('  ·  servidor en marcha\n'));
    console.log(c.ok(`  ✓ ${fresh.name} emparejado`) + c.muted('  — el QR ya no hace falta.\n'));
    console.log(c.muted('  te avisará al móvil cuando termine un lanzamiento.'));
    console.log(c.muted('  Ctrl+C para parar.'));
  }, 1000);
  timer.unref?.();
}


/**
 * The QR that gets the app onto the phone.
 *
 * Its own command, because it answers a different question from the pairing QR (`serve`) and
 * you only need it once. Mixing the two put a code you will never scan again on the screen
 * every single time you paired.
 *
 * It points at the GitHub release, not at this machine: that URL is permanent and works with
 * the PC switched off, whereas a quick tunnel gets a new address on every restart — a QR
 * that quietly stops working is worse than no QR.
 */
async function cmdMobile() {
  const { render } = await import('./lib/qr.mjs');

  console.log(c.bold('descargar Kaiprompt') + c.muted('  — escanea con la cámara del móvil\n'));
  console.log(render(APK_RELEASE));
  console.log(c.muted(`\n   ${APK_RELEASE}\n`));
  console.log(c.muted('   Android te pedirá permiso para instalar de origen desconocido: acéptalo.'));
  console.log(c.muted('   luego, para enlazarla con este PC: ') + c.accent('kaip serve') + c.muted(' — el QR de emparejamiento sale ahí mismo.'));
}

function cmdSessions({ pos } = { pos: [] }) {
  if (pos[0] === 'set') {                          // sessions set <target> <session-id>
    const [, target, sid] = pos;
    if (!target || !sid) throw new Error('usage: kaip sessions set <target> <session-id>');
    const s = loadSessions();
    s[target] = { sessionId: sid, adapter: 'claude', updatedAt: nowMs() };
    saveSessions(s);
    return console.log(`set ${target} → ${sid}`);
  }
  const s = loadSessions(); const keys = Object.keys(s);
  if (!keys.length) return console.log('(no saved sessions)');
  for (const k of keys) console.log(`${k}  →  ${s[k].sessionId}  [${s[k].adapter}]  ${fmt(s[k].updatedAt)}`);
}

const HELP = `kaip — portable prompt queue for Claude Code (and opencode later)

Usage:
  kaip                       open the guided GUI (needs a terminal)
  kaip <engine> <subcommand> [args]
  <engine> = claude | opencode   (optional; defaults to claude)

Queue:
  add "<prompt>"              queue a launch  [--at <when>] [--target <n>] [--dir <project>]
                              [--perm <mode>] [--session <id>]
  add --from <path>           the prompt lives in a FILE, read at launch — keep editing it
                              until the second it goes out  (--file pastes it in NOW instead)
  list [--full|-f]            the queue, with status
  show <id>                   the job AND the whole conversation it had
  edit <id>                   change a pending job (--prompt --from --at --target --dir --perm)
  rm <id> [<id>...]           remove jobs
  clear                       clear finished/error entries

Running:
  daemon <start|stop|status>  the background runner: fires scheduled launches on time,
                              with nothing open. "install" brings it back at logon.
  run                         process the queue NOW (countdown + live view). Stays up when
                              the queue empties, so you can keep feeding it.
     --once                   drain and exit (for scripts)
     --parallel N             different conversations need not wait for each other
     --plain                  no full-screen view — for servers and CI
  gui                         the guided GUI (same as running with no arguments)

Seeing what happened:
  out [<id>]                  the ANSWER — just the last thing Claude said
  chat <id|target|session>    the CONVERSATION — every turn  [--last N] [--full] [--raw]

The phone:
  serve                       the API + a Cloudflare tunnel, and the pairing QR.
                              Works from any network; no VPN, no ports opened.
     --wifi                   no tunnel, no Cloudflare, no third party. Your network only.
     --reset                  "I lost my phone": new token and new key, every paired
                              device dropped. They are locked out from the next request.
  mobile                      the QR to download the app
  app <build|test>            build the APK yourself (needs the Android SDK)

Setup:
  sessions                    saved sessions (name → session-id)
  sessions set <t> <id>       assign a session-id to a target by hand
  projects                    folders/projects available for --dir
  projects <alias> <path>     register a folder alias
  help

Scheduling vs running — the one thing to understand:
  A job WITH a time (--at) is scheduled: the daemon fires it at that time, on its own.
  Nothing else needs to be open. That is the point of the tool.
  A job WITHOUT a time is sequential: it sits in the queue and only goes when YOU run
  the queue ("run", or "r" in the GUI). Adding it never launches it.
  So: scheduling is not launching. Neither the GUI nor "add" ever sends a prompt.

Notes:
  <engine>   the adapter used to LAUNCH (--adapter). Stored per job by "add".
  --target   groups jobs into a persistent conversation: the 1st creates the session,
             the rest resume it (claude --resume). Stored in data/sessions.json.
  --at       HH:MM (today/tomorrow), +30m / +2h / +1d, "tomorrow 09:00", or ISO.
             Without --at the job is sequential (see above).
  daemon     start: a detached background runner; scheduled launches fire without a
             terminal open. stop / restart / status / log [--last N].
             There is ONE daemon, and a "kaip run" is the same role — draining the
             queue — so with a run up, start does nothing and says so. sweep kills
             leftover daemons nobody is tracking (status counts them).
             install: bring it back automatically when you log in (Windows).
             It only takes scheduled jobs. --seq makes it drain sequential ones too.
  --dir      folder/project to run in. Accepts a project name (subfolder of _base),
             an alias, or a path. Defaults to the current folder.
  --perm     permission mode for the unattended launch. Default: bypass (full autonomy:
             edits + Bash + installs, no prompts). Use "acceptEdits" for edits only.
  run        runs the queue now: due scheduled jobs first, then sequential ones, then
             waits for the future ones (unless --once). Output → out/<id>.txt
             You do NOT need this for scheduled jobs — that's the daemon's job.
  chat       the whole conversation, not just the last answer (that's "out"). Takes a
             target, a job id or a session-id. --last N turns (default 20), --full for
             everything (thinking + tool results), --raw for the transcript as-is.
  edit       only PENDING jobs (a running/finished one is already history). Same flags
             as "add"; --target/--dir/--perm accept "none" to clear them.
  gui        views: Queue · Chats · Projects · Help. Keys: ↑↓ move · ←→/tab/1-4 view ·
             enter detail · a add (guided) · e edit · d delete · D daemon on/off ·
             r run now · o output · c chat · ? help · q quit. The header tells you
             whether the daemon is up — if it isn't, nothing you schedule will fire.
             Adding a launch never sends it. Without a terminal it prints this help.

Examples:
  kaip daemon start                       arm it once; scheduled jobs now fire alone
  kaip claude add "/test" --at "tomorrow 09:00" --target fixes --dir myapp
  kaip claude run
  kaip list
  kaip out
  kaip chat fixes --last 40
  kaip edit jlzz4t3h6 --at "tomorrow 09:00" --perm acceptEdits
`;

// --- dispatch ----------------------------------------------------------------
// Optional first token = ENGINE (claude | opencode) → default --adapter for `add`.
let av = process.argv.slice(2);
let engine = null;
if (ENGINES.includes(av[0])) { engine = av[0]; av = av.slice(1); }
const [cmd, ...rest] = av;
const parsed = parseArgs(rest);
parsed.engine = engine;

try {
  switch (cmd) {
    case 'add': await cmdAdd(parsed); break;
    case 'list': case 'ls': cmdList(parsed); break;
    case 'show': cmdShow(parsed); break;
    // `run` STAYS UP by default, including on an empty queue. You leave it going and feed
    // it — from another terminal, or with /programar — and it picks the work up on its own.
    // A runner that quit the moment it ran dry was useless for exactly the case it exists
    // for. Scripts that want drain-and-exit ask for it with --once.
    case 'run': await runQueue({
      once: !!parsed.flags.once,
      dryRun: !!parsed.flags['dry-run'],
      parallel: Number(parsed.flags.parallel) || 1,
      plain: !!parsed.flags.plain || !!parsed.flags['no-tui'],
      watch: !parsed.flags.once && parsed.flags.watch !== false && !parsed.flags['no-watch'],
    }); break;
    case 'rm': cmdRm(parsed); break;
    case 'clear': cmdClear(); break;
    case 'out': cmdOut(parsed); break;
    case 'chat': cmdChat(parsed); break;
    case 'edit': cmdEdit(parsed); break;
    case 'projects': case 'project': cmdProjects(parsed); break;
    case 'sessions': cmdSessions(parsed); break;
    case 'daemon': await cmdDaemon(parsed); break;
    case 'app': await cmdApp(parsed); break;
    case 'serve': await cmdServe(parsed); break;
    case 'mobile': await cmdMobile(parsed); break;
    // No subcommand → the GUI, but only with a real terminal: raw mode on a piped
    // stdin (Task Scheduler, cron, a pipe) would hang forever. There, print the help.
    case undefined:
      if (isTTY() && process.stdin.isTTY) { const { startTUI } = await import('./lib/tui.mjs'); await startTUI(); }
      else console.log(HELP);
      break;
    case 'gui': { const { startTUI } = await import('./lib/tui.mjs'); await startTUI(); break; }
    case 'help': case '--help': case '-h': console.log(HELP); break;
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(c.muted(`there is no such command. There is: ${COMMANDS.join(' · ')}\n`));
      console.log(HELP);
      process.exit(1);
  }
} catch (e) { console.error('Error:', e.message); process.exit(1); }
