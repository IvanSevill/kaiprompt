// Codex CLI adapter. The job contract is the same as Claude's: a prompt goes in and
// the adapter returns the final answer plus the persisted thread id for a later resume.
// Codex's `--json` output is JSONL, so it also gives the runner a live event stream.

import { spawn } from 'node:child_process';
import fs from 'node:fs';

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

export async function run({ prompt, sessionId, dryRun, dir, model, onEvent }) {
  const args = buildArgs({ sessionId, model });
  const cwd = dir && fs.existsSync(dir) ? dir : null;
  const shown = `${BIN} ${args.join(' ')}`
    + `  (prompt on stdin${sessionId ? ', resumes ' + String(sessionId).slice(0, 8) + '…' : ', new session'}`
    + `${cwd ? ', in ' + cwd : ''})`;

  if (dryRun) return { ok: true, sessionId, output: `[dry-run] ${shown}\n--- prompt ---\n${prompt}` };

  const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (cwd) spawnOpts.cwd = cwd;

  return await new Promise((resolve) => {
    let child;
    try { child = spawn(BIN, args, spawnOpts); }
    catch (e) { return resolve({ ok: false, sessionId, output: '', error: `could not launch ${BIN}: ${e.message}` }); }

    let stderr = ''; let buffer = ''; let sid = sessionId; let output = '';
    const handle = (evt) => {
      const found = eventResult(evt);
      if (found.sessionId) sid = found.sessionId;
      if (found.output) output = found.output;
      try { onEvent?.(evt); } catch { /* a live view must not break a launch */ }
    };

    child.on('error', (e) =>
      resolve({ ok: false, sessionId: sid, output, error: `could not launch ${BIN}: ${e.message}` }));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => {
      buffer += String(d);
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* keep going: diagnostics can be non-JSON */ }
      }
    });
    child.on('close', (code) => {
      const tail = buffer.trim();
      if (tail) { try { handle(JSON.parse(tail)); } catch { /* ignored */ } }
      const ok = code === 0;
      resolve({ ok, sessionId: sid, output, error: ok ? null : (stderr || `codex exited with code ${code}`) });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
