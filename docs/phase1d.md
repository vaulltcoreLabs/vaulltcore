# Phase 1D — Distributed Control Plane & Production Worker Boundary

Status: **COMPLETE**. 116/116 tests green (`npm test`); `npm run typecheck` clean.

The durable single-process foundation from Phases 1A–1C is now a safely
distributed system. The HTTP process is never the long-running job owner;
control-plane processes and execution workers can restart independently
without losing job correctness, and two owners can never advance the same
job or cause committed work to run again.

## The Phase 1D rule, proven

```
running → heartbeat expires → lease no longer renewable → suspended(worker_loss)
       → recovery eligible → fresh worker acquires new generation
       → validate checkpoint → restore snapshot OR logical resume
```

No work is silently marked failed because infrastructure disappeared.

## Deliverables

### 1. Durable SQL idempotency

`packages/vaulltcore-store-sql/src/registries.ts` — `SqlIdempotencyRegistry`
replaces the in-memory registry over the `idempotency_records` table:
`UNIQUE(tenant_id, idempotency_key)`. Same tenant+key+hash → original job;
same tenant+key+different request → `IDEMPOTENCY_CONFLICT`; different tenants
share keys freely. Record creation and job creation are transactional.
Wired into the control plane (`packages/vaulltcore-control/src/idempotency.ts`).

### 2. PostgreSQL JobStore conformance

`packages/vaulltcore-store-sql/src/pg-store.ts` — `PostgresJobStore` over the
`pg` driver. `SERIALIZABLE` transactions + `FOR UPDATE` row locks; int8 parsed
as JS numbers; fenced CAS on every state-changing write. The same behavioral
contract is testable against FileJobStore / SqliteJobStore / PostgresJobStore.
Proved against a live PostgreSQL 17 server in
`packages/vaulltcore-store-sql/test/postgres-conformance.test.ts` (8 tests):
separate-connection fencing, concurrent-transaction single owner, rollback
leaves no partial boundary, event uniqueness across concurrent writers,
stale-owner release rejected, job-not-found typing, duplicate-seq rejection.

### 3. JobDispatcher seam

`packages/vaulltcore-runner/src/dispatcher.ts` — neutral `JobDispatcher`
(enqueue/claim/acknowledge/heartbeat/release). The dispatcher decides where
work goes; the runner decides how work executes. Three implementations:
`LocalDispatcher` (in-process), `SqlDispatcher` (SQLite), `PostgresDispatcher`
(`pg-migrations.ts` schema, fenced claim/heartbeat/release).

### 4. Worker identity, lease renewal, heartbeat

`packages/vaulltcore-worker/` — `WorkerHost`, `WorkerIdentity`,
`WorkerHeartbeat`, fenced `WorkerLease`. The worker renews both its dispatch
claim and its execution lease on a heartbeat; lease renewal is itself fenced
(an old worker waking after a partition cannot reclaim authority — generation
N−1 can never write once generation N is committed).

### 5. Worker loss recovery

`packages/vaulltcore-worker` `JobReconciler` identifies `running|leased|preparing`
+ expired-lease jobs and transitions them to recovery eligibility
(`RecoveryEligibilityReason = "orphaned"`, added to
`packages/vaulltcore-runner/src/distributed.ts`). The recovery sequence
preserves all Phase 1A/1B rules: validate identity → acquire new fenced
ownership → load authoritative checkpoint → discard orphan progress →
validate workspace binding → validate snapshot → native restore when valid,
otherwise logical resume. Uncertain non-idempotent tool calls remain
uncertain — recovery never blindly reruns them.

### 6. Control plane / worker deployment split

`packages/vaulltcore-control` owns auth/tenancy/API/idempotency/durable
metadata/dispatch. `packages/vaulltcore-worker` owns execution/AgentRunner/
actor/environment/engine/workspace/checkpoint progression. The worker does
not require the HTTP server to stay alive. Proved in
`packages/vaulltcore-control/test/deployment-boundary.test.ts` (3 tests):
control-plane restart does not kill a worker-owned job; worker restart does
not lose the durable job; events remain replayable after either restarts.

### 7. First real CloudExecutionProvider

