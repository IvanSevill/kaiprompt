# Kaiprompt

**A local launch queue for coding agents. Your quota can stop. Your queue does not have to.**

Kaiprompt schedules prompts for Claude Code, Codex, and OpenCode, runs them on your machine,
and keeps related jobs in the same engine session. Queue work before bed, leave a batch waiting
for quota to return, or split a long task into several launches without making the agent read the
project from scratch each time.

```bash
kaip claude add "run the tests and fix whatever breaks" --at 03:00 --dir myapp
kaip daemon start
```

When a recognized quota limit cuts a Claude launch short, Kaiprompt does not confuse the
interruption with a crash. It puts the job back in its original place, keeps the active runner
asleep until the reported reset, and resumes the saved session. You queue the work; Kaiprompt
keeps the appointment.

Kaiprompt 2.0.0 is an ESM Node CLI with zero npm dependencies. The repository also includes a
full-screen terminal UI and an Android companion app. Launches remain local: Kaiprompt has no
hosted backend and requires no Kaiprompt account.

## Why Kaiprompt exists

Coding agents are useful in bursts. Their limits are not.

- **More work than the current quota window can hold.** Queue it all. Due jobs keep their order,
  and the runner continues when capacity returns.
- **Work that should start while you are away.** Give it a time and leave the daemon running.
  No terminal needs to stay open.
- **A long task that should retain context.** Give related jobs the same `--target`; each engine
  resumes its own session for that target.
- **A launch that stopped halfway through.** Recognized quota interruptions are requeued with the
  saved session instead of being marked as ordinary errors.
- **A queue you need to check from elsewhere.** The Android app shows queue state, outputs,
  conversations, usage, and runner status from another network.

Kaiprompt does not increase quota, move execution to the cloud, or supervise the quality of a
prompt. It makes the quota and machine time you already have easier to use without being present.

## The queue model

The important distinction is simple: **queueing is not launching**.

| Job | What happens |
|---|---|
| With `--at` | It is scheduled. A daemon or a `kaip run` process launches it when due. |
| Without `--at` | It is sequential. It waits for an explicit `kaip run` or `r` in the TUI. |
| With `--first` | It becomes priority work and runs before other eligible jobs. |

Adding a job never launches it. Scheduled work also needs something to process the queue at the
right time. Use `kaip daemon start` for a detached runner, or leave `kaip run` open. The TUI and
phone app warn when scheduled work has no runner.

The daemon normally takes scheduled and priority jobs, not sequential jobs. `kaip daemon start
--seq` opts into sequential work too.

### Quota interruptions

Claude Code can report a session or weekly limit and exit with code 1, just as a failed process
would. Kaiprompt inspects the output and, when it recognizes a quota limit:

1. Returns the job to `pending` instead of `error`.
2. Leaves its scheduled time unchanged, preserving its place in the queue.
3. Keeps the current runner asleep until the reset time from the message or Claude usage data,
   with a fallback when neither supplies a usable time.
4. Resumes the engine session when the adapter returned a usable session ID.

Quota detection is based on provider output and can be imperfect. A job is requeued at most three
times for consecutive quota interruptions; the next one becomes an error rather than looping
forever. Recovery is strongest for Claude Code. Codex and OpenCode can launch and resume sessions,
but provider-specific limits do not always expose a reliable reset time.

The wait belongs to the active runner. If that runner is stopped and restarted, the normal
single-job loop can pick up the pending job before its recorded reset; the parallel runner is the
only loop that filters the persisted pause time after a restart.

### Interrupted manual chats

The TUI can also notice a resumable Claude conversation from the last 24 hours that appears to
have been cut short by a session or weekly limit. It offers to queue that conversation as a
continuation. Accepting resumes the existing session; declining dismisses that conversation so it
is not offered again.

This is TUI-only. Unattended commands never answer the prompt on your behalf.

## Install

Requirements:

- A modern Node.js runtime. No minimum is declared in package metadata; Node 18 or newer is the
  practical baseline because the CLI uses built-in `fetch` and `AbortSignal.timeout`.
- At least one installed and authenticated engine CLI: `claude`, `codex`, or `opencode`.
- A separate `claude-usage` clone for `kaip quota` and the OpenCode `usage_metrics` plugin. Put it
  beside this repository, set `CLAUDE_USAGE_PATH` for the CLI, and/or set `CLAUDE_USAGE_ROOT` for
  installer loader generation.

Clone the repository and run the dependency-free installer:

