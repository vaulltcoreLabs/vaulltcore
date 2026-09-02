# Vaulltcore — Phase 1A: Foundation Extraction + Durable Job Resumption

Status: **complete**. All gate tests pass (`19 passed`, 2 suites), `tsc --build` clean.

## 1. Files created

```
package.json
tsconfig.base.json
docs/phase1a.md
packages/vaulltcore-runner/
  package.json
  tsconfig.json
  src/contracts.ts      — neutral contracts: AgentRunner, Job, JobCheckpoint, JobEvent,
                          JobMetrics, ExecutionPolicy, Workspace, ResumeState, AgentEngine,
                          ModelProvider-side tool types, lifecycle vocabulary
  src/ids.ts            — ascending ID generator (extracted from OpenCode, MIT)
  src/errors.ts         — typed errors (LeaseFencedError, InvalidCheckpointError, ...)
  src/checkpoint.ts     — canonicalization, SHA-256 checksums, resume-time validation
  src/store.ts          — DurableJobStore interface
  src/store-file.ts     — file-backed store: append-only JSONL events, atomic writes, lease CAS
  src/workspace.ts      — WorkspaceProvider + LocalWorkspaceProvider + env scrubbing
  src/engine.ts         — projectHistoryFromEvents + ScriptEngine (deterministic proof engine)
  src/runner.ts         — DurableAgentRunner: state machine, commit boundaries, settlement,
                          idempotency, cancellation, event replay
  src/index.ts
  test/durable-runner.test.ts — 16 tests (the 11 required scenarios + env/admission extras)
packages/vaulltcore-runner-opencode/
  package.json
  tsconfig.json
  src/kernel/llm.ts     — extracted OpenCode LLM kernel shapes (MIT attribution)
  src/kernel/normalize.ts — fine-grained LLM events → neutral EngineTurnEvent mapping
  src/model-provider.ts — ModelProvider registry + ScriptModelProvider (stateless, state-driven)
  src/opencode-engine.ts — OpenCodeEngine (AgentEngine implementation)
  src/index.ts
  test/opencode-adapter.test.ts — 3 tests through the real adapter seam
README.md
NOTICE.md
```

## 2. Files modified

None — the Vaulltcore repository was an empty git repo; this is its initial content.
`anomalyco/opencode` was shallow-cloned to `/tmp` for study only; **no fork, no full-repo copy** made.

## 3. Architecture

Two packages with a hard seam between them:

- **`@vaulltcore/runner`** (neutral): the control-plane contract (`AgentRunner`), the
  `DurableAgentRunner` orchestrator, the `DurableJobStore` boundary (with a file-backed
  implementation), checkpoint schema + validation, workspace abstraction, and the
  `AgentEngine` interface. It never names an OpenCode type; engines are replaceable.
