# Phase 1F — Production Operations, Distributed Idempotency, Reconciliation & Economic Enforcement

Phase 1F makes Vaulltcore safe to operate across multiple API instances, API/worker/settlement
crashes, database reconnects, retries, concurrent requests, long-running jobs, stale reservations,
and partial metering/billing pipelines. The execution kernel (Phases 1A–1E) is **closed** for this
phase: no business logic was placed into `AgentRunner` internals or OpenCode-derived engine code.
Phase 1F improves operational durability and economic correctness **around** the kernel.

**Status:** COMPLETE. With the gated services provisioned (PostgreSQL server on
`/tmp/pgsock:5434` + Docker daemon), the full suite runs **green: 175 passed, 0 skipped, 0 errors,
0 warnings** (the Node `node:sqlite` `ExperimentalWarning` is suppressed via the `test` script's
`NODE_OPTIONS=--disable-warning=ExperimentalWarning`). Typecheck green. When the services are
absent the gated suites fall back to **honest skips, never false passes**.

---

## 1. Architecture

Dependency direction is preserved exactly as required:

```
Control/API
    ↓
Identity / Authorization
    ↓
Policy / Quota / Admission
    ↓
AgentRunner
    ↓
ActorController
    ↓
ExecutionEnvironment
    ↓
AgentEngine
```

Operational services consume durable events and stores but never reverse this dependency. The
runner never imports billing/reconciliation packages.

### New / extended packages

| Package | Role | New in 1F |
|---|---|---|
| `vaulltcore-store-sql` | SQL stores + migration ledger | durable admission idempotency (v8), snapshot GC (v10), migration-ledger fix |
| `vaulltcore-quota` | reservation state machine | expiry, fenced renewal, idempotent reaper |
| `vaulltcore-metering` | append-only usage events | (unchanged contracts; consumed by reconciliation) |
| `vaulltcore-billing` | pricing + ledger | durable settlement tracking (v11) |
| `vaulltcore-reconcile` | **new** — reconciliation service + store | durable watermark, gap detection, safe repair |
| `vaulltcore-identity` | tenants/orgs/projects/keys | API-key lifecycle (v12): expiry, rotation, last-used |
| `vaulltcore-runner` | execution kernel | runtime budget enforcement (soft `maxTokens`/`maxDurationMs`) |
| `vaulltcore-control` | HTTP façade + admission | distributed idempotency wiring, operational health endpoints |

No duplicate SQL stores, Docker/cloud providers, auth systems, or idempotency implementations were
created. Existing seams (`SqlDatabase`/`SqlDialect`, `SqlStoreBase`, `applyMigrations`) were reused.

---

## 2. Distributed Idempotency Model

### Problem solved

Phase 1E's control plane had an in-memory idempotency registry. Two independent API processes
receiving the same `(tenant, idempotency_key)` concurrently could each admit a job and each reserve
quota — a double admission and a capacity leak.

### Design

`AdmissionIdempotencyRegistry` (interface in `vaulltcore-control/src/admission.ts`) is backed by
`SqlAdmissionIdempotencyRegistry` (`vaulltcore-store-sql/src/admission-idempotency.ts`, migration v8
`admission_idempotency`). The registry is the **linearization point** for admission: it decides
whether a request is new, a legitimate replay, or a conflict — before quota reservation or job
creation.

The critical proof holds: two independent control-plane instances receiving the same
`tenant + idempotency key` concurrently result in **exactly one** job admission and **exactly one**
quota reservation. The `UNIQUE (tenant_id, idempotency_key)` constraint is the serialization point;
`claim()` is a single atomic conditional `INSERT … ON CONFLICT` that either wins the slot or returns
the existing record.

### State machine

```
                    claim (new)
   ┌──────────────────────────────────┐
   ▼                                  │
 pending ──complete──▶ completed      │ (terminal-success: replay returns result)
   │                                  │
   ├──fail(retriable)──▶ failed_retriable ──claim (reclaim)──┘
   │
   └──fail(terminal)──▶ failed_terminal   (terminal: not reclaimable except by TTL)
```

