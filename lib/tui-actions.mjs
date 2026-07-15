export const ACTIONS = Object.freeze([
  { section: 'Navigation', keys: 'left/right / tab / 1-5', aliases: ['left', 'right', 'tab', '1', '2', '3', '4', '5', 'u'], id: 'views', description: 'switch Queue, Chats, Projects, Usage, and Help' },
  { section: 'Navigation', keys: 'up/down', aliases: ['up', 'down'], id: 'move', description: (s) => s.view === 'help' ? 'scroll this help' : s.view === 'usage' ? 'switch usage scope' : 'move the selection' },
  { section: 'Navigation', keys: '?', aliases: ['?'], id: 'help', description: 'open this contextual help' },
  { section: 'Navigation', keys: 'R', aliases: ['R'], id: 'refresh', description: 'refresh local data and reload the OpenCode model catalog' },
  { section: 'Navigation', keys: 'Ctrl+L', aliases: ['ctrl-l'], id: 'repaint', description: 'repaint only; does not reload data' },
  { section: 'Queue', keys: 'a', aliases: ['a'], id: 'add', description: 'add a launch; queues it without sending it' },
  { section: 'Queue', keys: 'space', aliases: ['space'], id: 'select', description: 'select a pending job for a bulk engine change' },
  { section: 'Queue', keys: 'm', aliases: ['m'], id: 'engine', description: 'change engine for selected pending jobs' },
  { section: 'Queue', keys: 'e', aliases: ['e'], id: 'edit', description: 'edit a pending or missed job' },
  { section: 'Queue', keys: 'enter / i', aliases: ['enter', 'i'], id: 'info', description: 'open full scrollable job information' },
  { section: 'Queue', keys: 'd ONE', aliases: ['d'], id: 'delete', description: 'delete only the selected job, after confirmation' },
  { section: 'Queue', keys: 'x ALL', aliases: ['x'], id: 'clear', description: (s) => `delete all finished jobs after confirmation (${s.data.queue.filter((j) => !['pending', 'running'].includes(j.status)).length} now)` },
  { section: 'Queue', keys: 't', aliases: ['t'], id: 'retry', description: 'retry the error job shown in Job Info' },
  { section: 'Running', keys: 'D', aliases: ['D'], id: 'daemon', description: 'turn the background scheduled-job runner on or off' },
  { section: 'Running', keys: 'r', aliases: ['r'], id: 'run', description: 'run the queue now; scheduled jobs do not need this' },
  { section: 'Conversations', keys: 'o', aliases: ['o'], id: 'answer', description: 'show the final answer for a finished job' },
  { section: 'Conversations', keys: 'c', aliases: ['c'], id: 'conversation', description: 'show the complete conversation for a finished job' },
  { section: 'Conversations', keys: 'y', aliases: ['y'], id: 'resume', description: 'open the selected saved session in its engine' },
  { section: 'Updates', keys: 'U', aliases: ['U'], id: 'update', enabled: (s) => Boolean(s.update?.url), description: (s) => s.update ? `open release v${s.update.latest}: ${s.update.url}` : 'open the release page when an update is available' },
  { section: 'Exit', keys: 'q / Ctrl+C', aliases: ['q', 'ctrl-c'], id: 'quit', description: 'quit safely and restore the terminal' },
]);

export const action = (id) => ACTIONS.find((item) => item.id === id);
export const actionDescription = (item, state) => typeof item.description === 'function' ? item.description(state) : item.description;
export const actionEnabled = (item, state) => Boolean(item) && (typeof item.enabled !== 'function' || item.enabled(state));
export const actionMatches = (item, key, state) => {
  const candidate = typeof item === 'string' ? action(item) : item;
  return actionEnabled(candidate, state)
    && (candidate.aliases?.includes(key) || (typeof candidate.matches === 'function' && candidate.matches(key, state)));
};
export const actionKey = (id) => action(id)?.keys.split(' / ')[0] ?? '';