- **`@vaulltcore/runner-opencode`** (adapter): the extracted minimal OpenCode kernel
  (LLM wire shapes, fine-grained event vocabulary, normalization), the `ModelProvider`
  boundary (one provider turn per step, mirroring OpenCode's `llm.stream(request)`), and
  `OpenCodeEngine` which implements `AgentEngine`.

The runner owns durability: the engine streams one provider turn; the runner commits the
turn atomically, records tool calls **before** execution, settles them with idempotency
checks, and checkpoints at each boundary. The engine only ever sees neutral types.

```
control plane → AgentRunner (DurableAgentRunner)
                ├─ DurableJobStore (events.jsonl + job.json + checkpoint.json)
                ├─ AgentEngine (opencode | script | future)
                │    └─ ModelProvider (one provider turn per step)
                └─ WorkspaceProvider (local now, sandbox/cloud later)
```

## 4. Job state machine

```
queued → leased → preparing → running ⇄ checkpointing
   ↼ (restart from step when no checkpoint exists)
running/checkpointing → suspended   (worker loss via supervisor `suspendJob`,
                                     or resume refusal — non-terminal, resumable)
suspended → resuming → running
running → completed | failed | cancelled   (terminal)
```

Transient worker loss becomes **`suspended`** (never silently `failed`). Terminals are
`completed`, `failed`, `cancelled`. Lease fencing: every mutation carries the attempt
number; a stale writer fails with `LeaseFencedError`.

## 5. Checkpoint schema and continuation algorithm

Schema (`JobCheckpoint`, checksummed with SHA-256 over canonical JSON):

- `jobId`, `tenantId`, `orgId`, `projectId` — identity (immutable)
- `executionId` — durable session identity across attempts
- `status`, `attempt` — lifecycle + fencing token
- `lastEventSeq` — committed watermark
- `lastCompletedStep` — `{stepIndex, finishedAt}`
- `toolCalls` — idempotency table keyed by `${stepIndex}:${toolCallId}` with
  `recorded | completed{resultSeq} | uncertain{reason}`
- `pendingInput` — admitted input not yet answered by an assistant turn (projection summary)
- `continuation` — `provider_turn{nextStepIndex} | settle_tools{stepIndex, pendingToolCallIds} | done`
- `contextRef` — `{kind:"event_projection", throughSeq}`
- `usage` — cumulative `JobMetrics`
- `policyVersion`, `engineVersion`, `createdAt`, `checksum`

Continuation algorithm on `resumeJob`:

1. Record must exist, be non-terminal, not cancel-requested, lease free/stale.
2. Acquire lease (attempt+1); status `resuming` → `running`.
3. No checkpoint → restart from step 0 (nothing was ever committed).
4. Otherwise: load committed events ≤ watermark, **validate** (checksum, identity,
   policy/engine version, watermark ≤ log, tool table cross-referenced against committed
   `tool_response` events, continuation well-formed). Any violation → `InvalidCheckpointError`,
   job left `suspended` for inspection. Events past the watermark are orphaned in-flight
   remnants → logged as `warning`, never replayed.
5. Engine history = projection of committed events; settle `settle_tools` (reuse committed
   results, reconcile recorded-but-unsettled calls per policy), then continue with the
   next provider turn.

## 6. Resume guarantees and limitations

Guarantee achieved: **at-least-once with idempotent settlement** (not exactly-once).

- Completed deterministic work: never rerun (step watermark + executionId).
- Committed tool results: reused, not re-executed (`resultSeq` cross-validated).
- Recorded-but-unsettled tool call after a crash: **not blindly duplicated**.
  Default policy `mark_uncertain` commits an explicit uncertain (error) result;
  `fail_job` halts for operator reconciliation; tools marked `idempotent` (in both the
  tool definition and the policy) may be re-executed with the same idempotency key.
- Stale/corrupt/policy-drifted/identity-mismatched checkpoints: rejected, job suspended.

Limitations (honest list):

- A provider turn is committed atomically at finish; a crash mid-turn loses the
  uncommitted turn (no incremental text persistence yet).
- Cannot distinguish "recorded but never executed" from "executed with unknown outcome";
  both are treated as uncertain (conservative, safe).
- The file store is single-node; multi-writer coordination needs the Phase 1B
  transactional store (the fencing interface is already shaped for it).
- Workspace snapshot/restore exists but is not wired into checkpoints; resume re-prepares
  an empty workspace.
- `streamEvents` live-follow is single-process (same-process pub/sub).

## 7. Event model and replay

Every event: `{ jobId, seq, timestamp, type, data }` with per-job monotonic `seq` from 1.
Stable vocabulary: `queued, started, resumed, checkpoint, message, tool_request,
tool_response, usage, warning, error, completed, cancelled`. Terminal failure is
`error` with `data.terminal === true`. OpenCode's fine-grained LLM event vocabulary
(step-start, text-delta, tool-input-*, step-finish, provider-error) never enters the job
log — the adapter normalizes it.

`streamEvents(jobId, afterSeq, signal?)`: replays durable events with `seq > afterSeq`,
then follows live until a terminal event or abort; terminal state remains authoritative
via `getJobState`.

## 8. OpenCode components actually reused

Studied: `packages/core` (SessionRunner/SessionExecution), `packages/llm`,
`packages/schema`, `packages/opencode` (bus) from `anomalyco/opencode@dev`.

- `packages/schema/src/identifier.ts` — adapted as `vaulltcore-runner/src/ids.ts` (MIT).
- `packages/llm` schema-first message/event/abstraction shapes — re-expressed without the
  Effect runtime in `runner-opencode/src/kernel/llm.ts`; the `ModelProvider.stream`
  boundary mirrors `llm.stream(request)` ("one provider turn per step").
- SessionRunner durable step design — commit-boundary discipline ("record each tool call
  before side effects begin", settle then continue) implemented by `DurableAgentRunner`.
- SessionPending admitted-input semantics — `submitInput` + next-boundary drain; admitted
  input reaches the subsequent provider turn (adapter test proves it).
- Projector/history concepts — `projectHistoryFromEvents` (events ≤ watermark → messages).
- Bus/replay concepts — append-only per-job log with monotonic seq + `streamEvents` replay.
- Permission concepts — programmatic `ExecutionPolicy.allowedTools` gate (no interactive
  permission waiting).

## 9. OpenCode components intentionally excluded

No OpenCode repository fork; no TUI/desktop/web/console/marketing code; no PTY or
interactive terminal infrastructure; no shared-password server auth; no tenant plugin
loading; no tenant local-command MCP; no plaintext credential storage. The runner package
has zero runtime dependencies.

## 10. Tests run and results

`npx vitest run` → **19/19 passing** in 2 suites; `npx tsc --build` → clean. Real code
paths only; no mocks.

Core (`durable-runner.test.ts`, 16):
1. start + durable progress on disk ✓
2. multi-step with committed tool settlement ✓ (+env-scrub test)
3–6. crash after committed step → fresh runner instance → resume → completed steps not rerun ✓
7. committed results reused; non-idempotent → `uncertain`; idempotent → safe re-execution ✓
8. `streamEvents(afterSeq)` replay + live-follow ✓
9. cancellation prevents continuation; resume on cancelled is a no-op ✓
10. bad checksum / watermark-beyond-log / policy drift / engine drift → rejected ✓
11. checkpoint identity mismatch → `IdentityMismatchError`; record identity immutable ✓

Adapter (`opencode-adapter.test.ts`, 3): fine-grained-event normalization through the
seam; crash + resume end-to-end; admitted-input reaching the provider.

## 11. Known blockers

- Multi-worker lease safety requires the transactional store (single-node only today).
- No real LLM provider adapter (network integration deliberately deferred; provider seam
  + deterministic provider prove the pipeline).
- Workspace snapshot not yet referenced from checkpoints.
- Resume re-prepares an empty workspace (contents not snapshotted every boundary by design).

## 12. Recommended Phase 1B

1. Transactional `DurableJobStore` (Postgres/`effect-sqlite`-style CAS) + multi-worker lease.
2. Real provider adapters behind `ModelProvider` (OpenAI-compatible HTTP; schemas borrowed
   from `packages/llm` providers) with secret scoping (explicit env only).
3. Incremental turn persistence (streamed text/reasoning deltas as durable marker events).
4. Workspace snapshot references in checkpoints + sandbox provider integration.
5. Compaction/history trimming hooks (OpenCode `SessionCompaction` concept) under policy.
6. Control plane: job queue, supervisor (auto-suspend on lease expiry), retry/backoff policy,
   per-tenant isolation at the store layer, metrics/telemetry on JobMetrics.
7. Structured output / tool schema hardening and the permission-policy SDK surface.
