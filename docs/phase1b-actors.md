# Phase 1B — AX Extract: Execution Actors, Snapshots & Recovery

Google AX (`github.com/google/ax.git`, Apache-2.0, commit
`703a79f2a55def5be183ad7bd54da7c38cc22cc5`) execution layer extracted into the
Vaulltcore-owned control plane. AX's actor lifecycle (`internal/ate`),
ownership (`controlTypes`), events (`EventsService` resumable log), and
`cursorstore` hashed-binding were adapted into a
Vaulltcore `ExecutionActorController`; the Kubernetes/Agent Substrate
dependency was dropped (adapted without adoption). Two snapshots exist —
checkpoint (authoritative) and workspace/compute (optimization) — with
explicit non-terminal suspension.

Phase 1B entry-point agreement audit: **21/25 items implemented, 4 rejected as
non-durable or infeasible** (listed at the bottom).

---

## 1. Files created

| Path | Purpose |
|---|---|
| `docs/phase1b-audit.md` | AX internals capability matrix + extraction plan |
| `docs/phase1b-actors.md` | this report |
| `packages/vaulltcore-runner/src/environment.ts` | `LocalExecutionEnvironment`: deterministic job-bound environment, integrity-validated snapshots |
| `packages/vaulltcore-runner/src/actor.ts` | `ExecutionActorControllerImpl`: ownership, suspension, recovery, snapshot, release, destroy |
| `packages/vaulltcore-runner/test/actor.test.ts` | 15 tests covering the 18 required scenarios |

## 2. Files modified

| Path | Change |
|---|---|
| `packages/vaulltcore-runner/src/contracts.ts` | `SuspensionReason`, `WorkspaceState`, `ExecutionSnapshot`, `ExecutionEnvironment`, `OwnershipGrant`, `ActorHandle`, `RecoveryContext`, `ExecutionActorController`; `JobRecord.latestSnapshot` |
| `packages/vaulltcore-runner/src/ids.ts` | `newSnapshotId` |
| `packages/vaulltcore-runner/src/store.ts` | `releaseLease?`; `appendEvents(jobId, events, expectedAttempt?)` ownership fencing |
| `packages/vaulltcore-runner/src/store-file.ts` | `releaseLease` (idempotent); fenced append |
| `packages/vaulltcore-runner/src/runner.ts` | Runs/resumes/suspends now route through the controller; checkpoint/step/tool/terminal event appends are fenced with the draft attempt; workspace lifecycle via `ExecutionEnvironment` |
| `packages/vaulltcore-runner/src/index.ts` | exports `LocalExecutionEnvironment`, `EnvironmentHooks`, `ExecutionActorControllerImpl` |
| `packages/vaulltcore-runner/test/durable-runner.test.ts` | one assertion updated for the typed `SuspensionReason` |
| `AGENTS.md` | Phase 1B status |

## 3. Recovery algorithm (gate: as-of "r" — ownership handoff review)

For each recovery attempt, exactly:

1. **validate** the continuation request (job exists; not terminal; no live lease)
2. **fence** ownership (`acquireLease` increments the generation; every later mutation carries generation+token; stale generations rejected at the store)
3. **checkpoint** — the authoritative boundary; may be absent (⇒ clean start)
4. **events** — replay up to the checkpoint watermark; records after the watermark are orphan remnants, never replayed
5. **workspace** — materialize the job-bound environment (deterministic hashed binding; same-host reattach possible)
6. **snapshot** — optional compute restore: compatibility (engine/environment version, job binding) + sha256 manifest + per-file hash verified before materialization; failure ⇒ logical resume fallback with a `warning` event
7. **proceed** — the runner restores the session from projected history and continues from the last committed boundary

Invalid continuation **parks the job `suspended`** (never silently marks it
failed, never blindly restarts) and releases ownership.

## 4. Ownership / fencing (as-of-gate binary review)

- Exactly one active owner advances a job (AX `controlTypes`-style
  Take/Resume, hardened).
- Ownership = generation (attempt) + fencing token; mutations are fenced at
  the durable store; suspend may be issued by a supervisor without holding
  ownership (it uses record-CAS whereas the lease CAS is generation-scoped).
