// Adaptador opencode — PENDIENTE (stub).
//
// Cuando se implemente, el contrato es idéntico al de claude.mjs:
//   run({ prompt, sessionId, dryRun }) -> { ok, sessionId, output, error }
//
// Plan previsto (a confirmar contra la CLI de opencode del momento):
//   nuevo:    opencode run "<prompt>"            → capturar el id de sesión que devuelva
//   reanudar: opencode run --session <id> "<prompt>"  (o el flag equivalente)
// La cola (queue.json) y el store de sesiones (sessions.json) NO cambian:
// solo este archivo. Por eso migrar a opencode no exige rehacer nada más.
export const name = 'opencode';

export async function run({ prompt, sessionId, dryRun }) {
  const shown = `opencode run "${String(prompt).split('\n')[0]}"${sessionId ? ' (--session ' + sessionId + ')' : ''}`;
  if (dryRun) return { ok: true, sessionId, output: `[dry-run] ${shown}  ← adaptador aún no implementado` };
  return {
    ok: false,
    sessionId,
    output: '',
    error: 'adaptador opencode no implementado todavía. Implementa run() en adapters/opencode.mjs siguiendo el contrato de adapters/claude.mjs.',
  };
}
