import { createHash } from 'node:crypto';

export const MAX_DIFF_LINES = 240;
export const MAX_DIFF_BYTES = 48 * 1024;

const TOOL_KEYS = new Set(['edit', 'write', 'multiedit', 'patch', 'applypatch']);
const PATCH_KEYS = ['patch', 'patchText', 'patch_text', 'unifiedDiff', 'unified_diff', 'diff'];
const TOOL_INPUT_KEYS = [
  'file_path', 'filePath', 'path', 'filename', 'command', 'pattern', 'url', 'query',
  'old_string', 'oldString', 'old_text', 'oldText', 'old',
  'new_string', 'newString', 'new_text', 'newText', 'new', 'content', 'edits', 'changes',
  'patch', 'patchText', 'patch_text', 'unifiedDiff', 'unified_diff',
];
const first = (value, keys) => keys.map((key) => value?.[key]).find((item) => item != null);
const toolKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
const textLines = (value) => typeof value === 'string' && value.length ? value.split(/\r?\n/) : [];
const utf8 = (value) => Buffer.byteLength(value, 'utf8');

export function normalizeToolInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  input.file_path ??= input.filePath ?? input.path ?? input.filename;
  input.old_string ??= input.oldString ?? input.oldText ?? input.old;
  input.new_string ??= input.newString ?? input.newText ?? input.new;
  return input;
}

function boundedValue(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, depth ? 400 : 1200);
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => boundedValue(item, depth + 1));
  if (!value || typeof value !== 'object' || depth >= 3) return value;
  return Object.fromEntries(Object.entries(value).slice(0, 24)
    .map(([key, item]) => [key, boundedValue(item, depth + 1)]));
}

export function compactToolInput(input) {
  return Object.fromEntries(TOOL_INPUT_KEYS.filter((key) => input[key] != null)
    .map((key) => [key, boundedValue(input[key])]));
}

function stableId(file, lines) {
  return `diff-${createHash('sha256').update(JSON.stringify([file, lines])).digest('hex').slice(0, 24)}`;
}

function bounded(lines) {
  let reason = null;
  let kept = [...lines];
  if (kept.length > MAX_DIFF_LINES) {
    const head = Math.ceil((MAX_DIFF_LINES - 1) / 2);
    const tail = MAX_DIFF_LINES - head - 1;
    kept = [...kept.slice(0, head), '... [diff truncated]', ...kept.slice(-tail)];
    reason = 'line-limit';
  }
  if (utf8(kept.join('\n')) > MAX_DIFF_BYTES) {
    const marker = '... [diff truncated]';
    const source = kept.filter((line) => line !== marker);
    const head = [];
    const tail = [];
    let bytes = utf8(marker);
    let left = 0;
    let right = source.length - 1;
    while (left <= right) {
      const takeHead = head.length <= tail.length;
      const line = takeHead ? source[left] : source[right];
      const cost = utf8(line) + 1;
      if (bytes + cost > MAX_DIFF_BYTES) break;
      if (takeHead) { head.push(line); left++; } else { tail.unshift(line); right--; }
      bytes += cost;
    }
    kept = [...head, marker, ...tail];
    reason = reason ? `${reason}+byte-limit` : 'byte-limit';
  }
  return { lines: kept, truncated: reason != null, truncationReason: reason };
}

function canonical(file, lines) {
  if (!file || !lines.length) return null;
  const original = lines.map(String);
  const limited = bounded(original);
  return {
    id: stableId(String(file), original),
    file: String(file),
    lines: limited.lines,
    added: original.filter((line) => line.startsWith('+')).length,
    removed: original.filter((line) => line.startsWith('-')).length,
    truncated: limited.truncated,
    truncationReason: limited.truncationReason,
  };
}

function editDiff(input, fallbackFile) {
  const file = first(input, ['file_path', 'filePath', 'path', 'filename']) ?? fallbackFile;
  const oldText = first(input, ['old_string', 'oldString', 'old_text', 'oldText', 'old']);
  const newText = first(input, ['new_string', 'newString', 'new_text', 'newText', 'new']);
  const lines = [
    ...textLines(oldText).map((line) => `-${line}`),
    ...textLines(newText).map((line) => `+${line}`),
  ];
  return canonical(file, lines);
}

