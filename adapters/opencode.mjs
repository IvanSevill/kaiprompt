// opencode adapter — NOT IMPLEMENTED (stub).
//
// When it is implemented, the contract is identical to claude.mjs:
//   run({ prompt, sessionId, dryRun }) -> { ok, sessionId, output, error }
//
// The intended plan (to be confirmed against whatever the opencode CLI looks like by then):
//   new:     opencode run "<prompt>"                    → capture the session id it returns
//   resume:  opencode run --session <id> "<prompt>"     (or whatever the equivalent flag is)
// The queue (queue.json) and the session store (sessions.json) do NOT change: only this
// file does. That is why moving to opencode does not mean rebuilding anything else.
export const name = 'opencode';

export async function run({ prompt, sessionId, dryRun }) {
  const shown = `opencode run "${String(prompt).split('\n')[0]}"${sessionId ? ' (--session ' + sessionId + ')' : ''}`;
  if (dryRun) return { ok: true, sessionId, output: `[dry-run] ${shown}  ← adapter not implemented yet` };
  return {
    ok: false,
    sessionId,
    output: '',
    error: 'the opencode adapter is not implemented yet. Implement run() in adapters/opencode.mjs, following the contract in adapters/claude.mjs.',
  };
}