```bash
git clone https://github.com/IvanSevill/kaiprompt.git
cd kaiprompt
node install.mjs
```

The installer asks for an optional projects folder, creates `projects.json`, and adds the
`/prompt` and `/kaip-summary` commands plus a short note under `~/.claude`. It also installs a tiny
OpenCode loader under `~/.config/opencode/plugins` that points to the canonical plugin in the
separate `claude-usage` repository. The loader defaults to a sibling `../claude-usage` clone;
`CLAUDE_USAGE_ROOT` overrides that root. The installer does not copy quota code, validate or install
that repository, overwrite user-owned plugin files, or touch `settings.json`. It prints a shell
shortcut for the actual clone path; add that shortcut to your profile. Restart OpenCode after
installation.

The examples below assume the clone lives at `~/.claude/tools/kaiprompt`. Use the path printed by
the installer if you cloned elsewhere.

PowerShell (`notepad $PROFILE`):

```powershell
function kaip { node "$env:USERPROFILE\.claude\tools\kaiprompt\kaip.mjs" @args }
```

bash or zsh:

```bash
alias kaip='node "$HOME/.claude/tools/kaiprompt/kaip.mjs"'
```

For unattended installation, use `node install.mjs --yes`; to set the project base explicitly,
use `node install.mjs --base "PROJECTS_PATH"`. `node uninstall.mjs` removes the installed slash commands,
note, and unmodified OpenCode loader, but keeps queue data, outputs, and `projects.json`. Remove the
shell shortcut yourself.

## Use Kaiprompt

### Terminal UI

Run `kaip` with no arguments in an interactive terminal. The full-screen TUI has five views:
**Queue, Chats, Projects, Usage, and Help**. Switch views with `Left`/`Right`, `Tab`, or `1-5`.
Inside Usage, `Up`/`Down` changes the engine or OpenCode provider scope.

| Key | Action |
|---|---|
| `a` | Add a job |
| `e` | Edit a pending or missed job |
| `Space`, `m` | Select pending jobs and change their engine |
| `Enter` or `i` | Open job details |
| `d`, `x` | Delete the selected job; clear finished jobs |
| `r`, `D` | Run the queue; toggle the daemon |
| `o`, `c` | Show final output; show the available conversation history |
| `t` | Retry an error job from its detail screen, preserving its session |
| `y` | Join a saved Claude session in interactive Claude Code |
| `u` | Open historical token and cost usage |
| `?`, `R`, `q` | Help; redraw; quit |

The add wizard is one navigable form. `Up`/`Down` moves between fields, `Left`/`Right` chooses
prompt mode, engine, provider, model, and permissions, and `Enter` validates and queues. It
suggests known conversations and folders. It remembers only the last engine, provider, model, and
permission mode; prompt, time, target, and folder start empty.

### CLI

Choose the engine explicitly when adding a job:

```bash
kaip claude add "<prompt>" --at 03:00 --target fixes --dir myapp
kaip opencode add --from ./prompts/refactor.md --provider openai --model MODEL_ID
kaip codex add "review this repository" --model MODEL_ID

kaip list                          # queue and status
kaip run                           # stay open, process work, show the live TUI
kaip run --once                    # drain runnable work and exit
kaip run --plain                   # readable logs for pipes, servers, and CI
kaip run --parallel 3              # up to three independent target lanes

kaip out JOB_ID                    # final answer
kaip show JOB_ID                   # job details and available conversation history
kaip chat TARGET                   # conversation by target, job, or session
kaip edit JOB_ID --at +1h          # edit a pending job
kaip retry JOB_ID                  # retry an error in its existing session
kaip usage --engine opencode --provider openai
kaip quota --provider claude --json
kaip quota --provider codex --source auto --json

kaip engines list
kaip engines models --provider openai
kaip daemon start
kaip daemon status
kaip serve                         # phone API, tunnel, and pairing QR
kaip mobile                        # Android download QR
```

Times accept `HH:MM`, relative forms such as `+30m` and `+2h`, ISO date/time values, and English
or Spanish forms such as `tomorrow 09:00`, `manana 09:00`, `mon 09:00`, and `lun 09:00`.

`kaip quota` forwards its arguments, output, and exit code to external `claude-usage`. Discovery
checks `CLAUDE_USAGE_PATH` first (a clone directory or `usage.mjs`), then a sibling
`../claude-usage/usage.mjs`, then `claude-usage` on `PATH`. Kaiprompt never reads provider
credentials. If the tool cannot be found, the command exits `2` with the expected install paths.

