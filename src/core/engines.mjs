// Pure engine metadata and selection validation shared by every front-end.

export const ENGINES = Object.freeze({
  claude: { id: 'claude', requiresProvider: false, requiresModel: false },
  codex: { id: 'codex', requiresProvider: false, requiresModel: false },
  opencode: { id: 'opencode', requiresProvider: true, requiresModel: true },
  mock: { id: 'mock', requiresProvider: false, requiresModel: false, internal: true },
});

export const engineNames = ({ includeInternal = false } = {}) => Object.values(ENGINES).filter((e) => includeInternal || !e.internal).map((e) => e.id);

export function normalizeSelection({ adapter, engine, provider = null, model = null } = {}, { required = false } = {}) {
  const name = String(engine ?? adapter ?? '').trim();
  if (!name) {
    if (required) throw new Error('choose an engine: --engine claude | codex | opencode');
    return { adapter: null, provider: null, model: model ? String(model).trim() : null };
  }
  if (!ENGINES[name]) throw new Error(`unknown adapter/engine: "${name}". Use: ${engineNames().join(' | ')}`);
  const p = provider == null ? null : String(provider).trim().toLowerCase();
  let m = model == null ? null : String(model).trim();
  if (name === 'opencode') {
    if (!p) throw new Error('OpenCode needs --provider <name>');
    if (!m) throw new Error('OpenCode needs --model <name>');
    const prefix = `${p}/`;
    if (m.startsWith(prefix)) m = m.slice(prefix.length);
    else if (m.includes('/')) throw new Error(`OpenCode model "${m}" does not belong to provider "${p}"`);
  } else if (p) {
    throw new Error(`--provider is only valid for OpenCode (engine is ${name})`);
  }
  return { adapter: name, provider: p, model: m || null };
}

export const qualifiedModel = ({ adapter, provider, model }) =>
  adapter === 'opencode' && provider && model ? `${provider}/${model}` : model || null;
