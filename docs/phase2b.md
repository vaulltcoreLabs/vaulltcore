# Phase 2B — Production Automation Integrations & Autonomous Operations

Phase 2B takes the Phase 2A Automation Product Layer and makes it
production-operable: durable scheduling, durable retry/reaper workers,
production artifact storage, production delivery providers, operational
recovery, transport-neutral event streaming, tenant-scoped observability, and
an expanded control plane — all without weakening any Phase 1/2A invariant.

**Status: COMPLETE.** Builds clean; full deterministic suite green.

```
Test Files  27 passed | 2 skipped (29)
Tests       275 passed | 18 skipped (293)
```

18 environment-gated skips are reported honestly (10 PostgreSQL server,
7 Docker, 1 pglite-server); they never convert a failure into a skip. PGlite
(real PostgreSQL engine) conformance tests ALWAYS run.

---

## 1. Architecture

Phase 2B adds five packages. None of them modify the Phase 1 execution kernel,
and none of them make a vendor a core dependency. Dependency direction is
strict and acyclic:

```
vaulltcore-artifacts  → { store-sql, audit }
vaulltcore-delivery   → { audit }                       (provider-neutral)
vaulltcore-ops        → { store-sql, audit }
vaulltcore-scheduler  → { automation (types only), store-sql }
vaulltcore-recovery   → { automation, ops, store-sql, audit }
vaulltcore-control    → { automation, scheduler, ops, ... }   (HTTP façade)
```

The runner (`vaulltcore-runner`) remains unaware of automation, billing,
identity, control-plane, providers, or business policy. The hard seam holds.

**Product vs execution aggregates.** `AutomationRun` (product-level) stays
distinct from Phase 1 `Job` (execution-level). They never merge. Recovery
reads durable product state and re-projects; it never executes an agent.

---

## 2. Provider seams

### 2.1 Artifact store (`vaulltcore-artifacts`)

`ProductionArtifactStore` is the neutral seam. Capabilities: `put`, `get`,
`head`, `delete`, immutable artifact identity, content SHA-256, content
length/type, tenant/project ownership, metadata sanitization, integrity
verification, idempotent writes, resumable/retry-safe operations.

- **`LocalFilesystemArtifactStore`** — development provider.
- **`S3ArtifactStore`** — S3-compatible object storage. Uses a vendored
  SigV4 signer (`signS3Request`) over an injectable `RequestOptions`/`ClientRequest`
  seam; AWS itself is never a core dependency (the signer works against any
  S3-compatible endpoint). Tested against a local fake S3 server.

**Guarantees.** Artifact identity is content-addressed (SHA-256); `put` is
idempotent on content (same bytes → same identity, no duplicate write); `verify`
detects corruption and confirms integrity; `delete` is idempotent and removes
retrievability; `badRef` is rejected (no path traversal via contentRef);
artifact references never trust arbitrary tenant-supplied paths. Metadata is
sanitized before persistence (no secret keys/values).

### 2.2 Delivery providers (`vaulltcore-delivery`)

`DeliveryProvider` is the neutral seam. Implementations:

- **`WebhookDeliveryProvider`** — generic HTTP webhook delivery.
- **`EmailDeliveryProvider`** — email delivery abstraction over an SMTP seam.
- **`SlackDeliveryProvider`** — practical B2B notification provider.

Every delivery attempt records: attempt identity, destination identity, request
fingerprint, provider response/status, started/completed timestamps,
retryability, next retry time, terminal failure reason.

**Security.** `SsrfGuard` blocks arbitrary internal-network access (RFC 1918 /
loopback / link-local) and credential leakage. `redactUrl` strips userinfo.
Destinations are never echoed raw in route output (masked). No plaintext secrets
in logs, audit metadata, events, or error messages.

---

## 3. Durable retry/reaper system (`vaulltcore-ops`)

A durable operational work queue with fenced claiming. Work items are
idempotent on `(tenant, idempotencyKey)` — no duplicate work.

**Work kinds:** `approval_expiry`, `delivery_retry`, `abandoned_run`,
`expired_reservation`, `stale_idempotency`, `artifact_lifecycle`.

**Work states:** `pending → claimed → in_progress → {succeeded | failed_terminal |
failed_retriable}`.

**Retry state machine.** The `RetryPolicy` + `defaultClassifier` distinguish
six retry classes: `transient`, `rate_limited`, `auth_config`,
`permanent_validation`, `provider_rejection`, `unknown_uncertain`. Bounded
exponential backoff with full jitter, capped by `maxMs` and maximum attempts.
`failed_retriable` items are not claimable until `nextRetryAt` (prevents hot
loops). Terminal failure after max attempts.

