import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kaip-diff-'));
process.env.KAIP_HOME = TMP;

const {
  MAX_DIFF_BYTES, MAX_DIFF_LINES, diffText, normalizeNativeDiffs, normalizeToolDiffs,
} = await import('../src/events/tool-normalize.mjs');
const { liveEvents, recordAdapterEvent } = await import('../src/events/live.mjs');

test('canonical Edit accepts snake/camel aliases and retains literal signs', () => {
  const [camel] = normalizeToolDiffs('edit', {
    filePath: 'lib/a.mjs', oldString: 'old\nline', newString: 'new\nline',
  });
  const [diff] = normalizeToolDiffs('Edit', {
    file_path: 'lib/a.mjs', old_string: 'old\nline', new_string: 'new\nline',
  });
  assert.deepEqual(diff.lines, ['-old', '-line', '+new', '+line']);
  assert.equal(diff.added, 2); assert.equal(diff.removed, 2);
  assert.equal(diff.id, camel.id);
  assert.match(diff.id, /^diff-[a-f0-9]{24}$/);
});

test('Write and MultiEdit use the same canonical contract', () => {
  const [write] = normalizeToolDiffs('Write', { path: 'new.txt', content: 'one\ntwo' });
  const multi = normalizeToolDiffs('MultiEdit', {
    filePath: 'a.kt', edits: [
      { oldText: 'a', newText: 'b' },
      { old_string: 'c', new_string: 'd' },
    ],
  });
  assert.deepEqual(write.lines, ['+one', '+two']);
  assert.deepEqual(multi.map((diff) => diff.lines), [['-a', '+b'], ['-c', '+d']]);
  assert.ok(multi.every((diff) => diff.file === 'a.kt'));
});

test('apply-patch and unified patch shapes split files and preserve hunks', () => {
  const apply = normalizeToolDiffs('apply_patch', { patchText: [
    '*** Begin Patch', '*** Update File: a.js', '@@', '-before', '+after',
    '*** Add File: b.js', '+created', '*** End Patch',
  ].join('\n') });
  assert.deepEqual(apply.map((diff) => [diff.file, diff.added, diff.removed]), [
    ['a.js', 1, 1], ['b.js', 1, 0],
  ]);
  assert.deepEqual(apply[0].lines, ['@@', '-before', '+after']);

  const [unified] = normalizeToolDiffs('Patch', {
    unified_diff: '--- a/src/x.js\n+++ b/src/x.js\n@@ -1 +1 @@\n-old\n+new',
  });
  assert.equal(unified.file, 'src/x.js');
  assert.equal(diffText(unified), '@@ -1 +1 @@\n-old\n+new');
});

test('shell commands are never fabricated into structured diffs', () => {
  const command = "apply_patch <<'PATCH'\n*** Update File: fake.js\n-old\n+new\nPATCH";
  assert.deepEqual(normalizeToolDiffs('Bash', { command }), []);
  assert.deepEqual(normalizeNativeDiffs({ type: 'command', command }), []);
});

test('native provider records require explicit patch data', () => {
  const [diff] = normalizeNativeDiffs({
    type: 'item.completed', item: { type: 'file_change', path: 'native.rs', patch: '--- a/native.rs\n+++ b/native.rs\n-old\n+new' },
  });
  assert.equal(diff.file, 'native.rs');
  assert.deepEqual(diff.lines, ['-old', '+new']);
  assert.deepEqual(normalizeNativeDiffs({ item: { type: 'file_change', path: 'unknown.rs' } }), []);
});

test('line and byte truncation is deterministic, bounded and keeps useful head/tail', () => {
  const content = Array.from({ length: MAX_DIFF_LINES + 100 }, (_, index) => `${index}:${'x'.repeat(400)}`).join('\n');
  const [first] = normalizeToolDiffs('Write', { file_path: 'large.txt', content });
  const [second] = normalizeToolDiffs('Write', { file_path: 'large.txt', content });
  assert.equal(first.id, second.id);
  assert.equal(first.truncated, true);
  assert.match(first.truncationReason, /limit/);
  assert.ok(first.lines.length <= MAX_DIFF_LINES);
  assert.ok(Buffer.byteLength(first.lines.join('\n')) <= MAX_DIFF_BYTES);
  assert.equal(first.lines[0].startsWith('+0:'), true);
  assert.equal(first.lines.at(-1).startsWith(`+${MAX_DIFF_LINES + 99}:`), true);
});

test('recordAdapterEvent preserves the tool and emits a separate durable diff', () => {
  const job = { id: 'live-diff', attemptId: 'attempt', adapter: 'claude' };
  const records = recordAdapterEvent(job, {
    type: 'assistant', message: { content: [{
      type: 'tool_use', name: 'Edit', input: {
        file_path: 'app.kt', old_string: 'before', new_string: 'after',
      },
    }] },
  });
  assert.deepEqual(records.map((event) => event.kind), ['tool', 'diff']);
  assert.equal(records[0].input.old_string, 'before');
  assert.deepEqual(records[1].diff.lines, ['-before', '+after']);
  assert.deepEqual(liveEvents(job.id).map((event) => event.id), records.map((event) => event.id));
});
