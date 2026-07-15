const TOOL_NAMES = {
  read: 'Read', edit: 'Edit', write: 'Write', multiedit: 'MultiEdit',
  bash: 'Bash', glob: 'Glob', grep: 'Grep', task: 'Task', todowrite: 'TodoWrite',
};

const normalizedType = (value) => String(value ?? '').toLowerCase().replace(/-/g, '_');
const toolKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');

export function normalizeOpenCodeInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  input.file_path ??= input.filePath ?? input.path ?? input.filename;
  input.old_string ??= input.oldString ?? input.oldText ?? input.old;
  input.new_string ??= input.newString ?? input.newText ?? input.new;
  return input;
}

export function normalizeOpenCodePart(value, { output = true } = {}) {
  if (typeof value === 'string') return value.trim() ? [{ type: 'text', text: value }] : [];
  const part = value?.part ?? value;
  if (!part || typeof part !== 'object') return [];
  const type = normalizedType(part.type ?? value?.type);

  if (type === 'text') {
    const text = part.text ?? value?.text;
    return typeof text === 'string' && text ? [{ type: 'text', text }] : [];
  }
  if (type === 'reasoning' || type === 'thinking') {
    const thinking = part.text ?? part.reasoning ?? part.thinking ?? value?.text ?? value?.reasoning ?? value?.thinking;
    return typeof thinking === 'string' && thinking ? [{ type: 'thinking', thinking }] : [];
  }
  if (type !== 'tool' && type !== 'tool_use') return [];

  const rawName = part.tool ?? part.name ?? part.toolName;
  if (!rawName) return [];
  const source = part.state?.input ?? part.input ?? part.arguments;
  const blocks = [{
    type: 'tool_use',
    name: TOOL_NAMES[toolKey(rawName)] ?? String(rawName),
    input: normalizeOpenCodeInput(source),
  }];
  const result = part.state?.output ?? part.output ?? part.state?.result;
  if (output && result != null) blocks.push({
    type: 'tool_result',
    content: typeof result === 'string' ? result : JSON.stringify(result),
  });
  return blocks;
}

export function normalizeOpenCodeContent(content, options) {
  const parts = typeof content === 'string' ? [content] : (Array.isArray(content) ? content : []);
  return parts.flatMap((part) => normalizeOpenCodePart(part, options));
}