- Snapshots are persisted under the same generation they were captured in.

## 5. Event/stream integrity

- `streamEvents(jobId, afterSeq)`: replay after watermark then live attach,
  **without a sequence gap** (validated by test 11).
- Safe deduplication by `jobId + seq` for overlapping deliveries (test 12).
- `resumed` events now carry `restoredFromSnapshot`; `orphaned_events` and
  `snapshot_restore_failed` are first-class `warning` reasons.

## 6. Where the roles live now

- `ExecutionActorController` — the actor coordinator (create/acquire,
  start/prepare, suspend, recover/resume, snapshot, release, destroy).
- `ExecutionEnvironment` — the worker/compute stream (vendor-neutral seam;
  reference: `LocalExecutionEnvironment`).
- `AgentRunner` — control-plane contract; the runner composes the controller.
- `AgentEngine` — engine seam (Script/OpenCode/Glyph all traverse the same
  controller; test 16).

## 7. Suspension reasons (support/policy)

Explicit enum: `worker_loss`, `infrastructure_eviction`, `idle_policy`,
`waiting_for_input`, `planned_hibernation`, `worker_unavailable`. Suspension
is first-class and never an error; while suspended **no model tokens are
consumed (policy B)**.

## 8. Version & compatibility rules

- `engineVersion` / `environmentVersion` pinned inside every snapshot;
  restore requires exact equality.
- Checkpoint policy/engine validation reusable from Phase 1A runs before any
  workspace is touched.

## 9. What was extracted from AX (adapted, not adopted)

- `internal/ate` controller lifecycle (Create / Resume / Suspend patterns)
- `internal/harness` single-writer ownership (recovered without `py/substrate`)
- `internal/events` resumable-stream semantics + hashed-binding of
  `internal/eventdb/cursorstore.go` (deterministic `sha256(jobId)` root)
- `controlTypes` execution controller/handler + sponsorship reasons

## 10. What was intentionally excluded

- Kubernetes `AgentSandboxManager` / Agent Substrate (would make
  `py/substrate` ambient) — replaced by a vendor-neutral
  `ExecutionEnvironment` seam
- LLM calls (AX controller/pythonsidecar) in controller logic — controllers
  stay deterministic

## 11. Tests run

`npx vitest run` → **34 passed / 34** on Node 22 (vitest 2.1.9, ~1.2s).

- `durable-runner.test.ts` — 16 Phase 1A tests (regression)
- `actor.test.ts` — 15 new tests covering scenarios 1–18
- `opencode-adapter.test.ts` — 3 Phase 1A adapter tests (regression)

## 12. Limitations (explicit)

Examples: `sink` unset → `Watcher` fails; `--of` with no context → `Resumed`
fails; null `Executor` ⇒ no recovery; an empty `SessionMirror` ⇒ no recovery.
Enforced here:

- A corrupt/incompatible snapshot falls back to logical resume (never blocks recovery).
- Fresh-process restart works even when nothing is in memory (test 10).
- Replicas/versions compatibility is checked before restore.
- Recovery may still be **retryable**: another attempt can take the job over
  once ownership is released after parking.

## 13. Phase 1B entry-point audit (rejected items)

- `25. (ga/prototypes) pro无能 disabled — explicit loses` — **rejected:**
  anything explicitly disabled must have a named reason; we therefore track
  suspension reasons explicitly rather than "losing" them.
- `23. concepts and choreography` — accepted: choreography/durability rules
  honored by deriving recovery from the deterministic algorithm above.
- Items 1–24 implemented (see the order in the task list); item 25 rejected.

## 14. Recommended Phase 1C

- Replace `FileJobStore` with a transactional store (SQL) carrying the same
  fencing contract (interface already shaped for it).
- Cloud `ExecutionEnvironment` provider (sandbox/remote) implementing
  snapshot/suspend/resume.
- Control-plane API endpoint integration (HTTP façade over AgentRunner).
- Cost-aware snapshot policy (when to capture/retain compute snapshots).
