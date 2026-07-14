# Kaiprompt

**Prompts that send themselves, on time.**

Queue prompts for Claude Code, schedule them, and let them run while you sleep. Wake up to
the work done — and get a notification on your phone the moment it is.

You write down **what** you want done and **when**. It launches Claude Code on its own, with
nobody at the keyboard.

Zero dependencies. Just Node.

```
kaip add "run the tests and fix whatever breaks" --at 03:00 --dir myapp
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
moment: either the **daemon** (`kaip daemon start`) or a `run` you left up. The GUI, the
phone app and the goodbye screen all tell you when the daemon is off — because scheduling
work that nothing will fire is the one silent way this tool can lie to you.

---

## Install

```bash
git clone https://github.com/IvanSevill/kaiprompt.git
cd kaiprompt
node install.mjs
```

The installer registers the `/programar` hook in `~/.claude/settings.json`, writes the slash
commands, and prints the shell alias to add. `node uninstall.mjs` reverses all of it.

**Shell alias** — PowerShell (`notepad $PROFILE`):

```powershell
function kaip { node "$env:USERPROFILE\.claude\tools\kaiprompt\kaip.mjs" @args }
```

bash / zsh:

```bash
alias kaip='node "$HOME/.claude/tools/kaiprompt/kaip.mjs"'
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
kaip add "<prompt>" --at 03:00 --target fixes --dir myapp
kaip add --from ./prompts/refactor.md --at 03:00      # the prompt lives in a file
kaip list                          # the queue, with status
kaip run                           # process it: full-screen countdown + live view
kaip out <id>                      # the final answer
kaip show <id>                     # the job AND the whole conversation it had
kaip chat <target>                 # the conversation, by name
kaip edit <id> --at +1h            # change a pending job
kaip daemon start                  # fire scheduled jobs with no terminal open
kaip serve                         # the API + tunnel + the pairing QR, for the phone
kaip mobile                        # the QR to download the app
```

### 3. The guided GUI

`kaip` with no arguments.

Views: **Queue · Chats · Projects · Help**.

| key | |
|---|---|
| `a` `e` `d` `x` | add · edit · delete · clear finished |
| `r` `D` | run now · daemon on/off |
| `o` | the **answer** — just the last thing Claude said |
| `c` | the **conversation** — every turn it took to get there |
| `y` | **join** it — drops you into a real, interactive Claude Code on that session |
| `R` `q` | redraw · quit |

The add wizard **suggests the conversations and folders you already have** — continuing one
is the single biggest token saving available (see below).

---

## The phone app

<img src="https://img.shields.io/badge/Android-APK-D97757" alt="Android"> **[Download the
APK](https://github.com/IvanSevill/kaiprompt/releases/latest)** · or scan the QR from
`kaip mobile`.

```bash
kaip mobile     # the QR to download the app  (once)
kaip serve      # the API, the tunnel, and the pairing QR
```

`serve` shows the pairing QR itself, and takes it off the screen the moment the phone pairs.
A code that has done its job is not neutral sitting there — it is a secret on your monitor.

The app shows the queue, the full conversation of every launch, the quota — and **notifies
you the moment a launch finishes, with the app closed**.

**No cloud, no Firebase, no account.** The PC opens an outbound Cloudflare tunnel (no ports
forwarded, no router touched) and the phone reaches it over plain HTTPS. That matters
practically: it needs **no VPN on the phone**, so a firewall app like NetGuard keeps its one
VPN slot — and it works from any network, 4G included.

Want no third party at all? **`kaip serve --wifi`** drops the tunnel entirely: the phone
talks to this machine over your own network and nothing leaves the house. The trade is that
it only works while you are on that network.

Lost the phone? **`kaip serve --reset`** mints a new token *and a new key* and drops every
paired device: the lost one is locked out from its very next request. The key goes too, not
just the token — leaving it alive would let that phone still read anything it had already
fetched, which is not what anyone pressing this button expects.

Cloudflare terminates the TLS and could otherwise read everything that passes through. It
cannot: **the payload is sealed end-to-end** with AES-256-GCM, and the key never travels the
tunnel it protects — it is minted on the PC and reaches the phone *inside the pairing QR*,
scanned off your own screen. They carry an envelope they have no key to.

**Notifications** are the PC knocking directly on the phone, which a foreground service
turns into a notification even at 3am with the app closed. A knock that lands nowhere (phone
off, no signal) is caught by a poll every 15 minutes — the webhook is the fast path, not the
only one.

Build it yourself: `kaip app build` (needs the Android SDK). `kaip app test` runs its unit
tests on the JVM, no emulator.

---

## Concepts

### `--target` — persistent conversations (this is where the savings are)

Jobs sharing a `--target` **continue the same conversation**: the first creates the session,
the rest resume it (`claude --resume`). The context is already loaded, so the launch does not
pay to re-read your project from scratch.

Splitting a big task into several chained jobs on one target is much cheaper than one giant
job — and much more likely to finish.

### `--from` — the prompt lives in a file

```bash
kaip add --from ./prompts/refactor-auth.md --at 03:00 --dir myapp
```

The job stores the **path**, and the file is read **at launch**. So you can keep sharpening
the prompt right up to the second it goes out: whatever the file says at 03:00 is what gets
sent. (`--file` does the opposite — it pastes the contents in now, as a snapshot.)

If the file is gone or empty at launch time, **nothing is sent** and the job fails loudly. An
unattended launch runs with full autonomy in a real project; handing it a blank instruction
and letting it improvise is the worst thing this tool could do.

The `/prompt` slash command writes exactly such a file: it interviews you until the idea is
sharp, then hands you the path.

### `--dir` — which project it runs in

Claude Code sessions are **per folder**. `--dir` takes a project name (a subfolder of your
configured base), an alias, or a path.

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

When Claude runs out of quota mid-launch it prints `You've hit your session limit · resets
1:30pm` and **exits 1** — which, to anything watching the exit code, is indistinguishable
from a crash. An overnight batch got marked `error` that way and the work was simply lost.

Now it is recognised for what it is: an **interruption, not a failure**.

- The job goes **back into the queue** — as `pending`, not `error`.
- Its scheduled time is **left alone**. That is what preserves the order: it is still the
  earliest job due, so when quota returns it goes **first** again, and everything behind it
  stays behind it.
- The runner sleeps until the reset and carries on. Same job, same conversation, same place.

Both windows are covered — the 5-hour session **and** the 7-day weekly limit — and the wait is
computed from whichever comes back first.

---

## …and neither does it kill *your* conversations

That rescue only ever covered launches **kaip** made. The chat you were having by hand had
none of it.

You are working. Five minutes of work left. The quota runs out. Now you have to wait four and
a half hours, **remember**, find the right conversation, and type "carry on" — for five minutes
of work you had already finished thinking about.

So kaip reads your transcripts, and when you open the GUI it says so:

```
╭─ a medias ──────────────────────────────────────────────╮
│ Parece que una conversación se quedó a medias.          │
│                                                         │
│ ▸ FacturaSevi · hace 12 min                             │
│     «…falta enchufar el network config»                 │
│                                                         │
│ ¿La termino en cuanto vuelva el cupo?                   │
╰─────────────────────────────────────────────────────────╯
  [enter] sí   ·   [esc] no (no vuelvo a preguntar)
