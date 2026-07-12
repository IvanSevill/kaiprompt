# promptheus

System for **queuing, scheduling and launching prompts** to Claude Code (and opencode in the future), with persistent sessions. Everything lives in this folder (`~/.claude/tools/promptheus/`), no external dependencies (Node only), and it's relocatable.

```
promptheus <engine> <subcommand> [args]
```

| Interface | How | Purpose |
|---|---|---|
| **GUI** | `promptheus` *(no arguments)* | Guided full-screen mode: queue, chats, projects (see §2b) |
| **Terminal (CLI)** | `promptheus <engine> …` | Manage and **launch** the queue (add, list, run, out…) |
| **Claude chat** | `/programar <when> \| <prompt>` | **Schedule** a launch with **0 tokens** (see §4c) |
| **Claude chat** | `/resumen-prompts` | Have Claude **summarize** what the launches did |

Key cost insight:
- **Scheduling = 0 tokens.**
- **Launching = uses your Claude Code subscription** (the 5h/week limits), never the paid API.

---

## 1. Installation

Clone it and run the installer. **No npm, no dependencies** — Node only:

```bash
git clone https://github.com/IvanSevill/promptheus.git
cd promptheus
node install.mjs
```

The installer does the three things that depend on *your* machine:
1. Generates the slash commands `/programar` and `/resumen-prompts` into `~/.claude/commands/`, pointing at wherever you cloned this.
2. Registers the `UserPromptSubmit` hook in `~/.claude/settings.json` — **merged, not overwritten**: your other hooks and settings stay put, and running it twice doesn't duplicate anything.
3. Creates `projects.json`, asking for the folder where you keep your projects (so `--dir myapp` works by name). An existing `projects.json` is never overwritten.

Then it prints the shell shortcut to add to your profile. **Restart Claude Code** so the hook is picked up.

```bash
node install.mjs --base "C:/path/to/your/projects"   # skip the question
node install.mjs --yes                               # no questions at all
node uninstall.mjs                                   # undo 1 and 2; your data stays
```

### The shortcut

The real command is `node promptheus.mjs`. To type just `promptheus`:

**PowerShell** (recommended) — add the function to your profile once:
```powershell
Add-Content $PROFILE 'function promptheus { node "$env:USERPROFILE\.claude\tools\promptheus\promptheus.mjs" @args }'
. $PROFILE
```

**git-bash**:
```bash
alias promptheus='node ~/.claude/tools/promptheus/promptheus.mjs'
```

**cmd**: use the wrapper `promptheus.cmd` (put it in your PATH or call it by full path).

> PowerShell note: don't use `~` in paths for `node` (it won't expand); use `$env:USERPROFILE`.
> If an argument contains `|`, wrap it in quotes (in PowerShell `|` is a pipe).

---

## 2. CLI: `promptheus`

```
promptheus <engine> <subcommand> [args]
```

- **`<engine>`** = `claude` | `opencode` (optional; defaults to `claude`). Defines the adapter used to **launch**. Designed to expand to opencode without changing anything else.

| Subcommand | What it does |
|---|---|
| `add "<prompt>" [--target n] [--at when] [--dir path] [--file path] [--session id]` | Queue a launch |
| `list` or `ls` | View the queue with status |
| `list --full` or `-f` | View the queue with full prompts (not truncated) |
| `show <id>` | View full details of a specific job |
| `run [--once] [--dry-run]` | Process the queue (launch) |
| `out [<id>]` | View the output of a launch (or the latest) |
| `chat <id\|target\|session-id> [--last N] [--full] [--raw]` | Read the whole **conversation** of a launch |
| `edit <id> [--prompt …] [--at …] [--target …] [--dir …] [--perm …] [--adapter …]` | Change a **pending** job |
| `rm <id> [<id>...]` | Remove jobs |
| `clear` | Clear finished/error entries |
| `sessions` | Saved sessions (name → session-id) |
| `sessions set <target> <session-id>` | Manually assign a session-id to a target |
| `projects` | View available folders/projects for --dir |
| `projects <alias> <path>` | Register a folder alias |

### `add` options
- **`--target <name>`** — groups launches in a persistent conversation: the 1st creates the session and subsequent ones **resume** it (`claude --resume`). Saved in `data/sessions.json`. Without `--target`, each launch opens a new single-use session.
- **`--at <when>`** — `HH:MM` (today, or tomorrow if already past), `+30m` / `+2h` / `+1d`, or ISO `2026-07-12T09:00`. **Without `--at`** the launch is *sequential* (executed in order).
- **`--dir <path>`** — folder where the launch executes (defaults to the current folder). Important: see §5.
- **`--file <path>`** — use the content of a file as the prompt.
- **`--session <id>`** — run the prompt in an existing Claude Code session (by session ID), using `claude --resume <id>`.
- **`--perm <mode>`** — permission mode for the unattended launch. **Default: `bypass`** (full autonomy). See §4b.

