import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLiveEvent } from '../lib/run-tui.mjs';

test('live classifier keeps edit detail behind diff and TodoWrite as current state', () => {
  const edit = classifyLiveEvent({
    type: 'assistant', message: { content: [{
      type: 'tool_use', name: 'Edit', input: { file_path: 'a.mjs', old_string: 'before', new_string: 'after' },
    }] },
  });
  assert.equal(typeof edit.lines[0], 'string');
  assert.equal(edit.lines[1].diff, true);
  assert.match(edit.lines[1].lines.join('\n'), /before/);

  const todo = classifyLiveEvent({
    type: 'assistant', message: { content: [{
      type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'finish', status: 'pending' }] },
    }] },
  });
  assert.equal(todo.todos[0].content, 'finish');
  assert.equal(todo.lines.length, 1, 'the task list belongs in the panel, not repeated in the feed');
});
