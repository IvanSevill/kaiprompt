# Database Migration Decision

## Status

**Decision: do not migrate yet. Prefer SQLite when the prerequisites below are met.**

Kaiprompt's data volume does not require a database. Its correctness requirements increasingly
do: the CLI, daemon, runner, TUI, and phone server can be separate processes that mutate related
state. SQLite is the best long-term fit for those transactional updates while preserving the
local, offline, single-user product model.

The immediate step is to harden the existing file store and define its schemas. A database
migration should begin only after Kaiprompt chooses and enforces a Node version/dependency policy,
has fixtures from released data formats, and has a tested database-to-files rollback exporter.
This document records the proposed direction; it does not authorize or implement a migration.

No folder reorganization is recommended as part of this work. The current boundaries (`store`,
`queue`, `schedule`, `launch`, `server-dto`, and the adapters) are suitable seams for changing a
storage backend. Moving them would add import and release churn without reducing migration risk.

## Current Storage

The desktop data home is selected from `KAIP_HOME`, the legacy `PROMPTHEUS_HOME` or
`PROGRAM_PROMPT_HOME`, and finally the repository root. Kaiprompt owns these paths below that
home:

| Path | Purpose | Retention |
|---|---|---|
| `data/queue.json` | Jobs and their current lifecycle state | Finished entries may be cleared |
| `data/sessions.json` | Target-to-engine session mappings | Persistent |
| `data/launch-defaults.json` | Last engine/provider/model/permission choices | Persistent |
| `projects.json` | `_base` and project aliases | Persistent |
| `data/history/<job-id>.jsonl` | Append-only attempt and usage records | Survives queue clearing |
| `out/<job-id>.txt` | Final output and optional error text | Not automatically pruned |
| `data/server.json` | Pairing token, encryption key, devices, and public URL | Persistent, secret |
| `data/cutshort.json` | Dismissed interrupted sessions | Persistent |
| `data/daemon.json` | Tracked daemon PID and start state | Runtime state |
| `data/daemon.log` | Daemon stdout/stderr | Append-only, no rotation today |
| `data/runner.lock` | Runner PID, ownership, start, and heartbeat | Ephemeral lease |
| `data/update.json` | Disposable update-check cache | Re-creatable |
| `data/*.bak.json` | Existing migration backups | Manual retention |

### Job Records

`queue.json` is an array. A job contains an ID, prompt or linked prompt path, target, adapter,
provider/model selection, schedule, working directory, permission mode, status, timestamps,
session/output references, and optional priority, continuation, quota, retry, and error fields.
There is no explicit schema version for the complete record.

Linked prompts and working directories are absolute machine-local references. A migration must
preserve them as references; importing file contents would change `--from` behavior.

### Session Records

`sessions.json` has a compatibility shape. Each target may have an `engines` object keyed by
adapter, while the newest engine record is duplicated at the target's top level for older
consumers. A database should normalize this to one row per `(target, adapter)`, but exports must
reconstruct the compatibility shape while file-based versions remain supported.

### History And Output

History uses one JSON object per line. `attempt-start` and `attempt-end` events include engine
selection, timing, session, usage, cost, and failure data. Outputs are potentially large text
files. They do not need to move into an initial database; storing their relative paths keeps the
database small and makes recovery easier.

### Data Kaiprompt Does Not Own

Kaiprompt reads provider-owned state, including Claude transcripts under the Claude config
directory, Claude usage data, Codex model caches, and user-authored linked prompt files. These
must remain external. A database may cache metadata or retain paths, but it must not move, delete,
or become authoritative for those files.

### Android Storage

The app stores pairing URLs, bearer token, AES key, installation ID, language, announcement IDs,
notification baseline, and seen version in private `SharedPreferences`. WorkManager maintains its
own framework-owned SQLite database. The app does not keep a local queue database and never reads
desktop files directly.

A desktop migration therefore does not require an Android database migration if HTTP DTOs and
pairing behavior stay stable. Moving Android credentials to Keystore-backed storage is a separate
security project.

## Current Failure Model

Atomic file replacement prevents readers from seeing a partially written JSON document, and
malformed JSON must be reported rather than interpreted as empty state. Those safeguards do not
make a group of files transactional.

Remaining file-store constraints include:

- Queue, session, and server updates are whole-file read/modify/write operations. Independent
  processes can still overwrite each other's logically concurrent changes.
- A launch updates history, output, sessions, and queue state separately. A crash can leave an
  unmatched attempt, an orphan output, or a stale running job.
- The runner lease prevents duplicate runners, but it does not serialize every CLI/API mutation.
- Existing migration code cannot atomically update queue and sessions together.
- JSON has no enforced types, foreign keys, unique constraints, or indexed queries.
- Backups have no built-in verification, retention, restore, or forward-export workflow.