### `run`
Processes in this order: **due scheduled → sequential**. Then **waits** for future scheduled jobs and launches them at their time. With `--once` it only processes what's pending now and exits (no waiting). With `--dry-run` it shows what it would do without executing anything. Each launch output is saved in `out/<id>.txt`.

While waiting for future jobs, `run` shows a live-updating status bar with progress percentage and remaining time.

> `run` (without `--once`) is a **live** process: it must keep running to trigger scheduled launches. Leave it in a terminal, or schedule it with Windows Task Scheduler.

### `chat`
`out` gives you the **final answer** of a launch. `chat` gives you the **whole conversation**: what you asked, what Claude replied and every tool it used along the way.

```powershell
promptheus chat fixes              # by target (its session, from data/sessions.json)
promptheus chat jlzz4t3h6          # by job id
promptheus chat ff679ec5-531d-…    # by session-id
```

It reads the session transcript that Claude Code itself writes
(`~/.claude/projects/<encoded-folder>/<session-id>.jsonl`), so it works for **any** session, not just the ones launched from here.

- **`--last N`** — how many turns to show (default: `20`, the tail of the conversation).
- **`--full`** — everything, untruncated: also the *thinking* and the tool results.
- **`--raw`** — the transcript lines as they are on disk (JSONL), for piping into other tools.

Tool calls are summarized to one line (`Read(app/main.py)`, `Bash(npm test)`). The footer gives you the `claude --resume` command, with the right folder already filled in (see §3).

### `edit`
Change a launch **before it runs**:

```powershell
promptheus edit jlzz4t3h6 --at "tomorrow 09:00" --perm acceptEdits
promptheus edit jlzz4t3h6 --prompt "review the PR and summarize" --dir myapp
promptheus edit jlzz4t3h6 --target none        # none/- clears --target, --dir or --at
```

Same flags as `add` (`--prompt`, `--at`, `--target`, `--dir`, `--perm`, `--adapter`), same rules (`--at` accepts `HH:MM`, `+2h`, ISO…; `--dir` accepts a project name or an alias). It prints the resulting job.

Only **pending** jobs can be edited — a `running` one is already in the adapter's hands, and a `done` one is history (use `out`/`chat` to read it). Launches scheduled from the chat with `/programar` can be edited too: `edit` imports them first.

### Examples
```powershell
promptheus claude add "/test" --target fixes
promptheus claude add "fix whatever fails and re-run tests" --target fixes
promptheus claude run --once           # launches both, in order, same conversation

promptheus claude add "review the PR and summarize" --target review --at 09:00
promptheus claude run                  # waits until 09:00 and launches

promptheus claude add "implement feature X" --session abc123  # uses existing session

promptheus list
promptheus show jlzz4t3h6
promptheus list --full
promptheus out                        # output of the latest launch
promptheus chat fixes --last 40       # the whole conversation of the "fixes" target
promptheus edit jlzz4t3h6 --at +1h    # postpone a pending launch
```

---

## 2b. The GUI (`promptheus` with no arguments)

Running `promptheus` with no arguments opens a **guided full-screen mode** — the same queue, without memorizing flags:

```powershell
promptheus          # or: promptheus gui
```

Four views, switched with `←` `→`, `tab` or `1`-`4`:

| View | What's in it |
|---|---|
| **Queue** | every job with its status; `enter` shows one in full |
| **Chats** | saved sessions (target → session-id); `enter` opens the conversation |
| **Projects** | the base folder and the registered aliases |
| **Help** | the keys |

| Key | What it does |
|---|---|
| `↑` `↓` | move through the list |
| `enter` | detail of the selected job |
| `a` | **add** a launch, guided: prompt → when → target → folder → permissions |
| `e` | **edit** a pending job (same wizard, prefilled) |
| `d` | **delete** a job (asks first) |
| `r` | **run** the queue — hands the screen to the countdown clock and the live view |
| `o` | **output** of a launch |
| `c` | the whole **conversation** of a launch |
| `?` | help · `q` quit |

The wizard checks as you type: an empty prompt or a time it can't parse (`"a las tantas"`) is caught **there**, while you can still retype it — not at 3am when the launch fires. Permissions are picked from a list (`bypass` · `acceptEdits` · `default`), so you can't invent a mode that doesn't exist.

> **Without a terminal there is no GUI.** If stdout/stdin aren't a TTY (Task Scheduler, a pipe, a background `run`), `promptheus` prints this help instead. A raw-mode GUI in an unattended batch would hang forever waiting for a key nobody is going to press.

---

## 3. How sessions and folders work (important)

Claude Code sessions are **per-folder/project**: they're saved in `~/.claude/projects/<encoded-folder>/<session-id>.jsonl`. That's why:

- Each launch executes in the **folder from which you programmed it** (the hook captures your `cwd`; in the CLI use `--dir` or the current folder). This way `/test` and other commands run in the **correct repo**.
- To **resume** a launch conversation you must be in that same folder:
  ```
  cd <launch-folder>
  claude --resume <session-id>
  ```
  `promptheus out` gives you this command already set up (with the correct `cd`).

> If you try `claude --resume <id>` from a different folder, it will error with "not found": this is why, not a credentials issue.