- `pending` — a caller has claimed the slot and is performing the admission transaction.
- `completed` — admission succeeded; the slot stores `job_id` + `reservation_id`. A replay returns
  `kind: "completed"` **without** repeating reservation or job creation.
- `failed_retriable` — a transient failure (e.g. quota temporarily full). Reclaimable by a fresh
  `claim()` that overwrites the slot.
- `failed_terminal` — a permanent failure (e.g. policy rejection, bad request). Not reclaimable
  except by TTL/expiry.

`completed` and `failed_terminal` are terminal; `failed_retriable` and expired records are
reclaimable.

### Request fingerprint rules

`claim(tenantId, key, fingerprint)` stores only a **SHA-256 fingerprint** of the canonical request
identity (engine, model, input hash, requested tools, org/project scope). Secret request material
(the raw input, any credentials) is **never** stored — only the one-way hash.

- Same key + same fingerprint + `completed` → `kind: "completed"` (legitimate replay).
- Same key + same fingerprint + `pending` → `kind: "pending"` (concurrent in-flight request; the
  second caller waits/polls rather than duplicating work).
- Same key + **different** fingerprint → `kind: "conflict"` with a detail string. The admission
  pipeline surfaces this as an explicit **409 rejection**, never a silent replay.

### Admission transaction / compensation boundary

`AdmissionPipeline.admit()` executes:

1. `claim()` the idempotency slot (durable, atomic).
2. If `completed` → return the stored result immediately (no reservation, no job).
3. If `conflict` → reject.
4. If `new`/reclaimed → authenticate → authorize → `policy.evaluate` → `quota.reserve`.
5. `runner.createJob` (durable).
6. `complete()` the slot with `{jobId, reservationId}`.
7. **Compensation:** if job creation fails after reservation, the reservation is released and the
   slot is marked `failed_retriable` — no capacity leak, no permanent stuck slot.

A crash after step 4 but before step 5 (reserved, no job) is recovered by the reaper (§3). A crash
after step 5 but before step 6 (job created, slot not completed) leaves a `pending` slot; a replay
re-claims it (it is not terminal) and reconciliation will eventually settle the orphaned reservation.

---

## 3. Quota Reservation Expiry & Reaper

### Reservation vs execution lease vs heartbeat

These are **distinct, non-interchangeable** concepts:

| Concept | Owner | Purpose | Lifetime | Renewed by |
|---|---|---|---|---|
| **Admission reservation** | quota store | hold capacity from admission until the job settles | bounded `expires_at` | `renewReservation` (fenced) while the job is not yet terminal |
| **Execution ownership lease** | actor controller / dispatcher | single-writer ownership of a running job | generation + fencing token | worker heartbeat (lease renewal) |
| **Worker heartbeat** | worker host | prove liveness of the owning worker | short TTL | `WorkerHost` heartbeat loop |

A reservation holds **economic capacity** (concurrent-job slots, token budget headroom). An ownership
lease holds **write authority** over job state. A heartbeat proves the **worker** is alive. Losing a
heartbeat suspends ownership (Phase 1A/1D); it does **not** automatically release the reservation,
because the job may still be progressing under a recovered lease. The reservation is released only
when the job reaches a terminal state or its own `expires_at` passes without renewal.

### Expiry algorithm

- Every `active` reservation has a durable `expires_at` (set at `reserve` time, extended by
  `renewReservation`).
- `renewReservation(reservationId, expectedVersion, newExpiresAt)` is **fenced by version**: a stale
  writer (generation N-1) can never extend a reservation that has already been released/settled by
  generation N. Expiration **cannot reclaim capacity from valid progressing work** because a
  progressing job renews before `expires_at`.
