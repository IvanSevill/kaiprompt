// Codex CLI adapter. The job contract is the same as Claude's: a prompt goes in and
// the adapter returns the final answer plus the persisted thread id for a later resume.
// Codex's `--json` output is JSONL, so it also gives the runner a live event stream.

import fs from 'node:fs';
import { runChildProcess } from './child-process.mjs';

export const name = 'codex';
const BIN = process.platform === 'win32' ? 'codex.cmd' : 'codex';

function buildArgs({ sessionId, model }) {
  const args = sessionId ? ['exec', 'resume'] : ['exec'];
  args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust');
  if (model) args.push('--model', model);
  if (sessionId) args.push(sessionId);
  return args;
}

function eventResult(evt) {
  const item = evt?.item;
  if (evt?.type === 'thread.started') return { sessionId: evt.thread_id ?? evt.threadId ?? null };
  if (item?.type === 'agent_message' && typeof item.text === 'string') return { output: item.text };
  return {};
}

export async function run({ prompt, sessionId, dryRun, dir, model, onEvent, spawnProcess }) {
  const args = buildArgs({ sessionId, model });
  const cwd = dir && fs.existsSync(dir) ? dir : null;
  const shown = `${BIN} ${args.join(' ')}`
    + `  (prompt on stdin${sessionId ? ', resumes ' + String(sessionId).slice(0, 8) + '…' : ', new session'}`
    + `${cwd ? ', in ' + cwd : ''})`;

  if (dryRun) return { ok: true, sessionId, output: `[dry-run] ${shown}\n--- prompt ---\n${prompt}` };

  const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (cwd) spawnOpts.cwd = cwd;

  let sid = sessionId;
  let output = '';
  return runChildProcess({
    command: BIN, args, options: spawnOpts, stdin: prompt,
    ...(spawnProcess ? { spawnProcess } : {}),
    onJSON: (evt) => {
      const found = eventResult(evt);
      if (found.sessionId) sid = found.sessionId;
      if (found.output) output = found.output;
      try { onEvent?.(evt); } catch { /* a live view must not break a launch */ }
    },
    onError: (error) => ({
      ok: false, sessionId: sid, output, error: `could not launch ${BIN}: ${error.message}`,
    }),
    onClose: ({ code, stderr }) => {
      const ok = code === 0;
      return { ok, sessionId: sid, output, error: ok ? null : (stderr || `codex exited with code ${code}`) };
    },
  });
}
