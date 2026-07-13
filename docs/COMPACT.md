# `/compact` from an unattended launch — what is actually true

**Status: investigated, works, NOT implemented.** Nothing in kaip compacts anything today.
This file exists so nobody has to pay for the probe twice.

## The question

A `--target` reuses the session — that is the whole point, you do not re-pay for the context on
every job. The reverse of that coin: the conversation **grows forever**, and every turn of a
huge session costs more than the last. An old lane ends up paying a fortune to say "ok".

Claude Code has `/compact`. Can it be triggered from a non-interactive launch (`claude -p`)?

## The answer: yes

```bash
claude -p --resume <session-id> "/compact"
```

It really compacts. Verified against the transcript
(`~/.claude/projects/<dir>/<session-id>.jsonl`), which afterwards contains:

```
<command-name>/compact</command-name>
<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>
user: This session is being continued from a previous conversation that ran out of context…
```

The result envelope comes back `subtype: success`, `num_turns: 0`, `output_tokens: 0`, and an
empty `result` — i.e. it is **not** a model reply. It is the CLI executing a slash command.

There is no `--compact` flag and no `claude compact` subcommand. The prompt argument is the
only door.

### The trap that will cost you an hour

**Do not probe this from Git Bash / MSYS.** It rewrites the leading slash into a path, so
`"/compact"` arrives at Claude as the literal string `C:/Program Files/Git/compact` — the model
then *answers a question about compacting*, burning ~450 output tokens and adding a turn to the
very session you were trying to shrink. That looks exactly like "slash commands don't work in
`-p`", and it is not. Launch it from PowerShell/cmd, or set `MSYS_NO_PATHCONV=1`.

The adapter spawns Claude directly, with no shell, so kaiprompt itself is not affected — but a
human testing this by hand is.

## What is left, and why it is not written yet

The mechanism is the easy half. The threshold is the whole feature, and it has to survive two
traps that pull in opposite directions:

1. **Compacting also costs tokens.** It hands the conversation to the model to summarise.
   Compacting a lane that had two turns left in it spends more than it saves.
2. **Compacting a session you are about to resume can lose the thread.** An interrupted job is
   resumed precisely *because* of the context it holds; squeezing that context is how a resumed
   job repeats work, or quietly does something else. That is worse than the money.

So: **compact long, live lanes — never a session you are about to resume in order to finish
it.** If a threshold cannot tell those two apart, the threshold is wrong, and a knob that fires
on the wrong one is worse than no knob.

When it lands it must be: configurable, switchable off, and **loud** — "compactando la sesión
(142 turnos)" in the live view, never behind your back. And it ships with a measured
before/after (tokens per turn) in the commit, or it does not ship: a feature you believe saves
money and does not is worse than nothing, because it stops being looked at.