- `reapExpired(now)` scans `active` reservations with `expires_at <= now` and releases each. Release
  is fenced by version and idempotent: a reservation already `released`/`settled` is skipped
  (conditional `UPDATE … WHERE state = 'active' AND version = ?`).

### Reaper guarantees

- **Idempotent:** `reapExpired` run twice releases each expired reservation exactly once. The second
  run finds nothing `active` to release (returns 0).
- **Fenced:** a stale reaper cannot release a renewed or settled reservation — the conditional UPDATE
  checks `version`, and a renewed reservation has a new version.
- **No double-release:** `in_use` is decremented only on the `active → released` transition; a
  terminal job whose reservation was already `settled` cannot be reclaimed again.
- **Crash recovery:** a crashed API after reservation but before job creation leaves an orphaned
  `active` reservation; the reaper releases its capacity at `expires_at`.

---

## 4. Reconciliation Architecture

### Authoritative source boundaries

```
Execution / durable JobEvents   ← AUTHORITATIVE (the kernel)
        ↓
     UsageEvents                  ← projection (rebuilt from events; dedup exists)
        ↓
 PricingVersion                  ← immutable history
        ↓
   LedgerEntry                   ← projection (rebuilt from usage + pricing; idempotency exists)
```

JobEvents are the **sole authoritative source**. UsageEvents and LedgerEntries are **projections**
that may be safely rebuilt because their durable identity boundaries already enforce exactly-once
deduplication (`UNIQUE (tenant,job,kind,dedup_key)` for usage; `UNIQUE (tenant,org,project,idempotency_key)`
for ledger).

### Watermark / cursor / checkpoint

Reconciliation progress is a **durable watermark** stored in `reconciliation_runs.watermark`
(migration v9). It is the SOLE progress source — no in-memory cursor. An interrupted run resumes from
the last committed watermark. Any prior `running` run for the same `(tenant, scope)` is marked
`interrupted` (it cannot remain the authoritative run); the new run seeds its watermark from the last
`completed`/`interrupted` run. This makes reconciliation **restart-safe and idempotent**.

### Detected gaps (A–H)

| Gap | Kind | Detected by |
|---|---|---|
| A | `missing_usage_event` | committed JobEvents with no matching UsageEvent |
| B | `unpriced_usage` | UsageEvents with no settled/non-billable settlement |
| C | `missing_ledger_entry` | billable UsageEvents with no LedgerEntry |
| D | `duplicate_candidate` | duplicate UsageEvents/LedgerEntries by identity |
| E | `orphan_reservation` | active reservation with no matching job, or past expiry |
| F | `terminal_unsettled_reservation` | terminal job with an unsettled active reservation |
| G | invalid reference | metering/ledger rows referring to invalid tenant/org/project/job |
| H | interrupted run | `reconciliation_runs` left in `interrupted` state |

### Repair rules (and non-repair rules)

**Reconciliation may repair (safe missing downstream projections):**

- **A:** rebuild UsageEvents from committed JobEvents (dedup collapses duplicates — no double insert).
- **B/C:** retry pricing/ledger projection through durable settlement idempotency (no double ledger
  entry).
- **E/F:** release orphaned/terminal-unsettled reservations (fenced, idempotent).

**Reconciliation must NOT and does NOT:**

- Re-execute agent steps or tool calls. The reconciler never calls `runner.runJob` or any engine
  method. It reads `listEvents` (a read-only view of committed history) and projects forward.
- Mutate committed JobEvents or JobRecords.
- Alter pricing history or ledger history (corrections are new entries, never edits).

### Restart safety

Each gap is upserted by `(tenant, kind, ref_type, ref_id, ref_seq)` with `ON CONFLICT DO NOTHING` — a
rerun creates no duplicate gap rows, and a rerun that re-detects the same gap only bumps the run
reference. Reconciliation rerun creates no duplicate UsageEvents (test 11) and no duplicate
LedgerEntries (test 13).

---

## 5. Usage-to-Ledger Settlement Lifecycle