### From Claude Code

The installer adds two slash commands:

- **`/prompt <rough idea>`** interviews you, inspects the project, and writes a launch-ready prompt
  to a file. It reports assumptions and a command for queueing the file; it does not run the job.
- **`/kaip-summary`** summarizes the last batch, identifies work cut short by quota, and proposes a
  continuation prompt instead of repeating the original request.

## Core controls

### `--target`: keep a conversation

Jobs with the same target continue the same engine-specific conversation. A Claude session is
never handed to Codex or OpenCode, even when the target name matches.

```bash
kaip claude add "inspect the failing tests" --target release
kaip claude add "fix the failures you found" --target release
```

A target is also a parallel lane. Jobs in different lanes may run together; jobs in one lane run
one at a time so the same session is never resumed concurrently.

### `--from`: read the prompt at launch

```bash
kaip claude add --from ./prompts/refactor-auth.md --at 03:00 --dir myapp
```

`--from` stores an absolute path and reads that file when the job launches, so you can keep editing
it after queueing. `--file` snapshots the contents while queueing. If a linked file is missing or
empty at launch, the job fails without sending a blank instruction.

### `--dir`: choose the project

`--dir` accepts a path, a project alias, or a subfolder name under the base configured during
installation. Claude Code sessions are folder-specific.

### Engines, models, and permissions

Every job pins an engine, and each attempt records the engine, provider, and model it used.
OpenCode also requires a provider and model:

```bash
kaip engines list
kaip engines models --provider openai
kaip opencode add "review this repository" --provider openai --model MODEL_ID
```

OpenCode streams text and Read/Edit/Write activity into the live view, and provider errors are
kept verbatim. Claude permission mode defaults to `bypass`, which permits unattended edits,
commands, and installs; `--perm acceptEdits` automatically accepts Claude's file edits, while
other operations may still prompt and stall an unattended launch. Codex always bypasses its
approval and sandbox prompts, while OpenCode runs with `--auto`; Kaiprompt's `--perm` value does
not constrain those two adapters.

Unattended launches are intentionally autonomous. Point them at work you can review and revert.

### `--first`: priority without changing time

```bash
kaip claude add "finish the refactor" --first
```

Priority is separate from scheduled time, so moving one job does not rewrite every job behind it.
`--first` and `--at` contradict each other and are rejected together.

## Daemon and parallel work

```bash
kaip daemon start      # detached runner for scheduled and priority jobs
kaip daemon status     # report the runner that is actually alive
kaip daemon sweep      # stop untracked daemon processes
kaip daemon log --last 50
kaip daemon install    # restore on login through Task Scheduler, Windows only
kaip daemon stop
```

There is one runner lock per Kaiprompt data home. A daemon and `kaip run` using the same clone or
`KAIP_HOME` both drain the same queue, so only one can own that lock. Separate data homes are
independent. If `kaip run` is active, `kaip daemon start` starts nothing and reports why. On macOS
and Linux, daemon autostart is not installed for you; configure the platform's own service manager
if needed.

For concurrent work:

```bash
kaip run --parallel 3
```

Different targets can launch in parallel. A single target remains serial because it shares one
conversation. Parallel work can still touch the same checkout; use separate directories when jobs
could edit the same files.

## Android app

