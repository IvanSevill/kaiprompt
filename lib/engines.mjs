// Engine metadata and selection validation live here so every front-end applies the same rules.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENGINES = Object.freeze({
  claude: { id: 'claude', requiresProvider: false, requiresModel: false },
  codex: { id: 'codex', requiresProvider: false, requiresModel: false },
  opencode: { id: 'opencode', requiresProvider: true, requiresModel: true },
  mock: { id: 'mock', requiresProvider: false, requiresModel: false, internal: true },
});

export const engineNames = ({ includeInternal = false } = {}) => Object.values(ENGINES).filter((e) => includeInternal || !e.internal).map((e) => e.id);

export const claudeModels = () => ['sonnet', 'opus', 'fable', 'haiku'];

/** Codex maintains the account-specific model list locally after login. */
export function discoverCodexModels(file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json')) {
  try {
    const models = JSON.parse(fs.readFileSync(file, 'utf8')).models ?? [];
    return models
      .filter((model) => model.visibility !== 'hide' && model.slug)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((model) => model.slug);
  } catch { return []; }
}

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

function command(bin, args, run) {
  const r = run ? run(bin, args) : spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  if (r?.error || r?.status !== 0) return null;
  return String(r.stdout || '');
}

/** Models are owned by OpenCode and can change without a Kaiprompt release. */
const discovered = new Map();
export function discoverOpenCodeModels(provider = null, { run } = {}) {
  const key = provider?.toLowerCase() || '*';
  if (!run && discovered.has(key)) return discovered.get(key);
  const out = command(process.platform === 'win32' ? 'opencode.cmd' : 'opencode', ['models', ...(provider ? [provider] : [])], run);
  if (out == null) return [];
  const clean = out.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '');
  const models = [...new Set(clean.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[\w.-]+\/[\w.-]+$/.test(line)))].map((id) => {
    const [p, ...rest] = id.split('/');
    return { id, provider: p, model: rest.join('/') };
  });
  if (!run) discovered.set(key, models);
  return models;
}