These are the reasons to consider a database. Dataset size and query speed are not.

## Candidates

| Candidate | Benefits | Costs and concerns | Decision |
|---|---|---|---|
| Hardened JSON/files | No new runtime dependency; smallest change; human-readable | Cross-file transactions and cross-process mutations remain difficult | Keep in the near term |
| SQLite | Transactions, constraints, crash recovery, indexes, one local file, mature tools | Requires a supported Node binding and careful migration/backup design | Preferred target |
| `node:sqlite` | Avoids an npm/native package on Node versions that provide an acceptable API | Requires selecting and enforcing a sufficiently recent Node baseline; API support must be evaluated against that baseline | Preferred binding if prerequisites fit |
| `better-sqlite3` | Mature synchronous transactions fit the current architecture | Native binaries, ABI/platform packaging, installation and release cost | Strong fallback |
| `sqlite3` package | Widely used | Native dependency and asynchronous/callback impedance | Not preferred |
| LevelDB or LMDB | Durable key/value storage and good throughput | Poorer fit for relations, constraints, usage aggregation, and migrations; often native | Reject |
| DuckDB | Excellent analytical queries | Not primarily a transactional queue/lease store | Reject as primary store |
| PostgreSQL | Strong concurrency and operations tooling | Server administration contradicts local/offline simplicity | Reject |

The Node baseline must be decided before choosing `node:sqlite` or a package. The migration must
not assume that every currently usable Node runtime exposes the same built-in SQLite API.

## Proposed Hybrid Schema

Keep `out/`, provider transcripts, linked prompts, and daemon logs as files initially. Store
mutable metadata and attempt history in SQLite.

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  app_version TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  prompt TEXT,
  prompt_file TEXT,
  target TEXT,
  adapter TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  scheduled_at INTEGER,
  working_dir TEXT,
  permission_mode TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','error','missed')),
  priority INTEGER NOT NULL DEFAULT 0,
  continuation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  retried_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  runner_pid INTEGER,
  session_id TEXT,
  output_path TEXT,
  error TEXT,
  quota_retries INTEGER,
  quota_kind TEXT,
  paused_until INTEGER,
  legacy_json TEXT
);

CREATE TABLE target_sessions (
  target TEXT NOT NULL,
  adapter TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target, adapter)
);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt_no INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  ok INTEGER,
  duration_ms INTEGER,
  adapter TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  target TEXT,
  session_id TEXT,
  usage_json TEXT,
  cost REAL,
  error TEXT,
  UNIQUE (job_id, attempt_no)
);

CREATE TABLE projects (
  alias TEXT PRIMARY KEY,
  path TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE paired_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  callback_url TEXT,
  paired_at INTEGER NOT NULL
);

CREATE TABLE server_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  token TEXT NOT NULL,
  encryption_key TEXT NOT NULL,
  public_url TEXT,
  public_url_at INTEGER,
  pairing_reset_at INTEGER
);

CREATE TABLE dismissed_sessions (
  session_id TEXT PRIMARY KEY,
  dismissed_at INTEGER
);

