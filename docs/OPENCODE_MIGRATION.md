# OpenCode Adapter Migration Guide for Kaiprompt

## Context & Authorship
This document was prepared by Gemini (a large language model built by Google) in collaboration with the author of Kaiprompt. Its purpose is to guide the AI assistant (Claude or otherwise) that will write the `adapters/opencode.mjs` implementation.

## What I Know (The Known State)
Based on Kaiprompt's `README.md` and CLI documentation:
*   `kaiprompt` is a portable, zero-dependency prompt queue system written in Node.js.
*   It uses an adapter pattern (`adapters/claude.mjs`) to spawn CLI agents.
*   The system heavily relies on intercepting the child process's output to feed a custom TUI (`frames.mjs`).
*   The queue manages sessions via a `--target` flag, reusing context to save tokens.
*   The system has a robust quota recovery mechanism (`quota.mjs`) that requeues jobs if the underlying agent exits due to rate limits.
*   The Claude adapter explicitly deletes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from `process.env` to force the agent to use the interactive subscription quota.

## What I Do Not Know (Areas Requiring Investigation)
I do not have access to the full source code of Kaiprompt or OpenCode's exact internal behavior. Therefore, **the implementing agent must verify the following before writing the code**:
*   **OpenCode's exact `stdout` format:** I do not know if OpenCode offers a structured `--json` or `--stream-json` flag like Claude does.
*   **Session ID generation in OpenCode:** I am not 100% sure how OpenCode emits the generated `session_id` to the console, or if it generates one automatically when running a one-shot `opencode run` command.
*   **Rate Limit Exit Codes:** I do not know the exact exit code or stderr string OpenCode produces when it hits an HTTP 429 (API Rate Limit).
*   **The exact parsing logic in `frames.mjs`:** I do not know how strictly the TUI relies on Claude's specific NDJSON event structure.

---

## Strict Rules (100% Certainty)

**1. Authentication (Environment Variables):**
Unlike Claude Code, OpenCode operates via standard API calls to providers (Anthropic, OpenAI, local models).
*   **RULE:** You MUST NOT strip `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or any other auth tokens from `process.env`. Pass the environment intact to the spawned process.

**2. Process Spawning & Prompt Injection:**
*   **RULE:** OpenCode accepts the prompt as a command-line argument (`opencode run "<prompt>"`), whereas Claude expects it via `stdin`. Do not write the prompt to `child.stdin`. Initialize the spawn options with `stdio: ['ignore', 'pipe', 'pipe']`.

**3. Unattended Execution:**
*   **RULE:** Map Kaiprompt's bypass permission requirement to OpenCode's equivalent flag (`--yes` or `--auto-confirm`) so unattended 3 AM jobs do not hang waiting for user input.

---

## Guidelines for Implementation (To Be Handled with Care)

**1. Output Parsing & TUI Compatibility:**
Since OpenCode natively renders its own TUI in the terminal (with ANSI colors and spinners), capturing its raw `stdout` might break Kaiprompt's `frames.mjs`. 
*   *Task:* You must find a way to strip ANSI escape codes from the output buffer, or verify if OpenCode has a clean output flag, before emitting the text back to Kaiprompt's event system.
*   *Task:* Emulate Kaiprompt's expected event structure (`{ type: 'text', text: chunk, session_id: sid }`) as closely as possible.

**2. Session Tracking & Resumption:**
*   *Task:* If Kaiprompt requests a new session (null `sessionId`) and OpenCode does not explicitly return a parsed session ID, you may need to generate a local identifier (e.g., via `crypto`) to maintain Kaiprompt's `--target` lane tracking.

**3. Quota Management:**
*   *Task:* OpenCode will hit API rate limits instead of Claude's 5-hour subscription limit. You must intercept OpenCode's specific error outputs (look for "429" or "rate limit" strings) and ensure the adapter resolves gracefully with an error state, allowing `quota.mjs` to requeue the job instead of permanently failing it.

---

## Future Expansions & Interesting Concepts (Do not implement yet)
When integrating OpenCode, Kaiprompt gains several architectural advantages that can be explored in future PRs:

1.  **Agnostic Ruteo (Cheap vs. Expensive Runs):** Because OpenCode is model-agnostic, Kaiprompt could add a `--local` or `--cheap` flag to route simple tasks (formatting, boilerplate) to local Ollama models, saving API costs.
2.  **Dynamic Skills Injection:** OpenCode supports `.opencode.md` files for context. Kaiprompt could dynamically generate these files inside the `--dir` path right before spawning the agent, injecting repository-specific rules (e.g., "Run `npm run build` after editing") without bloating the main prompt.
3.  **Headless MCP & Fetch:** Instead of spawning a new CLI binary per job, Kaiprompt's daemon could launch `opencode serve` once in the background, transforming the adapter from a `child_process.spawn` wrapper into a lightweight HTTP client using native `fetch()`.