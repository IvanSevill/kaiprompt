# Kaiprompt

**Your coding agent stops when the quota runs out. Your work doesn't.**

Kaiprompt puts your prompts in a queue and launches them for you — at 3am, or the moment
your quota comes back. And when the quota dies in the middle of a job, it puts that job
**back in the queue in its place and resumes it where it left off**. It does not start over.

You queue the work and walk away.

```
kaip claude add "run the tests and fix whatever breaks" --at 03:00 --dir myapp
```

Zero npm dependencies — just Node. Claude Code, Codex and OpenCode are first-class engines;
each launch records the engine, provider and model it actually used.

---

## What this is actually for

**You have four things to do and quota for two.** Queue all four. The first two go out now,
the other two go out by themselves when the window resets. You do not have to be there, and
you do not have to remember.

**You are going to bed and you want it done by morning.** `--at 03:00`, start the daemon,
close the terminal. The daemon fires it with nothing open and nobody watching.

**Something got cut off halfway and you don't want to re-send the whole prompt.** You don't
have to. The job kept its place in the queue and its conversation; when the quota returns it
carries on from where it stopped, with the context it already paid for.

**You're out of the house and you want to know if it finished.** The phone app shows the
queue, the full conversation of every launch, and pushes you a notification the moment a
launch ends — with the app closed.

**A big job keeps dying before it finishes.** Split it across several launches that share a
`--target`. They continue one conversation instead of re-reading your project four times, so
they cost less and are far likelier to finish.

---

## Running out of quota is an interruption, not a failure

This is the part worth understanding, because it is the whole point.

When Claude runs out of quota mid-launch it prints `You've hit your session limit · resets
1:30pm` and **exits 1** — which, to anything watching the exit code, looks exactly like a
crash. Treat it as one and you mark the job `error` and throw the work away.

So kaip reads it for what it is:

- The job goes **back to `pending`**, not `error`.
- Its scheduled time is **left alone**. That is what preserves the order: it is still the
  earliest job due, so when the quota returns it goes **first** again, and everything behind
  it stays behind it.
- The runner sleeps until the reset and carries on. Same job, same conversation, same place.

Both windows are covered — the 5-hour session and the 7-day weekly limit — and the wait is
computed from whichever comes back first.

### It also rescues the conversations *you* were having

That only ever covered launches kaip made. The chat you were having by hand had none of it:
you were five minutes from done, the quota ran out, and now you have to wait four hours,
**remember**, find the right conversation and type "carry on".

So kaip reads your transcripts, and the GUI offers to finish them:

```
╭─ cut short ─────────────────────────────────────────────╮
│ A conversation looks like it was cut off.               │
│                                                         │
│ ▸ myapp · 12 min ago                                    │
│     «…still need to wire up the network config»         │
│                                                         │
│ Finish it as soon as the quota is back?                 │
╰─────────────────────────────────────────────────────────╯
  [enter] yes   ·   [esc] no (won't ask again)
```

Say yes and it is queued as a **continuation** — same session, resumed, prompt never re-sent
— and it goes first. It is the cheapest job in the queue: the context is already paid for and
the work is half done.

Say no and **it never asks about that one again**. An alert that keeps coming back is one you
learn to dismiss without reading, and then it is worth nothing on the day it matters.

**GUI only.** With no terminal there is nobody to answer a question, so nothing is asked and
nothing changes.

---

## The one thing to get right: queueing is not launching

This trips everyone up, so it is worth stating plainly.

| | |
|---|---|
| A job **with** a time (`--at`) | is **scheduled**: the daemon fires it at that time. Nothing needs to be open. |
| A job **without** a time | is **sequential**: it waits in the queue until *you* run it (`run`, or `r` in the GUI). |

**Adding a job never launches it.** For a scheduled job to actually fire, something has to be
processing the queue at that moment: either the **daemon** (`kaip daemon start`) or a `run`
you left up. The GUI, the phone app and the goodbye screen all tell you when the daemon is
off — because scheduling work that nothing will fire is the one silent way this tool could
lie to you.

---

## Install

```bash
git clone https://github.com/IvanSevill/kaiprompt.git
cd kaiprompt
node install.mjs
```