**Fencing.** Lease renewal is fenced by generation; a superseding generation N
can never complete work owned by generation N-1 (across separate connections /
a partition). A crashed worker's expired claim is reaped and reclaimed by a
replacement worker. This reuses Phase 1D–1F lease/fencing primitives — a
crashed worker is safely replaceable by another worker.

**No retry silently duplicates a non-idempotent external action.** Delivery is
at-least-once execution with idempotent settlement at the durable identity
boundary (`UNIQUE (runId, idempotencyKey)`); the `in_progress` state is recorded
before the provider call, so a crash never falsely marks delivered.

---

## 4. Scheduling (`vaulltcore-scheduler`)

Durable automation scheduling over `SqlScheduleStore`.

**Capabilities:** one-time scheduled execution; recurring schedules (cron);
timezone-aware scheduling; deterministic next-run calculation; pause/resume;
cancellation; schedule versioning; missed-run policy (`skip` / `catch_up`,
bounded by `maxCatchUp`); idempotent schedule firing.

**Scheduler crash safety.** The durable schedule identity plus occurrence
identity (`occ:<scheduleId>:<scheduledTime>`, deterministic) determines whether
a run has already been admitted. `recordOccurrence` is the linearization point
(UNIQUE occurrence row): a second scheduler instance / restart recomputes the
same occurrence id and finds `admitted:false` (already admitted) — a scheduler
crash never creates duplicate runs. `occurrenceId` is deterministic so
crash/restart recomputes the same id.

**Versioning.** Schedules are versioned; `publishVersion` is fenced by current
version (CAS). State transitions (pause/resume/cancel) are fenced. Not a
general workflow engine (topological, bounded — no loops/parallel/recursion,
inherited from Phase 2A).

---

## 5. Automation run recovery (`vaulltcore-recovery`)

`RecoveryScanner` + concrete reapers (`buildReapers`) operate around the
existing durable watermark. Recovery covers: worker crash, control-plane
restart, provider timeout, delivery timeout, approval timeout, artifact
failure, partial projection, duplicate event delivery.

**Recovery algorithm (in order):**
1. Inspect authoritative state (durable store; reads only).
2. Detect incomplete projections / stuck work (gaps A–H from Phase 1F,
   extended to product state).
3. Repair only safe projections (re-project, retry pricing/ledger via durable
   idempotency, release orphaned/terminal-unsettled reservations).
4. Resume eligible operational work through the fenced ops worker.
5. Preserve historical evidence (immutable ledger/history; corrections = new
   entries).
6. **Never execute an agent merely because reconciliation detected a gap.**
   `reconcileRun` re-projects durable state and re-drives stuck runs; it calls
   `AutomationService.reconcileRun` (idempotent: dispatcher deduplicates on
   `(runId, stepId)`), never `advanceRun` execution blindly.

**Reapers:** approval-expiry (expires a pending approval; idempotent on re-run),
delivery-retry, abandoned-run (calls `reconcileRun` — no agent execution,
idempotent). The scanner is read-only; all repairs go through fenced ops
workers + reapers. Tenant isolation: the scanner only scans the caller's tenant.

---

## 6. Production control plane (`vaulltcore-control`)

Phase 2B extends the HTTP control plane with a `phase2b` layer (optional,
requires the automation layer). New tenant-scoped routes:

```
POST   /automation/schedules
GET    /automation/schedules
GET    /automation/schedules/:id
POST   /automation/schedules/:id/pause
POST   /automation/schedules/:id/resume
POST   /automation/schedules/:id/cancel
GET    /automation/schedules/:id/occurrences
GET    /automation/runs/:id/deliveries
GET    /automation/runs/:id/stream?after=<seq>&follow=true   (SSE)
GET    /automation/metrics
GET    /operations/retry-status
GET    /operations/health/p2b
```

**HTTP semantics.** `401` unauthenticated; `403` authenticated but
unauthorized; `404` for cross-tenant / nonexistent resources (no existence
leak); `409` idempotency/fingerprint/version conflicts (fenced CAS surfaces as
409, never 500); `422` invalid business input; `429` quota/rate-limit; `5xx`
only for genuine server/provider failures. No internal stack traces, secrets,
provider credentials, or tenant information are exposed. Mutating endpoints
require idempotency where duplication is possible.

