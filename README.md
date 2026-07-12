# promptheus

**Prompts that send themselves, on time.**

Queue prompts for Claude Code, schedule them, and let them run while you sleep. Wake up to
the work done.

*Prometheus* literally means **"forethought"** — the one who thinks ahead. That is the whole
tool: you write down **what** you want done and **when**, and it launches Claude Code on its
own, with nobody at the keyboard.

Zero dependencies. Just Node.

```
promptheus add "run the tests and fix whatever breaks" --at 03:00 --dir myapp
```

---

## The one thing to understand: scheduling is not launching

This trips everyone up, so it is worth stating plainly:

| | |
|---|---|
| A job **with** a time (`--at`) | is **scheduled**: the daemon fires it at that time. Nothing needs to be open. |
| A job **without** a time | is **sequential**: it sits in the queue until *you* run it (`run`, or `r` in the GUI). |

**Adding a job never launches it.** Not from the GUI, not from `add`, not from `/programar`.

For a scheduled job to actually fire, something has to be processing the queue at that
moment: either the **daemon** (`promptheus daemon start`) or a `run` you left up. The GUI
tells you at a glance whether the daemon is armed — if it says `◇ daemon off`, nothing will
fire.

---

## Install

```bash
git clone https://github.com/IvanSevill/promptheus.git
cd promptheus
node install.mjs
```

The installer registers the `/programar` hook in `~/.claude/settings.json`, writes the slash
commands, and prints the shell alias to add. `node uninstall.mjs` reverses all of it.

**Shell alias** — PowerShell (`notepad $PROFILE`):

```powershell
function promptheus { node "$env:USERPROFILE\.claude\tools\promptheus\promptheus.mjs" @args }
```

bash / zsh:

```bash
alias promptheus='node "$HOME/.claude/tools/promptheus/promptheus.mjs"'
```

---

## Three ways to use it

### 1. From a Claude chat, for free: `/programar`

```
/programar <when> | <what> | [conversation] | [folder]
/programar +2h | run the tests and fix what breaks | tests | myapp
```

A `UserPromptSubmit` hook intercepts the message, queues it, and **kills the turn (exit 2)**.
The model is never called, so this costs **0 tokens**. That matters: it means you can queue
work *even when you are almost out of quota* — which is exactly when you most want to.

### 2. From the terminal

```bash
promptheus add "<prompt>" --at 03:00 --target fixes --dir myapp
promptheus list                    # the queue, with status
promptheus run                     # process it: full-screen countdown + live view
promptheus run --watch             # ...and stay up, so you can keep feeding it
promptheus out <id>                # the answer a launch gave
promptheus show <id>               # the job AND the whole conversation it had
promptheus chat <target>           # the conversation, by name
promptheus edit <id> --at +1h      # change a pending job
promptheus daemon start            # fire scheduled jobs with no terminal open
```

### 3. The guided GUI

`promptheus` with no arguments.

Views: **Queue · Chats · Projects · Help**.
Keys: `↑↓` move · `a` add (guided) · `e` edit · `d` delete · `x` clear finished ·
`r` run now · `D` daemon on/off · `o` output · `c` conversation · `R` redraw · `q` quit.

The add wizard **suggests the conversations and folders you already have** — continuing one
is the single biggest token saving available (see below).

---

## Concepts

### `--target` — persistent conversations (this is where the savings are)

Jobs sharing a `--target` **continue the same conversation**: the first creates the session,
the rest resume it (`claude --resume`). The context is already loaded, so the launch does not
pay to re-read your project from scratch.

Splitting a big task into several chained jobs on one target is much cheaper than one giant
job — and much more likely to finish.

Without a target, every launch starts cold.

### `--dir` — which project it runs in

Claude Code sessions are **per folder**. `--dir` takes a project name (a subfolder of your
configured base), an alias, or a path. Defaults to the current folder.

### `--perm` — permissions for an unattended launch

