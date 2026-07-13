// The commands that EXIST. One list, so the docs, the HELP, the GUI, the skills and the
// Android app can all be checked against it instead of against somebody's memory.
//
// Commands have been renamed before (`pair` was absorbed into `serve`), and the old names
// stayed behind in a README, in a HELP, and — the one that actually reached a user — in the
// app's pairing screen, which told people to type a command that no longer existed. Telling
// someone to run something that fails is the same silent lie this tool exists to prevent;
// it just happened to be pointed at ourselves.
//
// test/commands.test.mjs keeps this honest from both ends: it checks this list still matches
// the switch in kaip.mjs, and that nothing anywhere references a command outside it.

/** The optional first token: `kaip claude add …` — an adapter, not a command. */
export const ENGINES = ['claude', 'opencode'];

/** Every case in the dispatch of kaip.mjs, aliases included (ls, project). */
export const COMMANDS = [
  'add', 'list', 'ls', 'show', 'run', 'rm', 'clear', 'out', 'chat', 'edit',
  'projects', 'project', 'sessions', 'daemon', 'app', 'serve', 'mobile', 'gui', 'help',
];

/** Commands that take a subcommand of their own. A ghost hides here just as well. */
export const SUBCOMMANDS = {
  daemon: ['run', 'start', 'stop', 'restart', 'status', 'sweep', 'install', 'uninstall', 'log'],
  app: ['build', 'test'],
  sessions: ['set'],
};

export const isCommand = (word) => COMMANDS.includes(word);