Tenant identity comes from the authenticated principal, never the request body.
Cross-tenant reads return 404 (no existence leak).

---

## 7. Event streaming

Durable product-level event streaming for automation runs over the existing
sequence/watermark model. SSE is the default transport, but the underlying
event model is transport-neutral.

- **Replay from `afterSeq`** — initial replay emits all events with `seq > after`
  in order.
- **No sequence gaps** — events derive from the durable, monotonic event log
  (UNIQUE `(jobId, seq)`), never mutable counters.
- **Duplicate suppression** — replay is idempotent on `seq`.
- **Reconnect support** — a client reconnects with `after=<last seen seq>` and
  resumes without gaps.
- **Terminal-state readability after disconnect** — the stream closes with an
  `event: done` frame carrying the terminal status; a client that disconnects
  mid-stream can still query `GET /automation/runs/:id` for the terminal state.
- **Tenant authorization before subscription** — cross-tenant SSE returns 404.
- **Bounded memory / backpressure** — each poll is a bounded query; the live
  loop polls the durable log rather than buffering unbounded history.

---

## 8. Observability & economics

Tenant-scoped operational metrics derive from durable events/records, never
mutable counters that can silently drift. `GET /automation/metrics` exposes:

- queued/running/suspended/completed/failed runs (from durable run records)
- execution duration (avg over completed runs)
- model usage (from committed usage events)
- provider latency, delivery success/failure (from durable delivery attempts)
- retry counts (from durable ops work items)
- artifact storage (from durable artifact records)
- approval latency (from durable approval requests)
- quota utilization (from durable reservation state)
- estimated cost (from immutable ledger entries)

Billing remains immutable and versioned (Phase 1E/F): pricing changes cannot
rewrite historical charges; ledger history is immutable (corrections = new
entries); exactly-once at the durable usage/ledger identity boundary
(execution stays at-least-once).

---

## 9. Security model

A focused Phase 2B security audit covered and fixed:

- **SSRF** — `SsrfGuard` blocks loopback / RFC 1918 / link-local destinations
  before any outbound webhook; tested.
- **Webhook abuse** — destinations are masked in output; callbacks treat
  untrusted payloads as data, not instructions.
- **Credential exposure** — `redactSecrets` / `redactUrl` strip bearer tokens,
  userinfo, and `token=...` query params from logs, errors, and route output.
- **Artifact path traversal** — content-addressed identities; `badRef`
  rejected; no arbitrary tenant-supplied paths; tested.
- **Tenant isolation** — every store read is tenant-scoped; cross-tenant reads
  return 404 (no existence leak); proven by tests.
- **Authorization bypass** — reuse Phase 1E role-rank; no second authorization
  model; least-privilege project scope.
- **Replay attacks** — idempotency keyed on durable identities; same-key +
  different-fingerprint = explicit 409 (never silent replay).
- **Idempotency-key abuse** — same as replay; claim is the linearization point.
- **Schedule duplication** — deterministic `occurrenceId` + UNIQUE row; crash
  never duplicates a run; tested.
- **Malicious callback payloads** — untrusted content treated as data.
- **Oversized artifacts** — content length tracked; providers enforce limits.
- **DoS through retries** — bounded backoff + jitter + max attempts;
  `failed_retriable` not claimable until `nextRetryAt`.
- **Unbounded polling** — bounded scheduler tick (`maxPerTick`); bounded SSE
  polls.
- **Secret persistence** — no plaintext secrets in SQL/logs/events/audit/errors;
  artifact metadata sanitized.

---

## 10. Failure modes

- **Provider timeout / delivery timeout** — classed `unknown_uncertain` →
  retriable; `in_progress` recorded before the call so a crash never falsely
  marks delivered.
- **Approval timeout** — approval-expiry reaper expires the pending approval
  idempotently; the run parks in `awaiting_approval` (no blind delivery).
- **Artifact failure** — content-addressed; corruption detected by `verify`;
  `delete` idempotent.
- **Partial projection** — `reconcileRun` re-projects from committed events;
  orphan events beyond the watermark never replay as committed history.
- **Worker crash** — expired claim reaped and reclaimed by a replacement worker;
  fenced by generation.
- **Scheduler crash** — deterministic occurrence id + UNIQUE row; no duplicate
  runs.
- **Control-plane restart** — all state is durable; the control plane and
  workers restart independently without losing correctness (Phase 1D rule).

---

## 11. Exact-once boundaries vs at-least-once execution

Execution remains **at-least-once**. Exactly-once is achieved only at explicit
**durable identity boundaries**:

- run creation: `UNIQUE (tenant, idempotency_key)`
- job dispatch: `(runId, stepId) → auto:runId:stepId`; dispatcher deduplicates
- approval decision: `approvalId + approvalVersion` fenced CAS
- delivery: `UNIQUE (runId, idempotency_key)` + fenced transition; `in_progress`
  before the provider call
- usage/ledger: `UNIQUE (tenant, job, kind, dedup_key)`
- schedule occurrence: `UNIQUE occurrenceId`
- ops work: `UNIQUE (tenant, idempotencyKey)`

A crash never silently duplicates a non-idempotent external action; it may
re-attempt, and the durable identity boundary collapses the duplicate.

---

## 12. Operational deployment model

The HTTP control plane is never the long-running job owner (Phase 1D rule). A
request transactionally persists state then dispatches; control plane,
scheduler, ops workers, and reapers restart independently. Recommended
deployment:

- **Control plane** — stateless HTTP façade; scale horizontally behind a load
  balancer. Idempotency keys make it safe to retry requests.
- **Scheduler** — one or more `Scheduler.tick()` runners; the UNIQUE occurrence
  row makes concurrent ticks safe (losers find `admitted:false`).
- **Ops workers** — `OperationalWorker` instances; fenced claiming makes
  concurrent workers safe; crashed workers are reaped and replaced.
- **Recovery** — `RecoveryScanner` + reapers on a schedule (cron or loop);
  read-only scan + fenced repairs.

All external providers (S3, SMTP, Slack, webhooks) are behind neutral seams;
swap a provider by implementing the interface, no core changes.

---

## 13. Environment-gated tests

Tests skip **only when genuinely unavailable** (never convert a failure to a
skip):

- **PostgreSQL server** (10 tests) — gated on `PG_TEST_*` / a server at
  `/tmp/pgsock:5434`; skipped honestly otherwise. PGlite conformance
  (real PostgreSQL engine) ALWAYS runs.
- **Docker** (7 tests) — gated on `DOCKER_CMD` / available Docker daemon.
- **S3 / SMTP / Slack providers** — fake/local servers in-process; the S3
  provider uses a local fake S3 server (always runs).

---

## 14. Remaining limitations

- Multi-connection PostgreSQL server tests are environment-gated (PGlite covers
  SQL-level invariants always).
- Docker provider tests require a Docker daemon.
- The SSE live-follow loop polls the durable log (50 ms); for very high
  throughput a push-based pub/sub could be layered above the same event model
  (transport-neutral).
- Production S3/SMTP/Slack endpoints are provider-dependent; the seams are
  proven, integration against a real vendor endpoint is operator-supplied.

---

## 15. Phase 2C recommendation

- **Push-based event fan-out** — layer a pub/sub (e.g., LISTEN/NOTIFY over PG,
  or an external broker) above the existing durable event model to reduce SSE
  polling latency while keeping the no-gap/duplicate-suppression guarantees.
- **Multi-region / HA store hardening** — Phase 1F SERIALIZABLE + FOR UPDATE
  fencing is proven for single-DB; multi-region active-active needs
  consensus/CRDB-class coordination.
- **Provider integration suites** — conformance suites against real vendor
  endpoints (S3, SES, Slack) with recorded fixtures.
- **Backpressure / rate-limit admission** — global per-tenant rate limiting at
  the control plane for delivery/scheduling fan-out.
- **Audit retention / compaction** — durable append-only audit grows; a
  retention/compaction policy belongs in Phase 2C (never delete before retention
  boundary).
- **Cost-anomaly alerting** — built on the immutable ledger; threshold-based
  alerts projected from durable billing records.

---

## What is production-ready, provider-dependent, and Phase 2C

- **Production-ready:** durable scheduling, durable retry/reaper workers,
  operational recovery, control-plane routes, SSE event streaming, metrics,
  SSRF/secret-redaction security, tenant isolation, fencing, content-addressed
  artifact storage with a local provider, delivery provider seams with a
  webhook/email/Slack abstraction. All proven by tests over PGlite (real
  PostgreSQL engine) + in-process fakes.
- **Provider-dependent:** real S3-compatible object storage, real SMTP, real
  Slack — the seams are proven; integration against a live vendor endpoint is
  operator-supplied (environment-gated conformance suites are a Phase 2C item).
- **Phase 2C:** push-based fan-out, multi-region HA, vendor conformance suites,
  control-plane rate limiting, audit retention/compaction, cost-anomaly
  alerting.