Default is **bypass**: full autonomy (edits, Bash, installs) with no prompts. It has to be
that way. If a launch stops to ask permission at 3am, there is nobody to grant it and the job
just hangs, having done nothing. `--perm acceptEdits` restricts it to edits only.

### Subscription, never the paid API

The adapter strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child's
environment. Launches always go through your Claude Code subscription.

---

## Running out of quota does not kill the job

This is the feature that exists because it once went badly.

When Claude runs out of session quota mid-launch it prints
`You've hit your session limit · resets 1:30pm` and **exits 1** — which, to anything watching
the exit code, is indistinguishable from a crash. An overnight batch got marked `error` that
way and the work was simply lost.

Now it is recognised for what it is: an **interruption, not a failure**.

- The job goes **back into the queue** — as `pending`, not `error`.
- Its scheduled time is **left alone**. That is what preserves the order: it is still the
  earliest job due, so when quota returns it goes **first** again, and everything behind it
  stays behind it.
- The runner sleeps until the reset and carries on. Same job, same conversation, same place.

Both windows are covered — the 5-hour session **and** the 7-day weekly limit — and the wait is
computed from whichever comes back first.

---

## Feeding a run that is already going

```bash
promptheus run --watch
```

`--watch` keeps the runner up even when the queue empties.

That means you can leave a runner going and queue work into it later — from another terminal,
or from a Claude chat with `/programar` (which costs nothing). Anything you add is picked up
on its own, including a job scheduled for *sooner* than the one it is currently counting down
to.

The pattern this exists for: you are about to run out of tokens, so you queue the rest of the
work and walk away.

---

## Parallel launches

```bash
promptheus run --parallel 3
```

Two prompts aimed at different conversations have no reason to wait for each other.

The rule that makes it safe: **a target is a lane**. Two jobs on the same target share one
conversation, and resuming a session twice at once would corrupt it — so a lane runs one job
at a time, while different lanes run at once.

---

## The daemon

```bash
promptheus daemon start      # detached background runner
promptheus daemon status
promptheus daemon log --last 50
promptheus daemon install    # bring it back on login (Windows)
promptheus daemon stop
```

The daemon only takes **scheduled** jobs. Sequential ones still wait for an explicit run —
otherwise adding a job would fire it seconds later, which is precisely the surprise this tool
avoids.

---

## Servers and CI

```bash
promptheus run --plain        # no full-screen TUI, just a log
```

The plain path is also what runs under a pipe, a scheduled task, or with no TTY at all — so
logs stay readable and nothing tries to paint a full-screen interface into them.

---

## Reviewing what happened

```bash
promptheus list              # status of everything
promptheus show <id>         # the job and the full conversation it had
promptheus out <id>          # just the final answer
promptheus chat <target>     # a conversation by name  [--last N] [--full] [--raw]
```

From a Claude chat, `/promptheus-summary` reads the queue and the outputs, tells you what
each launch actually did, flags anything **cut short by quota**, and offers to reschedule the
unfinished work with a *continuation* prompt rather than the original one.

---

## Layout

```
promptheus.mjs      CLI dispatch
programar.mjs       the /programar hook (0 tokens)
install.mjs         hook + slash commands + alias
lib/
  store.mjs         queue · sessions · projects
  queue.mjs         add/remove/clear, and the suggestions
  runner.mjs        the run loop, the clock, the live view, parallel
  quota.mjs         out-of-quota detection, and when it comes back
  daemon.mjs        the detached background runner
  chat.mjs          reading session transcripts
  tui.mjs           the guided GUI
  ui.mjs            ANSI primitives
adapters/
  claude.mjs        Claude Code (streams events for the live view)
  opencode.mjs      stub
  mock.mjs          for tests — costs nothing
```

Your data lives outside the repo and is gitignored: `data/`, `out/`, `projects.json`,
`programados.jsonl`. Set `PROMPTHEUS_HOME` to keep it somewhere else.

---

## Tests

```bash
node --test test/*.test.mjs      # 257 tests, no dependencies
```

The `mock` adapter makes the whole run loop testable without spending a single token.

---

## License

MIT