```

Say yes and it is queued as a **continuation** — same session, resumed, with the prompt never
re-sent — and it goes **first**, ahead of everything, the moment there is quota. It is the
cheapest job in the queue: the context is already paid for and the work is already half done.

Say no and **it never asks about that one again**. An alert that keeps coming back is an alert
you learn to dismiss without reading, and then it is worth nothing on the day it matters.

**GUI only.** With no terminal there is nobody to answer a question, so nothing is asked and
nothing changes.

### Which signal, and why that one

Found by reading the 180 transcripts under `~/.claude/projects`, not by guessing — and the
obvious signals are all wrong. Sorted by how each conversation *ends*:

| how it ends | how many | |
|---|---|---|
| assistant text | 60 | finished normally |
| **a `tool_result`** | **45** | the tempting one — and useless |
| an API error that is not quota | 14 | 429s, `/login`, disabled account |
| a user turn nobody answered | 14 | ambiguous |
| **a quota API error** | **6** | ← the signal |

Ending on a tool_result *looks* like being cut off mid-work, and it is the commonest odd
ending there is. That is exactly the problem: every escape key, every closed terminal, every
Ctrl-C lands there too. Offer all 45 and you are offering everything.

The signal is narrower: the last real turn is an `assistant` entry flagged
`isApiErrorMessage`, whose text is a quota message. **The flag** says Claude Code *wrote* it
rather than said it — grepping for "session limit" matches any chat that merely *discusses*
quota, and this repo is full of those. **The text** (the same matcher the launcher already
trusts) says it was the quota and not an auth failure. **The position** says nobody has picked
the thread back up since. Remove any one of the three and it misfires.

One wrinkle: the quota error is almost never the last *line* — bookkeeping keeps trailing
after it. Position has to be counted in real turns, or you find nothing.

And it heals itself: resume the conversation and the transcript grows new turns, so the error
stops being last and the session stops being a candidate.

### Going first, without lying about the time

Jumping the queue cannot be done by giving a job an earlier `when` — that is the one thing
`requeue` refuses to do, because the scheduled times **are** the order, and moving one moves
the meaning of every job behind it. So priority is its own field:

```bash
kaip add "termina el refactor" --first     # before everything, as soon as there is quota
```

Nobody else's time moves. `--first` and `--at` contradict each other, so kaip refuses the
pair rather than guessing which you meant.

---

## Feeding a run that is already going

`kaip run` stays up even when the queue empties.

Leave a runner going and queue work into it later — from another terminal, or from a Claude
chat with `/programar` (which costs nothing). Anything you add is picked up within seconds,
including a job scheduled for *sooner* than the one it is currently counting down to.

The pattern this exists for: you are about to run out of tokens, so you queue the rest of the
work and walk away.

(`--once` is the old drain-and-exit behaviour, for scripts.)

---

## Parallel launches

```bash
kaip run --parallel 3
```

Two prompts aimed at different conversations have no reason to wait for each other.

The rule that makes it safe: **a target is a lane**. Two jobs on the same target share one
conversation, and resuming a session twice at once would corrupt it — so a lane runs one job
at a time, while different lanes run at once.

---

## The daemon

```bash
kaip daemon start      # detached background runner
kaip daemon status     # …and how many "daemon run" processes are REALLY alive
kaip daemon sweep      # kill leftovers nobody is tracking
kaip daemon log --last 50
kaip daemon install    # bring it back on login (Windows)
kaip daemon stop
```

The daemon only takes **scheduled** jobs. Sequential ones still wait for an explicit run —
otherwise adding a job would fire it seconds later, which is precisely the surprise this tool
avoids.

### One daemon. One. Global.

Four rules, and everything else follows from them:

1. **There is exactly one daemon**, machine-wide. Its pid lives in `data/daemon.json` and
   `start()` is idempotent. There is not one per prompt, nor one per parallel lane.
2. **`--parallel N` lives INSIDE a runner.** A parallel lane is not a process — it is a slot
   in one.
3. **A `kaip run` and the daemon are the SAME role**: drain the queue. Which is why there is a
   lock (`data/runner.lock`), and why only one of them can hold it.
4. **The lock is the source of truth** for "who is draining the queue?". Not `daemon.json`, not
   "is the daemon on?". There is no second answer to that question anywhere in the code.

So with a `kaip run` up, `kaip daemon start` **starts nothing** and says so, `kaip add` spawns
nothing, and the GUI's `D` key does nothing but tell you the queue already has someone. A
daemon and a run at once is not a state that should exist.

That used to be false. `add` spawned a daemon every single time: it raced for the lock, lost,
and died in silence half a second later — but not before writing its pid down and printing
*"daemon started (pid X) — it will fire on time"*. A doomed process and a lie, per `add`.

`daemon status` counts the processes that are actually alive, not the ones we think are. A
daemon nobody is tracking (a crash, an old race) is invisible — it starts hidden and writes to
a log — so counting them is the only way to know, and `sweep` is how you get rid of them.

---

## Servers and CI

```bash
kaip run --plain        # no full-screen TUI, just a log
```

The plain path is also what runs under a pipe, a scheduled task, or with no TTY at all — so
logs stay readable and nothing tries to paint a full-screen interface into them.

---

## Reviewing what happened

```bash
kaip list              # status of everything
kaip show <id>         # the job and the full conversation it had
kaip out <id>          # just the final answer
kaip chat <target>     # a conversation by name  [--last N] [--full] [--raw]
```

From a Claude chat:

- **`/prompt <your rough idea>`** — interviews you until the idea is sharp, investigates the
  project so the launch does not burn quota rediscovering it, and writes the finished prompt
  to a file. It hands you the absolute path, what it assumed without asking, and the
  `kaip add --from …` ready to paste. It never runs anything.
- **`/kaip-summary`** — what the last batch actually did, what got **cut short by
  quota**, and a *continuation* prompt for the unfinished work rather than the original.

---

## Layout

```
kaip.mjs            CLI dispatch
programar.mjs       the /programar hook (0 tokens)
install.mjs         hook + slash commands + alias
lib/
  store.mjs         queue · sessions · projects
  queue.mjs         add/remove/clear, and the suggestions
  prompt.mjs        the prompt: inline, or linked to a file
  runner.mjs        takes the lock, cleans up, and picks one of the three loops
  lock.mjs          one runner at a time
  schedule.mjs      what runs now, the lanes, and closing out what never ran
  launch.mjs        one job end to end: execute → settle → requeue or finish
  frames.mjs        everything that gets painted
  run-plain.mjs     the unattended loop (daemon, Task Scheduler, pipes)
  run-tui.mjs       the full-screen loop: the clock and the live view
  run-parallel.mjs  the lane loop
  quota.mjs         out-of-quota detection, and when it comes back
  cutshort.mjs      YOUR conversations the quota killed — the signal, and the offer
  daemon.mjs        the detached background runner
  chat.mjs          reading session transcripts
  server.mjs        the HTTP API the phone talks to
  tunnel.mjs        the Cloudflare tunnel
  crypto.mjs        end-to-end sealing (AES-256-GCM)
  qr.mjs            a QR encoder, from scratch — see below
  notify.mjs        knocking on the phone when a launch ends
  tui.mjs           the guided GUI
  ui.mjs            ANSI primitives
adapters/
  claude.mjs        Claude Code (streams events for the live view)
  opencode.mjs      stub
  mock.mjs          for tests — costs nothing
app/                the Android app (Kotlin + Compose)
```

Your data lives outside the repo and is gitignored: `data/`, `out/`, `projects.json`,
`programados.jsonl`. Set `KAIP_HOME` to keep it somewhere else.

### Why a QR encoder from scratch

Because it is not decoration — it is the security boundary. The QR is what lets the encryption
key reach the phone *without going through the tunnel it protects*. Pulling an npm package in
for it would have broken the only promise this tool makes about itself.

---

## Tests

```bash
node --test test/*.test.mjs      # 438 tests, no dependencies
kaip app test                    # the app's, on the JVM — no emulator
```

The `mock` adapter makes the whole run loop testable without spending a single token. The
app's crypto test seals an envelope *exactly the way Node does* and checks the phone opens
it — so if the two halves ever drift apart, it fails on the machine that builds them rather
than in your hand at 3am.

---

## License

MIT