`packages/vaulltcore-environment-docker/` — `DockerCloudProvider` over the
Docker Engine. One provider only. Sandboxes are job-bound containers with
explicit resource limits, an allow-listed environment (no host `process.env`
leakage), and `docker pause`/`commit`/`run <image>` for native suspend /
snapshot / restore. Honest capability reporting: `nativeSuspend` /
`nativeSnapshot` / `nativeRestore` = true, `durableWorkspace` = false (only a
committed image survives container removal). Proved against a real Docker
daemon in `packages/vaulltcore-environment-docker/test/docker-provider.test.ts`
(7 tests), including a native snapshot→restore round-trip that materializes
workspace state and an `inspectSnapshot` of a missing image throwing
`CapabilityUnsupportedError`.

### 8. Snapshot lifecycle management

`packages/vaulltcore-store-sql/src/registries.ts` — `SqlSnapshotRegistry`
over the `snapshots` table with lifecycle states
(created/active/superseded/expired/deleting/deleted/failed) and metadata
(snapshotId, tenantId, jobId, sizeBytes, createdAt, expiresAt, provider,
integrityHash). Conservative GC: **a superseded snapshot is collected only
once its replacement is `active`** (not merely `created`) — the last valid
recovery artifact is never deleted before its replacement is durably
committed. Proved in `packages/vaulltcore-store-sql/test/idempotency-snapshot.test.ts`
(11 tests).

## Required scenarios (23) — all green

**Distributed ownership** (`packages/vaulltcore-worker/test/distributed-ownership.test.ts`, 11 tests):
two workers compete (one wins); network-delayed stale worker fenced; stale
heartbeat cannot renew; new generation survives old worker restart; worker
cannot release another generation's lease; worker-loss detection; committed
tools not rerun; uncertain non-idempotent calls remain unresolved; corrupt
snapshot falls back logically; expired worker cannot overwrite recovered
progress; recovery resumes committed progress.

**Idempotency** (`idempotency-snapshot.test.ts`): crash after job creation
before response; retry returns original job; same key + changed request
rejected; tenant isolation; idempotency survives process restart.

**PostgreSQL** (`postgres-conformance.test.ts`): separate connections
preserve fencing; concurrent transactions preserve one owner; rollback
leaves no partial checkpoint; event uniqueness survives concurrent writers.

**Recovery**: covered across distributed-ownership + deployment-boundary.

**Deployment boundary** (`deployment-boundary.test.ts`): control plane
restart does not kill worker-owned job; worker restart does not lose durable
job; events remain replayable after either restarts.

## Test totals

116 tests (76 original + 40 new) across 12 files:
durable-runner 16, actor 15, sql-store 14, distributed-ownership 11,
idempotency-snapshot 11, postgres-conformance 8, docker-provider 7,
cloud-environment 9, snapshot-policy 9, control-plane 10,
deployment-boundary 3, opencode-adapter 3.

## Invariants that must not regress

- The HTTP process is never the long-running job owner; a request only
  transactionally persists job + idempotency record then dispatches.
- Lease renewal is fenced: generation N−1 can never write once generation N
  is committed, even across separate connections / a network partition.
- The `(job_id, seq)` PRIMARY KEY + monotonic `last_seq` reject duplicate
  event delivery; orphan events beyond the checkpoint watermark never replay
  as committed history.
- Recovery never blindly reruns uncertain non-idempotent tool calls.
- A superseded snapshot is collectible only when its replacement is `active`;
  the last valid recovery artifact is never deleted before its replacement is
  durably committed.
- Capability honesty: `DockerCloudProvider` reports `durableWorkspace=false`
  and throws `CapabilityUnsupportedError` for a missing image rather than
  emulating a snapshot; the runner falls back to logical resume.
- Control plane derives tenant from the authenticated principal, never the
  request body; the worker requires no live HTTP server.

## Next: Phase 1E

Business layer: quotas, billing/metering, audit trails, organization/project
management, production-grade B2B policy controls.

## Running the gated tests

PostgreSQL and Docker tests are environment-gated (skipped, not failed, when
the service is unavailable) so CI without them stays green:

```bash
# PostgreSQL (unix socket /tmp/pgsock:5434, db vaulltcore_test by default)
PG_TEST_HOST=/tmp/pgsock PG_TEST_PORT=5434 PG_TEST_DB=vaulltcore_test npm test

# Docker (use a privilege prefix when the daemon needs it)
DOCKER_CMD="sudo -n docker" npm test
```
