# Kaiprompt v1.3.8 Plan

## Functional work

1. Add a standalone provider-neutral quota collector. Codex uses official app-server first, then normalized cached headers and rollout JSONL; Claude keeps its status-file collector.
2. Add stable conversation identity, persistent hiding of finished conversations, ordered refreshes and compatible server routes.
3. Normalize edit/write/multi-edit diffs once and transport bounded live diffs to Android.
4. Move all quota UI to Settings with Claude/Codex selection and show update availability before pairing.
5. Fix Android scrolling keys/memory pressure, unpair/HTTP edge cases, settings order and notification safety.
6. Align product version and release asset naming with `kaiprompt_android_v1.3.8.apk`.

## Structural work

1. Refactor Node into CLI, core, storage, runner, adapters, events, server, TUI, terminal and install boundaries.
2. Refactor Android into controller, data, protocol, domain, UI and background boundaries.
3. Remove cycles, duplicate projections, dead exports and unnecessary logic while preserving persisted data, CLI flags and protocol compatibility.

## Gates

- Focused tests after every slice.
- Full Node and Android unit suites.
- Android Compose/instrumentation coverage where available, lint and release assembly.
- Architecture, release-contract, APK metadata, signing and SHA-256 checks.
- Delete this temporary file before final commits.

## Structural Node Refactor Slice 1

### Objective

Move the current Node implementation into explicit storage, core, adapter, runner and event
boundaries without changing persisted bytes, environment variables, CLI/server protocols,
provider behavior or runner ordering.

### Architecture

`CLI/server/TUI -> runner/events/adapters/core -> storage`

- Storage owns path derivation, atomic JSON, cross-process serialized mutations and repositories.
- Core owns jobs, conversations, scheduling/activity, engine selection, quota retry policy and historical usage.
- Adapters own provider discovery/observation/normalization and share one configurable child-process stream harness.
- Runner owns lifecycle, locking, daemon coordination and one capacity-configured execution loop.
- Events owns durable NDJSON replay, cursors, subscriptions, compact tool arguments and canonical diffs.
- Daemon state and lock state are combined only by runner coordination, removing the daemon/status cycle.

### File Changes

- Create `src/storage/{paths,json,repositories}.mjs`; delete the moved `lib/store.mjs`.
- Create `src/core` modules from queue, conversation, schedule, activity, prompt/edit, engine selection,
  quota retry and historical usage logic; delete moved originals.
- Move providers and provider-specific normalization/discovery/observation to `src/adapters`, add one
  shared process harness and delete the root `adapters` originals plus moved `lib` originals.
- Create `src/events` durable event and normalization modules; delete moved event/diff originals.
- Create `src/runner` lifecycle, lock, coordination, daemon and execution modules; delete moved runner originals.
- Keep CLI, server and TUI rendering structure in place, changing imports and delegating scheduling to the shared loop.
- Add `scripts/check-architecture.mjs` and an npm architecture command for cycles and reverse dependencies.
- Update every production and test import to the concrete new owner; add runner trace coverage where behavior was implicit.

### Data And Edge Cases

- Keep all current env fallback names and all queue/session/hidden/default/project/history/live paths.
- Preserve JSON indentation/newline, append-only JSONL, unknown object fields, mutation locks and atomic replacement.
- Preserve exact provider argv, stdin versus argv prompt transport, cwd validation, environment edits, event conversion,
  output/error/session/usage/cost results and non-JSON diagnostic handling.
- Preserve priority/due/sequential ordering, target lanes, pause wakeups, once/watch/daemon behavior, stale/missed reaping,
  manual daemon takeover and lock ownership.
- Keep retry classification/policy pure and separate from Claude's externally observed usage file.

### Tests

- Focused: storage, core queue/conversation/quota/usage, adapters/events, runner/status/daemon/TUI.
- Full: `npm test`.
- Architecture: `npm run check:architecture`.
- Compare source LOC and static cycle count before/after; report remaining behavioral risk.

### Checklist

1. Establish storage/core/event boundaries and update consumers.
2. Move adapters and introduce the shared process harness.
3. Move runner lifecycle/coordination and consolidate execution loops.
4. Update tests and add trace assertions.
5. Run focused tests, full suite and architecture check.
6. Leave this plan and the dirty worktree uncommitted.
