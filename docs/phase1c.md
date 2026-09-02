# Vaulltcore — Phase 1C: Production Durability & Cloud Execution

Phase 1C adds the first production-oriented persistence and cloud execution
layer on top of the Phase 1A/1B durable-execution foundation. Nothing about the
existing contracts was weakened: the runner still owns the lifecycle, the store
still owns fencing, and the environment still owns compute materialization.

## 1. Architecture

```
Control Plane (packages/vaulltcore-control)
     │  HTTP + SSE, authenticated principal, idempotency registry
     ▼
AgentRunner (packages/vaulltcore-runner)
     │  DurableAgentRunner lifecycle: create/run/resume/cancel/suspend/input
     ▼
ExecutionActorController
     │  single authoritative execution owner (generation + fencing token)
     ▼
 ┌───────────────┬────────────────┬────────────────────────┐
 ▼               ▼                ▼                        ▼
JobStore     ExecutionEnvironment    AgentEngine      SnapshotPolicy
File / SQL   Local / Cloud (fake)    OpenCode/etc     threshold-based
```

`DurableAgentRunner` depends on none of: SQL, HTTP, Docker, Kubernetes, or any
cloud vendor. Those are all behind the existing Phase 1A/1B seams.

## 2. SQL schema and ownership/fencing invariants

`packages/vaulltcore-store-sql` (driver-abstracted; SQLite driver shipped,
PostgreSQL boundary explicit through the `SqlDialect` seam).

```sql
jobs              (job_id PK, tenant_id, org_id, project_id, status, attempt,
                   cancel_requested, error, spec JSON, env JSON, policy JSON,
                   latest_snapshot JSON, last_seq, created_at, updated_at)
job_events        (job_id, seq, timestamp, type, data JSON,
                   PRIMARY KEY (job_id, seq))
job_checkpoints   (job_id PK, checkpoint JSON, watermark)
job_snapshots     (job_id, snapshot_id, snapshot JSON, created_at,
                   PRIMARY KEY (job_id, snapshot_id))
job_leases        (job_id PK, token, generation, expires_at, acquired_at)
schema_migrations (version PK, applied_at)
```

Ownership/fencing invariants preserved from Phase 1A/1B:

- Exactly one authoritative active owner per job.
- `acquireLease` is conditional: a live lease held by another token rejects
  with `LEASE_HELD`; stealing is allowed only after expiry or after an
  explicit release.
- `attempt` (the fencing token) is monotonic per job; every state-changing
  write path (`updateJobRecord`, `appendEvents`, `saveCheckpoint`) takes
  `expectedAttempt` and CAS-updates on it. A stale writer gets
  `LeaseFencedError` and can append nothing.
- `releaseLease` is keyed on the token: a stale token is a no-op and can
  never clear a newer owner's lease.
- Snapshot attachment and record pointer update happen in the same
  transaction (`updateJobRecord` writes `job_snapshots` + `jobs` atomically).

## 3. Authoritative continuation boundary

A continuation boundary is checkpoint + event updates committed atomically.
`SqlJobStore.atomic()` wraps every state-changing operation in
`BEGIN IMMEDIATE … COMMIT`. If anything inside the boundary fails (or a test
fault-injection hook fires), the whole transaction rolls back: no partial
authoritative progress is ever observable. The file store keeps its existing
atomic-file semantics; the SQL store matches them transactionally.

## 4. Orphan-event handling

Events beyond the authoritative checkpoint watermark are orphaned by
definition (an in-flight worker crashed before the next checkpoint). They are
kept in `job_events` (append-only storage), but recovery projects **only**
events with `seq <= watermark` into committed history. The runner emits a
`warning` event with `reason: "orphaned_events"` naming the watermark so the
orphans remain observable without ever becoming replayable history. The store
itself refuses to guess: it never repairs the log silently, it never reuses a
sequence number (duplicate `(job_id, seq)` is a hard PRIMARY KEY violation
surfaced as `EVENT_SEQ_CONFLICT`).

## 5. Cloud environment capability model

`packages/vaulltcore-environment-cloud` adds:

- `CloudExecutionProvider` — vendor-neutral remote compute seam:
  `provision`, `start`, `execute`, `stream`, `suspend`, `resumeSandbox`,
  `snapshot`, `restore`, `inspectSnapshot`, `terminate`, `inspect`, plus a
  capability report.
- `CloudExecutionEnvironment` — the Phase 1B `ExecutionEnvironment` contract
  implemented over a provider. Sandbox names are `vaulltcore-<sha256(jobId)>`,
  so any fresh process reattaches deterministically.
- `FakeCloudProvider` — deterministic in-memory reference provider for tests.
  No cloud credentials required.

Capabilities are explicit and honest:

```ts
ExecutionCapabilities {
  nativeSuspend: boolean
  nativeSnapshot: boolean
  nativeRestore: boolean
  durableWorkspace: boolean
}
```

Calling an unsupported operation throws `CapabilityUnsupportedError`. A
logical checkpoint is never presented as a VM snapshot.

## 6. Native snapshot vs logical checkpoint

- **Logical checkpoint** (durable): checksum-stamped continuation state in the
  store. Always authoritative. Written at every commit boundary regardless of
  any snapshot decision.
- **Compute snapshot** (optimization): a captured sandbox/workspace image.
  Optional; used only to restart compute faster. `restore` re-validates
  binding (sandbox name ⇐ jobId) and integrity (sha256 tag over jobId,
  sandbox name, payload checksum, engine version, environment version) before
  materializing. A corrupted or cross-tenant snapshot fails closed and falls
  back to logical resume.