It writes two slash commands and a short note into `~/.claude`, and **overwrites nothing that
is already there**. It does not touch `settings.json`. `node uninstall.mjs` reverses it.

**Shell alias** — PowerShell (`notepad $PROFILE`):

```powershell
function kaip { node "$env:USERPROFILE\.claude\tools\kaiprompt\kaip.mjs" @args }
```

bash / zsh:

```bash
alias kaip='node "$HOME/.claude/tools/kaiprompt/kaip.mjs"'
```

---

## Using it

### The GUI

`kaip` with no arguments. Views: **Queue · Chats · Projects · Usage · Help**. Use `←/→`,
`tab`, or `1-5` to switch sections. Inside Usage, `↑/↓` switches between Claude, Codex and
each OpenCode provider without stealing the section-navigation keys.

| key | |
|---|---|
| `a` `e` `d` `x` | add · edit · delete · clear finished |
| `r` `D` | run now · daemon on/off |
| `o` | the **answer** — just the last thing Claude said |
| `c` | the **conversation** — every turn it took to get there |
| `t` | retry the selected failed job, preserving its session |
| `y` | **join** it — drops you into a real, interactive Claude Code on that session |
| `u` | historical token/cost usage, retained even after finished jobs are cleared |
| `R` `q` | redraw · quit |

The add wizard is one navigable form: `↑/↓` moves between fields, `←/→` chooses prompt mode,
engine, provider, model and permissions, and `Enter` validates and queues the job. Existing
conversations and folders are suggested in place. New jobs remember only the last engine,
provider, model and permission mode; prompts, times, targets and folders always start empty.

### The terminal

```bash
kaip claude add "<prompt>" --at 03:00 --target fixes --dir myapp
kaip opencode add --from ./prompts/refactor.md --provider openai --model gpt-5.6-terra
kaip list                          # the queue, with status
kaip run                           # process it: full-screen countdown + live view
kaip out <id>                      # the final answer
kaip show <id>                     # the job AND the whole conversation it had
kaip chat <target>                 # the conversation, by name
kaip edit <id> --at +1h            # change a pending job
kaip retry <id>                    # retry an error job in its existing session
kaip usage --engine opencode --provider openai
kaip opencode add --provider openai # list available OpenCode models
kaip daemon start                  # fire scheduled jobs with no terminal open
kaip serve                         # the API + tunnel + pairing QR, for the phone
kaip mobile                        # the QR to download the app
```

### From a Claude chat

- **`/prompt <your rough idea>`** — interviews you until the idea is sharp, investigates the
  project so the launch does not burn quota rediscovering it, and writes the finished prompt
  to a file. It hands you the path, what it assumed without asking, and the `kaip add --from …`
  ready to paste. It never runs anything.
- **`/kaip-summary`** — what the last batch actually did, what got **cut short by quota**, and
  a *continuation* prompt for the unfinished work rather than the original.

To queue something, the agent just runs `kaip add`.

---

## The phone app

