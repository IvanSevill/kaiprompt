# OpenCode Integration

OpenCode is implemented as a first-class Kaiprompt engine.

## Current behaviour

- Queue a launch with `kaip opencode add "..." --provider <provider> --model <model>`.
- Omitting `--model` lists the models discovered for that provider, so the command line can guide
  selection without memorising model ids.
- The adapter launches `opencode run --format json --auto`, consumes its NDJSON events, records
  the OpenCode session id, and resumes it on the next job for the same target.
- Windows launches are hidden and unattended prompts explicitly instruct the agent not to wait for
  interactive decisions.
- OpenCode model/provider choices are available in both the CLI and the guided terminal UI.

## Quota Behaviour

Kaiprompt recognises common API quota/rate-limit errors and relative retry windows. A provider that
does not expose a reset or retry time can only be retried using the fallback policy, so Claude Code
remains the most reliable engine for subscription-quota recovery.

## Historical Note

The previous long investigation was written before the adapter existed. Its command-output probes
informed the implementation, but its conclusion that OpenCode was unimplemented is no longer true.