<img src="https://img.shields.io/badge/Android-APK-D97757" alt="Android"> **[Download the latest
release](https://github.com/IvanSevill/kaiprompt/releases/latest)** or scan `kaip mobile`.

The app supports Android 8.0 and newer. There is no iOS app.

```bash
kaip mobile             # show the app download QR
kaip serve              # start the API and show the pairing QR
kaip serve --device 2   # wait for two phones to pair
kaip serve --wifi       # start a new server in local-network mode
kaip serve --reset      # rotate credentials and drop paired devices
```

Pairing replaces the QR with a live status panel but leaves the server and tunnel running. Starting
`kaip serve` while a server is already active restores the pairing screen until `Ctrl+C`.

The app can inspect the queue, launch details, output, available conversations, historical usage,
runner state, tunnel state, versions, and notification status. From the phone it can clear
finished/error/missed history; it cannot add, edit, retry, run, or delete individual pending jobs.
Assistant turns are labeled with their actual engine and, for OpenCode, provider.

The optional fast notification path is a direct callback from the PC to the phone while the app is
in the foreground, and therefore requires the phone to be reachable on its local network. Android
15 provides no compliant foreground-service type for an indefinite local callback socket; the app
does not mislabel it as `dataSync`. Background delivery relies on a nominal 15-minute WorkManager
catch-up poll that the operating system may defer. The first poll after installation or update is
silent so old completions are not replayed as new.

The UI can follow the system language or be set to Spanish or English. Update checks run when the
app returns to the foreground and open the latest GitHub release. Settings shows notification
status and a test button; if Android blocked the channel, the app links to system settings.

Build or test the app locally:

```bash
kaip app build           # release APK; requires Android SDK and JDK 17
kaip app test            # JVM unit tests; no emulator
```

The current release build uses the debug signing key and is not minified.

## Network and security boundaries

Kaiprompt has no hosted service, Firebase project, or account system. In the default remote mode,
the PC opens an outbound Cloudflare tunnel: no router configuration or inbound port forwarding is
required, and the phone does not need a VPN. Engine traffic and GitHub update/download checks still
go to their respective external services.

Pairing creates a bearer token and an AES-256-GCM key on the PC. Both reach the phone in the QR
shown on your screen. The Android app requests sealed JSON responses, so their contents cross the
Cloudflare tunnel as encrypted envelopes whose AES key is not sent through that tunnel.

That protection has a defined boundary: authenticated API clients can request plain JSON and
authorization metadata is not payload-sealed. Android requests sealed API and live SSE payloads;
the local notification callback also requires the pairing bearer token and an AES-GCM sealed body.
Cloudflare TLS still protects tunnel metadata. Do not treat the tunnel as a fully zero-knowledge
transport.

`kaip serve --wifi` starts a new API server without a Cloudflare tunnel and connects over the local
network. If a server is already active, `kaip serve` restores its screen instead of changing its
mode; stop that server before restarting with `--wifi`. Wi-Fi mode does not stop engine traffic or
update checks from using the internet. It uses local HTTP, so use it only on a network you trust.

The fast notification callback is a separate local HTTP endpoint on the phone. It validates the
request method, path, source, size and pairing bearer token, and accepts only AES-256-GCM sealed
payloads. Keep the local network trusted even though forged and plaintext callbacks are rejected.

If a phone is lost, `kaip serve --reset` rotates both the bearer token and encryption key and drops
all paired devices. The old phone is rejected on its next request.

## Limits by design

- Kaiprompt does not provide more quota; it schedules the quota you already have.
- Launches run on your machine. If the machine is off, nothing runs.
- Scheduled work needs an active daemon or `kaip run` process.
- Launches are autonomous by default, with no mid-launch supervision.
- Quota recovery depends on recognizable provider output and resumable session data.
- Conversation detail is richest for Claude transcripts. Codex and OpenCode views reconstruct
  history from stored prompts and final outputs rather than every streamed tool event.
- Remote mobile access normally depends on Cloudflare; Wi-Fi mode works only on that local network.
- The companion app is Android-only and has deliberately limited queue mutation controls.

## Data and layout

Queue state, outputs, and project aliases default to `data/`, `out/`, and `projects.json` under the
Kaiprompt clone. They are gitignored. Set `KAIP_HOME` to relocate them. Historical attempt usage is
retained independently when finished queue entries are cleared.

```text
kaip.mjs            CLI dispatch
install.mjs         slash commands, note, project setup, shell shortcut output
lib/store.mjs       queue, sessions, projects, and remembered defaults
lib/runner.mjs      runner lock, cleanup, and run-loop selection
lib/schedule.mjs    due work, target lanes, and missed launches
lib/launch.mjs      execute, settle, requeue, or finish one job
lib/quota.mjs       quota detection and reset timing
lib/run-tui.mjs     full-screen runner
lib/run-plain.mjs   daemon, pipe, and CI runner
lib/daemon.mjs      detached background runner
lib/server.mjs      Android HTTP API
lib/crypto.mjs      AES-256-GCM response sealing
lib/qr.mjs          dependency-free QR encoder
adapters/           Claude, Codex, OpenCode, and test adapters
app/                Android app in Kotlin and Compose
```

The QR encoder is kept in-repository because pairing is the path that carries the token and
encryption key from the PC screen to the phone. The Node CLI and server remain free of npm
dependencies; the Android project uses its normal Gradle dependencies.

## Tests

```bash
npm test
# equivalent: node --test test/*.test.mjs

kaip app test
```

The mock adapter exercises the run loop without using an engine token. The Android crypto test
opens an envelope produced in the same format as the Node server, catching protocol drift before
it reaches a phone.

## License

MIT
