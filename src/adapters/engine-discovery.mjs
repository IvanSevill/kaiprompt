import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseOpenCodeModels } from './model-catalog.mjs';

export const claudeModels = () => ['sonnet', 'opus', 'fable', 'haiku'];

export function discoverCodexModels(file = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json',
)) {
  try {
    const models = JSON.parse(fs.readFileSync(file, 'utf8')).models ?? [];
    return models
      .filter((model) => model.visibility !== 'hide' && model.slug)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((model) => model.slug);
  } catch { return []; }
}

function command(bin, args, run) {
  const result = run ? run(bin, args) : spawnSync(bin, args, {
    encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32',
  });
  if (result?.error || result?.status !== 0) return null;
  return String(result.stdout || '');
}

const discovered = new Map();
export function discoverOpenCodeModels(provider = null, { run } = {}) {
  const key = provider?.toLowerCase() || '*';
  if (!run && discovered.has(key)) return discovered.get(key);
  const output = command(
    process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
    ['models', ...(provider ? [provider] : [])],
    run,
  );
  if (output == null) return [];
  const models = parseOpenCodeModels(output);
  if (!run) discovered.set(key, models);
  return models;
}