## 7. Recovery algorithm

The Phase 1B algorithm is unchanged and remains authoritative:

```
validate → acquire fenced ownership → checkpoint → events/watermark →
workspace validation → snapshot compatibility/integrity →
native restore if valid → otherwise logical resume
```

A cloud snapshot is an optimization layer on top of that algorithm, never the
sole source of recoverability. A fresh runner with zero in-memory environment
state recovers correctly from the store + provider alone.

## 8. HTTP API and authentication seam

`packages/vaulltcore-control`:

| Route | Behavior |
| --- | --- |
| `POST /jobs` | Creates a job; requires `Idempotency-Key` header. |
| `GET /jobs/:jobId` | Resource view (status, usage, pending input, identity). |
| `GET /jobs/:jobId/events?after=<seq>&follow=true` | `follow=false`: bounded replay. `follow=true`: SSE (`event: job-event`, terminal `event: done`). |
| `POST /jobs/:jobId/cancel` | Delegates to `AgentRunner.cancelJob`. |
| `POST /jobs/:jobId/input` | Delegates to `AgentRunner.submitInput`. |
| `GET /jobs/:jobId/usage` | Delegates to `AgentRunner.collectUsage`. |

Authentication is a replaceable boundary (`ControlAuthenticator`). Route
handlers receive an authenticated principal; the request body's `tenantId` is
never trusted. The default test authenticator reads `x-vc-tenant`/`x-vc-org`
/`x-vc-project` headers; production would swap in JWT/mTLS/SSO.

## 9. Idempotency semantics

`POST /jobs` requires an `Idempotency-Key` header. The key is scoped by the
authenticated tenant identity: the same tenant repeating the same key gets
HTTP 200 with the original job's view; a different key creates a new job; the
same key under a different tenant is independent. The registry is injectable
(`InMemoryIdempotencyRegistry` default; a SQL-backed registry drops in without
route changes).

## 10. Cross-tenant isolation rules

Every job-scoped route resolves the job through `runner.getJob` first and
compares the durable record's `tenantId` with the authenticated principal.
Mismatch (or unknown id) returns 404 — cross-tenant access exposes no data
and no existence signal beyond what the unauthenticated surface already shows.
The façade never inspects OpenCode session internals; it only calls the
`AgentRunner` contract.

## 11. Snapshot cost model

`ThresholdSnapshotPolicy` (in `@vaulltcore/runner`, neutral contract):

```
facts → decide(facts) → { decision, reason, estimate }
decision ∈ snapshot_now | defer | skip | logical_checkpoint_only
```

Facts: elapsed execution time, steps since last snapshot, cumulative tokens,
precomputed model cost (or tokens × configurable price), workspace size, last
snapshot cost/duration, provider capabilities, suspension risk. Rule order:
missing capability → `logical_checkpoint_only`; fresh snapshot and too few
steps → `defer`; resume value below cheap-job floor → `logical_checkpoint_only`;
resume value at/above the (eviction-discounted) threshold → `snapshot_now`;
otherwise `skip`.

The policy is advisory. Checkpoint persistence follows the durable execution
rules regardless of the decision; a snapshot decision can never block,
replace, or suppress a checkpoint. Every decision is emitted as a sanitized
`warning` event with `reason: "snapshot_decision"` — no prompts, no env
values, no secrets.

## 12. Guarantees and non-guarantees

Guaranteed: at-least-once execution with idempotent settlement; committed
steps are never re-executed; uncertain non-idempotent tool calls are never
blindly re-executed; invalid continuations park `suspended`, never silently
fail; monotonic per-job event sequence; duplicate `(job_id, seq)` rejected;
orphan events never replay as committed history; fencing on every
state-changing write; per-job explicit environment (never ambient
`process.env`); immutable tenant identity; no secrets in events/checkpoints/
API responses/snapshot metadata.

Not guaranteed: exactly-once execution; snapshot correctness without integrity
validation (we validate); cross-store migration; horizontal lease handoff
liveness (a crashed worker's lease expires or is released by the supervisor
before takeover).

## 13. Components reused from Phase 1A/1B (unchanged)

`DurableAgentRunner` lifecycle and loop; `FileJobStore`; `AgentEngine` seam
(+ ScriptEngine); commit-boundary protocol; orphan-warning behavior;
`ExecutionActorController` and its recovery algorithm;
`LocalExecutionEnvironment`; ownership/fencing contract on `DurableJobStore`;
the entire Phase 1A/1B test suite (34 tests, all passing).

## 14. Components intentionally not implemented

Real cloud providers (Fly/E2B/Cloudflare/Docker/Kubernetes adapters);
PostgreSQL driver (dialect seam + migrations structure exist; only SQLite
shipped); WebSocket transport (SSE suffices); control-plane rate limiting and
quota accounting; snapshot lifecycle garbage collection; distributed scheduler.

## 15. Blockers

None.

## 16. Recommended Phase 1D

1. SQL-backed idempotency registry + `idempotency_keys` table migration.
2. A real `CloudExecutionProvider` behind the existing seam (one vendor, thin).
3. PostgreSQL dialect validation in CI (the `SqlDialect` seam is ready).
4. Durable control-plane deployment topology (control plane + worker split).
5. Snapshot lifecycle GC + cost telemetry feeding the snapshot policy.