function writeDiff(input, fallbackFile) {
  const file = first(input, ['file_path', 'filePath', 'path', 'filename']) ?? fallbackFile;
  const content = first(input, ['content', 'new_string', 'newString', 'new_text', 'newText']);
  return canonical(file, textLines(content).map((line) => `+${line}`));
}

function patchFile(header) {
  return String(header ?? '').trim().replace(/^(?:a|b)\//, '').replace(/^"|"$/g, '');
}

/** Parse apply_patch envelopes and ordinary unified patches, never arbitrary command text. */
function patchDiffs(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const rows = text.split(/\r?\n/);
  const out = [];
  let file = null;
  let lines = [];
  let envelope = false;
  const flush = () => {
    const diff = canonical(file, lines);
    if (diff) out.push(diff);
    lines = [];
  };
  for (const row of rows) {
    const marker = row.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/);
    if (marker) {
      flush(); file = marker[1].trim(); envelope = true; continue;
    }
    const rename = row.match(/^\*\*\* Move to:\s*(.+)$/);
    if (rename) { file = rename[1].trim(); continue; }
    if (row.startsWith('diff --git ')) {
      flush();
      const match = row.match(/^diff --git\s+(?:"?a\/.*?"?)\s+(?:"?b\/(.+?)"?)$/);
      file = match?.[1] ?? null; envelope = false; continue;
    }
    if (row.startsWith('+++ ')) {
      const candidate = patchFile(row.slice(4).split('\t')[0]);
      if (candidate !== '/dev/null') file = candidate;
      continue;
    }
    if (row.startsWith('--- ')) {
      if (!file) {
        const candidate = patchFile(row.slice(4).split('\t')[0]);
        if (candidate !== '/dev/null') file = candidate;
      }
      continue;
    }
    if (!file || row === '*** Begin Patch' || row === '*** End Patch' || row === '*** End of File') continue;
    if (row.startsWith('@@')) { lines.push(row); continue; }
    if (row.startsWith('+') || row.startsWith('-') || row.startsWith(' ')) lines.push(row);
    else if (envelope && row.length) lines.push(` ${row}`);
  }
  flush();
  return out;
}

function explicitPatchDiffs(input, fallbackFile) {
  const patch = first(input, PATCH_KEYS);
  if (typeof patch === 'string') {
    const parsed = patchDiffs(patch);
    if (parsed.length || !fallbackFile) return parsed;
    return [canonical(fallbackFile, patch.split(/\r?\n/).filter((line) => /^[+\- @]/.test(line)))].filter(Boolean);
  }
  const changes = first(input, ['changes', 'fileChanges', 'file_changes']);
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change) => {
    if (!change || typeof change !== 'object') return [];
    const file = first(change, ['file', 'path', 'file_path', 'filePath']) ?? fallbackFile;
    const nested = explicitPatchDiffs(change, file);
    if (nested.length) return nested;
    const lines = Array.isArray(change.lines) ? change.lines.map(String) : [];
    return [canonical(file, lines)].filter(Boolean);
  });
}

/** Canonical provider-neutral normalization for a named structured tool invocation. */
export function normalizeToolDiffs(name, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const key = toolKey(name);
  if (!TOOL_KEYS.has(key)) return [];
  if (key === 'edit') return [editDiff(input)].filter(Boolean);
  if (key === 'write') return [writeDiff(input)].filter(Boolean);
  if (key === 'multiedit') {
    const file = first(input, ['file_path', 'filePath', 'path', 'filename']);
    const edits = first(input, ['edits', 'changes']);
    return Array.isArray(edits) ? edits.map((edit) => editDiff(edit, file)).filter(Boolean) : [];
  }
  return explicitPatchDiffs(input);
}

/** Accept native provider records only when they expose explicit structured patch data. */
export function normalizeNativeDiffs(event) {
  if (!event || typeof event !== 'object') return [];
  const item = event.item ?? event.part ?? event;
  if (!item || typeof item !== 'object') return [];
  const file = first(item, ['file', 'path', 'file_path', 'filePath']);
  return explicitPatchDiffs(item, file);
}

export function diffText(diff) {
  return (diff?.lines ?? []).join('\n');
}