### Separation of collection and settlement

Raw usage **collection** (`metering.record`) is decoupled from billing **settlement**
(`billing.settleUsage`). A metering pipeline crash that drops a UsageEvent is recoverable: the
committed JobEvents still exist and reconciliation rebuilds the missing UsageEvent (§4 gap A).

### Settlement state machine

```
pending → priced → settled          (billable: priced + exactly one LedgerEntry created)
pending → non_billable              (durable reason; no charge)
pending → unresolved                (pricing could not be resolved; durable, retryable)
```

`settled` and `non_billable` are terminal-success. `unresolved` is **retryable**: a later pricing
change or operator action moves it to `priced`/`settled`. If pricing cannot be resolved, usage is
**never silently dropped** — it persists as `unresolved` and is surfaced to reconciliation as gap B.

### Guarantees

- **Restart-safe / retryable / idempotent:** `settleUsage` upserts a pending settlement row
  (`ON CONFLICT (tenant, event_id) DO NOTHING`); a terminal state returns the recorded outcome with
  `duplicated: true`.
- **Deterministic for historical records:** each settlement resolves the **immutable applicable
  PricingVersion** active at settlement time and records `pricing_id`/`pricing_version`. Later
  pricing changes cannot alter a previously settled record (test 15).
- **Exactly-one LedgerEntry:** the ledger `UNIQUE (tenant,org,project,idempotency_key)` collapses
  concurrent settlement attempts to one entry (test 14).
- **Immutability:** ledger history is immutable; adjustments/credits are **new** ledger entries,
  never mutations.
- **Cancellation/failure:** settles genuinely consumed resources only — usage is derived from
  committed JobEvents, so a cancelled job is charged only for what it actually consumed.

### Unresolved usage behavior

Unresolved usage is durable: the settlement row stays `unresolved` with `last_error`. It is never
deleted. Reconciliation detects it as gap B and retries settlement when pricing becomes available.

---

## 6. Exactly-once vs at-least-once Guarantees

| Layer | Guarantee | Mechanism |
|---|---|---|
| Agent/tool execution | **at-least-once** | Phase 1A kernel; recorded-but-unsettled tool calls are never blindly re-executed |
| UsageEvent projection | **exactly-once** at `(tenant,job,kind,dedup_key)` | UNIQUE constraint + dedup key derived from committed event seq |
| LedgerEntry projection | **exactly-once** at `(tenant,org,project,idempotency_key)` | UNIQUE constraint + idempotency key |
| Reservation release | **exactly-once** | fenced conditional UPDATE on `active → released` |
| Admission | **exactly-once** per `(tenant, idempotency_key)` | UNIQUE constraint + claim/complete state machine |

Execution remains at-least-once; accounting is exactly-once at the durable identity boundary.
Reconciliation may replay durable records but never replays execution.

---

## 7. Runtime Economic Enforcement

Phase 1E enforced admission. Phase 1F adds **runtime** enforcement compatible with existing runner
contracts.

### Enforcement points

`ExecutionPolicy` gains optional soft budgets: `maxTokens` (input+output+reasoning) and
`maxDurationMs` (whole-job wall clock). Existing `maxSteps` is unchanged.

