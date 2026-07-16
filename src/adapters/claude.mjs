// Claude Code adapter — runs the prompt headless and captures the session id.
//
//   one-shot:  claude -p --output-format json            (prompt on stdin)
//   streaming: claude -p --output-format stream-json --verbose   → live NDJSON events
//   resume:    ... --resume <session-id>
//
// Pass `onEvent` to get the streaming mode: it's called for every event as it
// arrives, so the runner can show what Claude is doing live. Without it we keep
// the plain one-shot JSON (used by --dry-run and by scripts).

import fs from 'node:fs';
import { runChildProcess } from './child-process.mjs';

export const name = 'claude';
const BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';

function buildArgs({ sessionId, permMode, streaming, model }) {
  // Permission mode for UNATTENDED launches: without this, `claude -p` asks for
  // permissions nobody answers at 3am and the launch does nothing.
  // Default "bypass" (full autonomy) — deliberate choice for scheduled runs.
  //   --perm acceptEdits → only auto-accepts file edits
  //   --perm default     → prompts (will stall unattended)
  const mode = permMode || 'bypass';
  const args = ['-p', '--output-format', streaming ? 'stream-json' : 'json'];
  if (streaming) args.push('--verbose');            // stream-json requires --verbose
  if (mode === 'bypass' || mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', mode);
  // Omit this when no model was selected: that deliberately preserves Claude Code's own
  // configured default for older jobs and existing workflows.
  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

export async function run({ prompt, sessionId, dryRun, dir, permMode, model, onEvent, spawnProcess }) {
  const streaming = typeof onEvent === 'function';
  const args = buildArgs({ sessionId, permMode, streaming, model });
  const cwd = dir && fs.existsSync(dir) ? dir : null;    // run claude inside the target project
  const shown = `${BIN} ${args.join(' ')}` +
    `  (prompt on stdin${sessionId ? ', resumes ' + String(sessionId).slice(0, 8) + '…' : ', new session'}` +
    `${cwd ? ', in ' + cwd : ''})`;

  if (dryRun) return { ok: true, sessionId, output: `[dry-run] ${shown}\n--- prompt ---\n${prompt}` };

  // Always use the Claude Code subscription, never the paid API: drop API keys
  // from the child environment so it falls back to the logged-in session.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true };
  if (cwd) spawnOpts.cwd = cwd;

  let sid = sessionId;
  let result = null;
  let usage = null;
  let isError = false;

  const handleEvent = (evt) => {
    if (evt.session_id) sid = evt.session_id;
    if (evt.type === 'result') {
      result = evt.result ?? '';
      isError = Boolean(evt.is_error);
      usage = evt.usage ?? usage;
    }
    try { onEvent(evt); } catch { /* the view must never break the run */ }
  };

  return runChildProcess({
    command: BIN, args, options: spawnOpts, stdin: prompt,
    mode: streaming ? 'ndjson' : 'text', ...(spawnProcess ? { spawnProcess } : {}),
    onJSON: handleEvent,
    onError: (error, { stderr }) => ({
      ok: false, sessionId: sid, output: stderr, error: `could not launch ${BIN}: ${error.message}`,
    }),
    onClose: ({ code, stdout: raw, stderr: err }) => {
      if (streaming) {
        const ok = code === 0 && !isError;
        return {
          ok, sessionId: sid, output: result ?? '',
          error: ok ? null : (err || `claude exited with code ${code}`),
          usage,
        };
      }
      let out = raw, ok = code === 0;
      try {
        const j = JSON.parse(raw);
        sid = j.session_id || sid;
        out = j.result ?? raw;
        if (j.is_error) ok = false;
        usage = j.usage ?? usage;
      } catch { /* non-JSON output: leave it raw */ }
      return { ok, sessionId: sid, output: out, error: ok ? null : (err || `claude exited with code ${code}`), usage };
    },
  });
}