<img src="https://img.shields.io/badge/Android-APK-D97757" alt="Android"> **[Download the
APK](https://github.com/IvanSevill/kaiprompt/releases/latest)** · or scan the QR from
`kaip mobile`.

```bash
kaip mobile     # the QR to download the app  (once)
kaip serve      # the API, the tunnel, and the pairing QR
```

`serve` shows the pairing QR itself, and takes it off the screen when the requested phones pair
(`kaip serve --device 2` waits for two). Pairing replaces the QR with a live status panel;
it does **not** stop the HTTP server or tunnel. Running `kaip serve` while one is already active
restores that pairing screen and stays open until you press `Ctrl+C`.
A code that has done its job is not neutral sitting there — it is a secret on your monitor.

**No cloud, no Firebase, no account.** The PC opens an outbound Cloudflare tunnel (no ports
forwarded, no router touched) and the phone reaches it over plain HTTPS. It needs **no VPN on
the phone**, so a firewall app like NetGuard keeps its one VPN slot — and it works from any
network, 4G included.

Want no third party at all? **`kaip serve --wifi`** drops the tunnel: the phone talks to this
machine over your own network and nothing leaves the house. The trade is that it only works
while you are on that network.

Lost the phone? **`kaip serve --reset`** mints a new token *and a new key* and drops every
paired device: the lost one is locked out from its next request. The key goes too, not just
the token — leaving it alive would let that phone still read anything it had already fetched.

Cloudflare terminates the TLS and could otherwise read everything passing through. It cannot:
the payload is **sealed end-to-end** with AES-256-GCM, and the key never travels the tunnel it
protects — it is minted on the PC and reaches the phone *inside the pairing QR*, scanned off
your own screen. They carry an envelope they have no key to.

**Notifications** are the PC knocking directly on the phone, which a foreground service turns
into a notification even at 3am with the app closed. A knock that lands nowhere (phone off, no
signal) is caught by a poll every 15 minutes — the webhook is the fast path, not the only one.
The first poll after installing or updating is silent, so old completed jobs are never replayed as
new notifications. The app can be switched between Spanish, English, and the system language in
Settings.

The app labels assistant turns with their real engine (`CLAUDE`, `CODEX`, or
`OPENCODE · <provider>`), not a hard-coded name. Settings also contains historical Usage,
notification status and a test-notification button; when Android has blocked the channel it
links directly to the system settings. Update checks run whenever the app returns to the
foreground, bypass stale caches, and open the latest GitHub release. Available UI text and
release notes follow the selected Spanish, English, or system language.

Build it yourself: `kaip app build` (needs the Android SDK). `kaip app test` runs its unit
tests on the JVM, no emulator.

---

## Concepts

### `--target` — persistent conversations (this is where the savings are)

Jobs sharing a `--target` **continue the same conversation**: the first creates the session,
the rest resume it (`claude --resume`). The context is already loaded, so the launch does not
pay to re-read your project from scratch.

### `--from` — the prompt lives in a file

```bash
kaip add --from ./prompts/refactor-auth.md --at 03:00 --dir myapp
```

The job stores the **path**, and the file is read **at launch** — so you can keep sharpening
the prompt right up to the second it goes out. (`--file` does the opposite: it pastes the
contents in now, as a snapshot.)

If the file is gone or empty at launch time, **nothing is sent** and the job fails loudly. An
unattended launch runs with full autonomy in a real project; handing it a blank instruction
and letting it improvise is the worst thing this tool could do.

### `--dir` — which project it runs in

Claude Code sessions are **per folder**. `--dir` takes a project name (a subfolder of your
configured base), an alias, or a path.

### `--perm` — permissions for an unattended launch

Default is **bypass**: full autonomy (edits, Bash, installs) with no prompts. It has to be
that way — if a launch stops to ask permission at 3am, there is nobody to grant it and the job
just hangs, having done nothing. `--perm acceptEdits` restricts it to edits only.

### Engines, providers and models

Every job pins its engine. OpenCode additionally requires a provider and model:

```bash
kaip engines list
kaip engines models --provider openai
kaip opencode add "review this repository" --provider openai --model gpt-5.6-terra
```

OpenCode streams text and Read/Edit/Write tool activity into the same live view as the other
engines. Provider errors are preserved verbatim, so an unsupported account/model combination
is reported instead of being reduced to a generic `Bad Request`.

### `--first` — jump the queue without lying about the time

Priority cannot be done by giving a job an earlier `when`: the scheduled times **are** the
order, and moving one moves the meaning of every job behind it. So priority is its own field.

```bash
kaip add "finish the refactor" --first     # before everything, as soon as there is quota
```

Nobody else's time moves. `--first` and `--at` contradict each other, so kaip refuses the pair
rather than guessing which you meant.

---

## Parallel launches

```bash
kaip run --parallel 3
```

Two prompts aimed at different conversations have no reason to wait for each other. The rule
that makes it safe: **a target is a lane**. Two jobs on the same target share one conversation,
and resuming a session twice at once would corrupt it — so a lane runs one job at a time, while
different lanes run at once.

## The daemon

```bash
kaip daemon start      # detached background runner
kaip daemon status     # …and how many are REALLY alive
kaip daemon sweep      # kill leftovers nobody is tracking
kaip daemon log --last 50
kaip daemon install    # bring it back on login (Windows)
kaip daemon stop
```

The daemon only takes **scheduled** jobs. Sequential ones still wait for an explicit run —
otherwise adding a job would fire it seconds later, which is precisely the surprise this tool
avoids.

**There is exactly one daemon, machine-wide**, and a `kaip run` is the same role: drain the
queue. Which is why there is a lock, and why only one of them can hold it. With a `run` up,
`daemon start` starts nothing and says so. A daemon and a run at once is not a state that
should exist.

## Servers and CI

```bash
kaip run --plain        # no full-screen TUI, just a log
```

The plain path is also what runs under a pipe, a scheduled task, or with no TTY at all — so
logs stay readable and nothing tries to paint a full-screen interface into them.

---

## What it does not do

- **It does not get you more quota.** It spends what you have while you are not looking. That
  is all.
- **It does not run in the cloud.** The launches happen on your machine. If it is off, nothing
  fires.
- **It cannot fire a scheduled job if nothing is processing the queue.** The daemon or a `run`
  has to be up. Everything in the UI says so, loudly, because it is the one way this could
  quietly do nothing.
- **A launch runs with full autonomy by default.** It edits files and runs commands with no
  one watching. Point it at a repo you can revert.
- **There is no supervision mid-launch.** If a prompt was wrong, you find out afterwards.
  That is what `/prompt` is for.
- **Quota recovery is strongest for Claude Code.** OpenCode and Codex launch, resume sessions and
  report their output, but provider-specific API limits cannot always supply a reliable reset time.
- **The phone app is Android only.**

---

## Layout

```
kaip.mjs            CLI dispatch
install.mjs         slash commands + the note + alias
lib/
  store.mjs         queue · sessions · projects · remembered launch defaults
  queue.mjs         add/remove/clear, and the suggestions
  prompt.mjs        the prompt: inline, or linked to a file
  runner.mjs        takes the lock, cleans up, and picks one of the three loops
  lock.mjs          one runner at a time
  schedule.mjs      what runs now, the lanes, and closing out what never ran
  launch.mjs        one job end to end: execute → settle → requeue or finish
  usage.mjs         historical tokens/cost, independent from queue cleanup
  frames.mjs        everything that gets painted
  run-plain.mjs     the unattended loop (daemon, Task Scheduler, pipes)
  run-tui.mjs       the full-screen loop: the clock and the live view
  run-parallel.mjs  the lane loop
  quota.mjs         out-of-quota detection, and when it comes back
  runner-status.mjs "will anything actually fire?" — asked HERE, by everyone
  cutshort.mjs      YOUR conversations the quota killed — the signal, and the offer
  daemon.mjs        the detached background runner
  chat.mjs          reading session transcripts
  server.mjs        the HTTP routes the phone talks to
  server-pair.mjs   pairing: the token, the key, the QR, who is on the other end
  server-dto.mjs    what the API answers with — shapes, no sockets
  tunnel.mjs        the Cloudflare tunnel
  crypto.mjs        end-to-end sealing (AES-256-GCM)
  qr.mjs            a QR encoder, from scratch — see below
  notify.mjs        knocking on the phone when a launch ends
  tui.mjs           the guided GUI: the reducer and the loop
  tui-keys.mjs      raw stdin bytes → a key name
  tui-state.mjs     what the GUI is looking at
  tui-render.mjs    state → the lines to paint (pure)
  ui.mjs            ANSI primitives
adapters/
  claude.mjs        Claude Code (streams events for the live view)
  codex.mjs         Codex CLI — opt-in, not verified in anger
  opencode.mjs      OpenCode runner (provider/model selection + JSON streaming)
  mock.mjs          for tests — costs nothing
app/                the Android app (Kotlin + Compose)
```

Your data lives outside the repo and is gitignored: `data/`, `out/`, `projects.json`. Set
`KAIP_HOME` to keep it somewhere else.

### Why a QR encoder from scratch

Because it is not decoration — it is the security boundary. The QR is what lets the encryption
key reach the phone *without going through the tunnel it protects*. Pulling an npm package in
for it would have broken the only promise this tool makes about itself.

---

## Tests

```bash
node --test test/*.test.mjs      # no dependencies
kaip app test                    # the app's, on the JVM — no emulator
```

The `mock` adapter makes the whole run loop testable without spending a single token. The
app's crypto test seals an envelope *exactly the way Node does* and checks the phone opens it
— so if the two halves ever drift apart, it fails on the machine that builds them rather than
in your hand at 3am.

---

## License

MIT