Enforcement happens at **step boundaries** (after a completed provider turn), not mid-turn. This is
deliberate: model usage is known only after a completed provider step, so enforcement occurs at the
next safe boundary and may have **bounded overshoot** (one turn's worth of tokens/duration). This is
documented explicitly — no false precision is claimed.

### Budget exhaustion behavior

When `checkBudgets` detects exhaustion, the job transitions through a **durable, explainable** state:
`finalizeBudgetExhausted` emits a `budget_exhausted` event (with the reason:
`token_budget_exhausted` or `duration_budget_exhausted`) and cancels the job. The checkpoint/continuation
boundary is **preserved** — the job is not silently killed.

**Critical rule:** checkpoint correctness is **never** sacrificed to enforce billing/quota. The
durable boundary (checkpoint event + checksummed file) is committed before the budget check, so a
budget-exhausted job remains resumable if the budget is later raised.

### Quota-aware long-running jobs

Long-running jobs renew their admission reservation (`renewReservation`) before `expires_at` while
progressing, so capacity is not reclaimed mid-execution. On terminal state (including budget
exhaustion), the reservation is settled/released.

---

## 8. API-Key Rotation Lifecycle

Migration v12 (`api_key_lifecycle`) extends `api_keys` with `expires_at`, `rotated_from`,
`overlap_expires_at`, and `last_used_at` columns.

### Rotation flow

```
old key valid
   → create replacement (rotated_from = old key id; overlap_expires_at set)
   → controlled overlap (both keys valid until overlap_expires_at)
   → old key expires (expires_at) / is revoked
```

- `rotateApiKey(...)` creates a replacement key linked via `rotated_from` and sets an overlap window
  during which both keys authenticate.
- `expireApiKey` / `revokeApiKey` invalidate a key after the overlap period.
- **Never expose a stored secret:** only the verifier hash is stored; the plaintext secret is
  returned once at creation and never persisted.

### Last-used metadata

`last_used_at` is updated **asynchronously / best-effort** — authentication does **not** block on a
synchronous last-used write, so it cannot become an authentication bottleneck or a race source.
Authorization always uses the **authoritative key state** (active/expired/revoked), never the cached
last-used metadata. Expired/revoked keys fail authentication (test 21).

### Scope restrictions

API keys remain org/project-scoped (Phase 1E). A principal with no project grants has access to no
projects; the wildcard is never synthesized from absence.

---

## 9. Snapshot Retention / GC Lifecycle

Migration v10 (`snapshot_gc`) adds `snapshot_gc_attempts`. The lifecycle state machine lives in
`snapshot_lifecycle.state`:

```
active → eligible_for_gc → deleting → deleted
                              ↘ (provider failure: stays deleting, retryable)
```

### GC guarantees

- **Conservative:** the driver marks a snapshot `eligible_for_gc` only when it is expired-and-
  superseded-by-active, or superseded-by-active and not the last active artifact. It **never** deletes
  a snapshot required by an active recovery path (test 23).
- **Retry-safe / idempotent:** a failed deletion leaves the snapshot in `deleting` with
  `last_error`/`attempts` bumped — it remains retryable (test 24). Re-running over already-`deleted`
  snapshots is a no-op.
- **Provider confirmation:** `deleted` is set **only after** the provider callback confirms deletion
  (or the design supports idempotent deletion — the callback returns true for an already-deleted id)
  (test 25). A failed provider deletion stays `deleting`, never falsely claimed `deleted`.
- **Tenant isolation:** GC is scoped by `tenant_id`; one tenant's snapshots are never visible to
  another.
- **Accounting hooks:** `snapshot_lifecycle.size_bytes` is recorded for capacity accounting.

### Nested-transaction fix

`SnapshotGcDriver` inlines the lifecycle `UPDATE` (rather than calling `markSnapshotState`, which
wraps its own `atomic()`) to avoid a nested-transaction error when the success path is already inside
a store transaction.

---

## 10. Operational Health Model

The control plane exposes operationally useful state through tenant-scoped endpoints (existing API
style):

- `GET /reconcile/health` — reconciliation health for the authenticated tenant (last successful
  watermark, open gaps by kind, interrupted runs).
- `GET /operations/health` — operational health for the authenticated tenant: unresolved usage,
  unresolved pricing, orphaned/stale reservations, settlement backlog, snapshot GC backlog, last
  successful reconciliation run.

### Tenant isolation / privilege

Tenant-facing endpoints derive the tenant from the **authenticated principal**, never the request
body. An ordinary tenant credential can never read another tenant's operational data (test 22).
System/operator-level inspection, if implemented, requires an explicitly privileged principal and
cannot expose cross-tenant data through ordinary tenant credentials.

This phase is API/domain infrastructure only — no dashboard/UI was built.

---

## 11. SQL Concurrency Strategy

All race safety relies on database primitives, never solely on in-memory locks:

- **UNIQUE constraints** as linearization points: `(tenant_id, idempotency_key)` for admission,
  `(tenant,job,kind,dedup_key)` for usage, `(tenant,org,project,idempotency_key)` for ledger,
  `(tenant_id, event_id)` for settlement.
- **Conditional UPDATEs** (`WHERE state = 'active' AND version = ?`) for fenced transitions.
- **`ON CONFLICT DO NOTHING`** for idempotent upserts (claim, settlement, gap detection).
- **Fenced CAS** (`expectedAttempt`, `version`) on every state-changing write — a stale writer can
  never mutate current ownership/reservation state.
- **SERIALIZABLE + FOR UPDATE** in the PostgreSQL dispatcher/store (Phase 1D) for multi-connection
  fencing.

### Migration ledger fix (cross-cutting)

Phase 1F fixed a real migration-identity bug: the shared `schema_migrations` ledger previously
deduplicated migrations by **version number**, but different packages intentionally use overlapping
version numbers (identity v2 `identity_core` vs store-sql v2 `distributed_control_plane`). Whichever
ran first would cause the other to be silently skipped, leaving its tables uncreated. The ledger now
deduplicates by **migration name** (globally unique across all packages). The `schema_migrations`
table PK changed from `version` to `name`. This is what allows all stores (identity, policy, quota,
metering, billing, audit, job-store, reconcile) to share one database — essential for the single-DB
reconciliation and PGlite conformance tests.

---

## 12. PostgreSQL Validation Status

Two execution tiers:

### Tier A — PGlite (real PostgreSQL engine, ALWAYS runs)

PGlite is PostgreSQL (the same server code compiled to WASM), so DDL and constraint behavior are
identical to a server. The PGlite tier proves the SQL-level fencing — UNIQUE constraints, conditional
UPDATEs, `ON CONFLICT DO NOTHING`, version fencing — that make the economic invariants hold. This is
**genuine PostgreSQL validation**, not a SQLite stand-in.

`packages/vaulltcore-control/test/postgres-conformance-1f.test.ts` — Tier A: **9 passed** (always runs). Covers: duplicate usage (one event), concurrent settlement (one ledger), fenced mutation rejection, reconciliation restart (no duplicate projections), transaction rollback (no partial boundary), distributed idempotency (one slot), quota oversubscription rejection, reservation expiry/reaper (capacity released once).

### Tier B — Multi-connection PostgreSQL server (gated, SKIPPED when unavailable)

Proves two **independent connections** racing on the same key serialize to exactly one authoritative
operation under SERIALIZABLE + row-level locks. Gated on `PG_TEST_HOST`/`PG_TEST_PORT`/`PG_TEST_USER`/
`PG_TEST_DB` (defaults: `/tmp/pgsock:5434`, user `postgres`, db `vaulltcore_test`). **Skipped
honestly** (never faked) when no server is configured. With a server provisioned at the defaults, Tier B runs and passes (**2 passed**).

The existing `postgres-conformance.test.ts` (Phase 1D) is gated identically (**8 passed** when PG is
available at the defaults; skipped otherwise).

### Honest reporting

Per the non-negotiable guarantees: PostgreSQL skips are reported as **skips, never as passes**. The
availability-report test asserts `pgServerAvailable === false` when no server is present (and `=== true` when one is).

---

## 13. Known Limitations

1. **Multi-connection server tier is environment-gated:** Tier B requires a live PostgreSQL server
   (defaults: `/tmp/pgsock:5434`, user `postgres`, db `vaulltcore_test`) and the Docker suite
   requires a reachable Docker daemon. When present they run and pass (verified: 175/175 green);
   when absent they skip honestly. Provision: `initdb` a cluster, start `postgres` with
   `-c unix_socket_directories=/tmp/pgsock -c port=5434`, `createdb vaulltcore_test`; start
   `dockerd` and ensure the runner can reach the socket (group `docker` or `DOCKER_CMD`).
2. **Bounded overshoot in runtime enforcement:** token/duration budgets are checked at step
   boundaries, so a single turn may exceed the budget by up to one turn's usage. This is documented,
   not hidden; checkpoint correctness is never sacrificed.
3. **Last-used is best-effort:** `last_used_at` is updated asynchronously and may lag; authorization
   never depends on it.
4. **Reconciliation repairs only safe missing projections:** it does not (and must not) re-execute
   agent steps or tool calls. Genuinely lost execution (no committed JobEvents) cannot be replayed.
5. **Snapshot GC requires provider confirmation:** a provider that never confirms deletion leaves the
   snapshot in `deleting` (retryable) — by design, never falsely `deleted`.

---

## 14. Recommended Next Phase (Phase 2)

1. **Multi-connection PostgreSQL server CI:** wire Tier B into CI as a required service-backed job
   (PostgreSQL service container) so the two-independent-connection race proofs run on every PR.
2. **Streaming/cursor pagination for reconciliation:** for tenants with very large event logs, add
   keyset pagination over the watermark range to bound memory.
3. **Operator/admin authn principal:** a dedicated operator principal type (distinct from tenant
   service accounts) for system-level inspection endpoints, with explicit cross-tenant-read privilege.
4. **Snapshot retention policy engine:** configurable per-tenant retention rules (count/age/cost)
   driving `eligible_for_gc` rather than only expiry-and-supersession.
5. **Budget pre-check at admission:** use historical usage to reject jobs that would certainly exceed
   budget before reservation (admission-time enforcement), complementing the runtime enforcement.
6. **Settlement scheduling:** a durable scheduler that periodically drives `unresolved` settlements
   through retry when pricing changes, rather than waiting for reconciliation.

---

## 15. Test Totals

**Full suite: 175 passed, 0 skipped (with PG + Docker provisioned).** Without those services the
17 environment-gated tests (PostgreSQL server, Docker) skip honestly. The Node `node:sqlite`
`ExperimentalWarning` is suppressed via the `test` script's
`NODE_OPTIONS=--disable-warning=ExperimentalWarning`.

| Suite | Tests |
|---|---|
| `vaulltcore-control/test/business-layer.test.ts` | 22 passed |
| `vaulltcore-control/test/phase1f.test.ts` | 24 passed |
| `vaulltcore-control/test/postgres-conformance-1f.test.ts` | 11 passed (9 PGlite + 2 PG server) |
| `vaulltcore-control/test/control-plane.test.ts` | 10 passed |
| `vaulltcore-control/test/deployment-boundary.test.ts` | 3 passed |
| `vaulltcore-runner/test/durable-runner.test.ts` | 16 passed |
| `vaulltcore-runner/test/actor.test.ts` | 15 passed |
| `vaulltcore-runner/test/snapshot-policy.test.ts` | 9 passed |
| `vaulltcore-store-sql/test/sql-store.test.ts` | 14 passed |
| `vaulltcore-store-sql/test/idempotency-snapshot.test.ts` | 11 passed |
| `vaulltcore-store-sql/test/pglite-smoke.test.ts` | 2 passed |
| `vaulltcore-store-sql/test/postgres-conformance.test.ts` | 8 passed (PG gated) |
| `vaulltcore-worker/test/distributed-ownership.test.ts` | 11 passed |
| `vaulltcore-environment-cloud/test/cloud-environment.test.ts` | 9 passed |
| `vaulltcore-environment-docker/test/docker-provider.test.ts` | 7 passed (Docker gated) |
| `vaulltcore-runner-opencode/test/opencode-adapter.test.ts` | 3 passed |

All Phase 1A–1E regression tests remain green; no existing tests were weakened.