CREATE TABLE runner_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_token TEXT,
  pid INTEGER,
  acquired_at INTEGER,
  heartbeat_at INTEGER
);
```

`legacy_json` protects unknown job fields during the first migration cycle. It can be removed only
after fixtures prove that all released fields are represented explicitly.

## Concurrency And Locking

Use short transactions and keep engine processes outside transactions:

1. Claim a runnable job in a transaction, changing `pending` to `running` only if it is still
   eligible.
2. Commit before launching an engine.
3. Record session, attempt completion, and final job state in one completion transaction.
4. Publish notifications only after commit.

Use `BEGIN IMMEDIATE` for mutations that must establish write ownership predictably. Configure a
bounded busy timeout and surface a clear "store busy" error rather than waiting indefinitely.
WAL mode is appropriate on a local disk because the phone server reads while the runner writes.
It should not be assumed safe on network shares; detect/document unsupported homes or use rollback
journaling there.

The runner lease still has product meaning even though SQLite serializes writers: only one process
should execute engines. Store an unguessable owner token, PID, acquisition time, and heartbeat.
Renew and release only when the owner token matches. Job claiming must remain conditional so a
lease race cannot launch a job twice.

## Migration Strategy

### Preconditions

- Stop the daemon, manual runners, and server writes.
- Verify that no job is `running`.
- Acquire an exclusive migration lock.
- Resolve the selected Node/SQLite runtime on every supported platform.
- Snapshot the complete data home, including `data/`, `out/`, and `projects.json`.
- Record file hashes, source paths, application version, counts, and status totals.
- Parse all JSON and JSONL strictly. Corruption is a blocker, not an empty default.

### Import And Validation

1. Create a temporary database beside the intended final database.
2. Enable foreign keys and create the versioned schema.
3. Import all mutable metadata in one transaction.
4. Preserve unknown fields and report orphan history/output files.
5. Validate job/status counts, sessions per adapter, attempts per history file, devices, dismissed
   sessions, and output existence. Hash outputs where practical.
6. Commit, close, reopen, and run SQLite integrity and foreign-key checks.
7. Run DTO-level comparisons against the file backend using the same fixtures.
8. Atomically place the verified database and write a backend marker last.
9. Retain the source snapshot unchanged for at least one stable release cycle.

The migration must be idempotent: rerunning inspection is safe, while rerunning an already applied
cutover exits without rewriting either backend.

## Rollback

Switching back to the pre-migration JSON snapshot after SQLite accepts writes would lose newer
data. A credible rollback therefore requires a versioned database-to-files exporter that:

- writes into a new directory using atomic file replacement;
- reconstructs legacy session top-level fields and `engines` maps;
- emits history JSONL in stable attempt order;
- preserves unknown fields and output paths;
- validates counts and hashes before changing the backend marker;
- keeps the failed database and original snapshot for diagnosis.

Do not dual-write SQLite and JSON in production. Two sources of truth create harder failure modes
than the migration solves. A read-only canary or shadow comparison is safer.

## Server And Mobile Impact

The HTTP API should continue to consume repository/domain functions and emit the current DTOs.
Android should not know whether the PC uses files or SQLite. API route, authentication, encryption,
SSE, pairing, and output behavior must remain wire-compatible throughout migration.

The server benefits from transactional device registration and credential rotation. Moving
`server.json` into SQLite does not encrypt secrets at rest. OS-backed secret storage can be added
later, but should not be coupled to the first database cutover.

The app's SharedPreferences and WorkManager database are out of scope. No mobile schema upgrade is
required unless the API contract changes, which this proposal explicitly avoids.

## Operational Cost

SQLite adds schema migrations, integrity checks, backup/export tooling, dependency or Node-runtime
management, and platform testing. Native npm bindings add binary distribution and ABI support.
Built-in SQLite reduces package operations only if Kaiprompt can raise and enforce its Node
baseline without excluding supported installations.

Operators need documented commands for inspection, online-safe backup, export, restore, integrity
checks, and data-home relocation. Backups must account for the main database plus WAL/SHM files or
use SQLite's backup mechanism; copying only the main file while it is active is insufficient.

## Risks

- Implicit behavior in legacy and mixed-version job/session records may be missed.
- A partial cutover could leave ambiguous backend ownership.
- Absolute project and linked-prompt paths remain machine-bound after migration.
- Unknown/orphan histories and outputs could be dropped by an overly strict schema.
- Native bindings may fail on unsupported CPU, OS, Node ABI, or restricted install environments.
- WAL behavior differs on network and synchronized folders.
- Database inclusion does not by itself improve secret encryption.
- A rollback exporter that is not tested against newer writes gives false confidence.

## Estimated Phases

These are engineering ranges, not calendar commitments:

| Phase | Scope | Estimate |
|---|---|---|
| 0 | File-store hardening, schema inventory, corruption/recovery tests | 2-4 days |
| 1 | Node baseline/binding decision, repository interface, SQLite prototype | 3-5 days |
| 2 | Schema, importer, fixtures, validation, and exporter | 5-8 days |
| 3 | Transactional queue/session/attempt implementation and concurrency tests | 5-8 days |
| 4 | Server/mobile compatibility, packaging, Windows/macOS/Linux verification | 3-6 days |
| 5 | Read-only canary, documented cutover/rollback, one release-cycle observation | 1-2 releases |

## Go/No-Go Criteria

Proceed only when all are true:

- A supported Node baseline and SQLite binding are explicit and tested on release platforms.
- Released JSON/session/history fixtures import without unexplained loss.
- Concurrent claim/mutation and crash-recovery tests pass.
- The exporter recreates a file backend that passes the full suite and DTO comparisons.
- Migration refuses live runners and corrupt input, and verifies backups before cutover.
- API and Android behavior remain unchanged.
- Release packaging and support cost are accepted.

Defer if Kaiprompt remains single-process in practice, cannot raise the Node baseline, cannot carry
a native dependency, or lacks time to build and test rollback. In that case, continue improving
atomic files, mutation locking, schema validation, retention, and recovery documentation.

## Recommendation

Do not start the database migration in the current maintainability pass. Complete file-store
hardening and gather compatibility fixtures first. Re-evaluate when cross-process lost-update
protection or multi-record launch consistency becomes a release requirement, or when the supported
Node baseline provides an acceptable SQLite path.

At that point, proceed with a hybrid SQLite design: move jobs, sessions, attempts, settings,
devices, and leases; keep large outputs and provider-owned data as files. Preserve the public CLI,
API DTOs, persisted semantics, and a tested export-based rollback throughout.