---

## 4. Authentication: always subscription, never paid API

The `claude` adapter launches the **`claude` (Claude Code)** binary, with your login/subscription. As a safeguard, it strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the process environment before launching, so **even if you define an API key, launches still use your subscription**. Launching consumes your Claude Code quota (5h/week limits), not API money.

---

## 4b. Permissions / autonomy (IMPORTANT)

An unattended launch that asks for permission **stalls forever** — nobody is there at 3am to
answer. That's why the adapter passes a permission mode to `claude -p`:

| Mode | Flag passed | What the launch can do |
|---|---|---|
| **`bypass`** *(default)* | `--dangerously-skip-permissions` | **Everything, no prompts**: edit files, run Bash, install packages |
| `acceptEdits` | `--permission-mode acceptEdits` | Auto-accepts **file edits** only; Bash still prompts (will stall) |
| `default` | `--permission-mode default` | Prompts for everything (only useful if you're watching) |

Override per launch: `promptheus claude add "..." --perm acceptEdits`.

> ⚠️ `bypass` is the default **by explicit choice**: it gives scheduled launches full autonomy in
> the target folder (they can create, modify and delete files and run any command without asking).
> That's what makes unattended work actually happen — but only point launches at folders you're
> comfortable letting an agent change. Lower it with `--perm acceptEdits` when in doubt.

---

## 4c. Scheduling from the Claude chat (0 tokens)

Besides the CLI, you can schedule launches from inside Claude Code:

```
/programar <when> | <prompt> [| <target>] [| <folder>]
```
- `<when>`: `09:00` · `mañana 09:00` · `+2h` · `lun 09:00` · `2026-07-12 09:00`
- `<folder>` *(optional)*: **project name** (e.g. `myapp`, `my-api` — any subfolder of the
  `_base` in `projects.json`), an alias, or a full path. Defaults to the folder you're in.

Example: `/programar mañana 08:30 | review the PR and summarize | review | myapp`

A `UserPromptSubmit` hook (registered in `~/.claude/settings.json`, running `programar.mjs`)
intercepts it, appends a line to `programados.jsonl` and **blocks the turn with `exit 2`** → the
model never runs → **0 tokens**. `promptheus run`/`list` then import those lines into the queue.

To review the results afterwards, use **`/resumen-prompts`** in the chat (Claude reads `out/` and
summarizes each launch), or `promptheus out` from the terminal.

---

## 5. Unattended execution (e.g. at 3am)

`run` only triggers if it's **alive** at the right time. Options:
- **Simple:** leave a terminal with `promptheus claude run` open and the PC not sleeping.
- **Robust:** a **Windows Task Scheduler** task that at the desired time runs:
  ```powershell
  node "$env:USERPROFILE\.claude\tools\promptheus\promptheus.mjs" claude run --once
  ```
  With permission to *wake the computer*.

---

## 6. File Structure

```
promptheus.mjs         CLI: argument parsing + dispatch (no args → the GUI)
programar.mjs              the /programar hook (writes programados.jsonl, 0 tokens)
install.mjs / uninstall.mjs  wire this clone into Claude Code (commands + hook + projects.json)
promptheus.cmd         Windows wrapper (cmd/PowerShell)
lib/
  store.mjs                data layer: queue · sessions · projects · /programar inbox
  time.mjs                 parseWhen, formatting, durations
  ui.mjs                   ANSI primitives: palette, boxes, big digits, wrapping
  queue.mjs                job operations shared by the CLI and the GUI (add/rm/clear/details)
  runner.mjs               execution loop + countdown clock + live view
  chat.mjs                 find and render session transcripts
  edit.mjs                 edit a pending job
  tui.mjs                  the guided GUI (state machine + renderer)
  install.mjs              slash commands · the settings.json hook · projects.json
adapters/
  claude.mjs               launches `claude -p` (subscription; runs in the job's folder)
  opencode.mjs             stub — implement when needed
  mock.mjs                 test adapter (no tokens spent)
test/                      node --test suite (no dependencies)
data/
  queue.json               the work queue
  sessions.json            target → session-id
  projects.json            alias/base folder registry
out/<id>.txt               output of each launch
```

Run the tests with `npm test` (or `node --test test/*.test.mjs`).

---

## 7. Porting to opencode

The queue, sessions and `<engine>` are already neutral. To support opencode, just implement `adapters/opencode.mjs` respecting the contract:
```js
run({ prompt, sessionId, dryRun, dir }) -> { ok, sessionId, output, error }
```
Nothing else changes: same commands (`promptheus opencode …`), same queue, same output saving.

---

## 8. Common Issues

- **PowerShell fails with `~`** → use `$env:USERPROFILE`, not `~` (node doesn't expand it).
- **`claude --resume` "not found"** → you're in the wrong folder; see §3 (`cd` to the launch folder).
- **At the scheduled time nothing runs** → `run` wasn't active at that time (§5).
- **Queue not processing** → make sure `promptheus claude run` is running (with or without `--once`).
