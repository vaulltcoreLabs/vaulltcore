# Phase 2E — Production Reliability, Operations, Recovery & B2B Scale

## 1. Phase 2E objective

Turn the existing durable B2B automation system into an operationally resilient
production platform. Phase 2D established:

external provider → secure connection lifecycle → verified durable ingress →
normalized event → deterministic versioned trigger → durable dispatch
reservation → existing authorization/policy/quota admission → immutable
automation run → Phase 1 execution kernel → at-least-once recovery.

Phase 2E strengthens everything AROUND that path: durability → recovery →
retries → leases → dead-letter handling → reconciliation → observability →
operational controls → tenant-safe backpressure. When processes crash, workers
restart, queues duplicate messages, databases temporarily fail, providers send
duplicate events, or execution becomes overloaded, Vaulltcore recovers
predictably without silently losing customer work.

The goal is NOT to add more providers or agent features. The runner is
untouched; the OpenCode adapter is untouched; there is no second runtime.

## 2. Exact architectural flow

```
external provider
  → secure connection lifecycle (Phase 2C/2D)
  → verified durable ingress (webhook gateway; never executes an agent in the
     request path; UNIQUE (tenant, provider, providerEventId) dedup)
  → normalized event
  → deterministic versioned trigger (revision pinned into every dispatch)
  → durable dispatch reservation (UNIQUE (tenant, sourceEventId, triggerId))
  ┌── Phase 2E fenced redrive lease (claimRedriveDispatch, generation CAS) ──┐
  → existing authorization/policy/quota admission
  │   └── Phase 2E global capacity ceiling (QUOTA_GLOBAL_FULL; honest reject) │
  → immutable automation run
  → Phase 1 execution kernel (at-least-once)
  → durable checkpoint + event log (authoritative)
  → bounded reconciliation (reaper + reconcileRun; never invokes execution)
  → telemetry/audit (redacted; additive event types)
  → operational control plane (redrive / cancel / health / readiness)
```

## 3. Files added

- `packages/vaulltcore-reliability/package.json`, `tsconfig.json`
- `packages/vaulltcore-reliability/src/index.ts` — package barrel + invariant
  documentation.
- `packages/vaulltcore-reliability/src/telemetry.ts` — `TelemetrySink`,
  `AuditTelemetrySink`, metadata builders (`leaseMetadata`, `retryMetadata`,
  `reconciliationMetadata`, `capacityMetadata`). Never carries secrets.
- `packages/vaulltcore-reliability/src/cancellation.ts` — `TimeoutService` +
  `requestCancellation`. Durable, cooperative, fenced (runVersion CAS).
- `packages/vaulltcore-reliability/src/reconciliation.ts` —
  `ReliabilityReconciliationService` (bounded, watermarked, concurrent-safe,
  idempotent; never invokes agent execution).
- `packages/vaulltcore-reliability/src/redrive.ts` — `RedriveService`
  (authorized, tenant-isolated, idempotent; never resurrects terminal work).
- `packages/vaulltcore-reliability/src/health.ts` — `HealthService`,
  `SqlStorageProbe`, readiness + per-tenant operational health.
- `packages/vaulltcore-reliability/test/reliability.test.ts` — 19 Tier A tests
  covering the mandatory durability/recovery/capacity/redaction scenarios.
- `packages/vaulltcore-control/src/phase2e-routes.ts` — operational routes
  (redrive, retry/dead-letter status, reconcile, timeout-scan, cancel,
  readiness, tenant health).

## 4. Files modified

- `packages/vaulltcore-audit/src/contracts.ts` — ADDITIVE: extended
  `AUDIT_EVENT_TYPES` with Phase 2E telemetry types
  (`work_lease_acquired`/`lost`/`expired`, `work_retry_scheduled`/`attempted`/
  `exhausted`, `work_dead_lettered`/`redriven`, `reconciliation_detected`/
  `recovered`, `capacity_admitted`/`released`, `work_cancelled`,
  `work_timed_out`, `work_terminal_*`). Type persisted as TEXT; no schema
  change; no historical event meaning altered.
- `packages/vaulltcore-ops/src/contracts.ts` — ADDITIVE: `dead_letter` added to
  `OPS_WORK_STATES`; `FailureClass` type.
- `packages/vaulltcore-ops/src/store.ts` — migration `ops_reliability` (v2)
  CHECK constraint includes `dead_letter`; `complete()` exhausted retries →
  `dead_letter`; `deadLetter()`/`redrive()`/`listDeadLettered()`/
  `listPendingBatch()`/`countByState()`/`reapExpiredClaims()`.
- `packages/vaulltcore-automation/src/trigger-store.ts` — migration
  `automation_dispatch_lease` (v4); `DispatchRow`/`TriggerDispatch` extended
  with `redrive_generation`/`redrive_owner`/`redrive_expires_at`;
  `claimRedriveDispatch()`/`renewRedriveLease()`/`releaseRedriveLease()`/
  `redriveDeadLetter()`/`listStrandedDispatches()`/`listDeadLetteredDispatches()`;
  terminal transitions clear the redrive lease.
- `packages/vaulltcore-automation/src/dispatch.ts` — `redrive()` now operates
  under a fenced lease; `redriveLeaseMs` option; terminal dispatches never
  claimed.
- `packages/vaulltcore-quota/src/store.ts` — migration
  `quota_global_capacity` (v5); global ceiling in `reserve()` (QUOTA_GLOBAL_FULL,
  honest reject, per-scope claim rolled back); global decrement in
  `settle()`/`release()`/`reapExpired()`; `setGlobalCapacity()`/`getGlobalUsage()`.
- `packages/vaulltcore-control/src/server.ts` — ADDITIVE: `phase2e` layer
  option + context + route dispatch block (matched before generic routes).
- `packages/vaulltcore-control/src/index.ts` — export `PHASE2E_ROUTES` + types.
- `packages/vaulltcore-control/package.json` — dependency on
  `@vaulltcore/reliability`.
- `tsconfig.json` — reference to `vaulltcore-reliability`.

## 5. Migrations added (globally unique names; dedup-by-name preserved)

| Migration name (globally unique) | Package | Additive |
|---|---|---|
| `ops_reliability` | vaulltcore-ops (v2) | yes — CHECK includes dead_letter |
| `automation_dispatch_lease` | vaulltcore-automation (v4) | yes — nullable redrive lease columns + index |
| `quota_global_capacity` | vaulltcore-quota (v5) | yes — single-row global capacity table |

No destructive migration. All state-changing writes remain fenced by CAS.

## 6. Lease / fencing invariants

- A process being alive is never proof it still owns work. Every recoverable
  worker-owned operation has a durable fenced lease:
  - ops work claim → `generation` (CAS on complete; stale generation rejected)
  - trigger dispatch redrive → `redrive_generation` (claim/renew/release CAS)
  - quota reservation → `version` (settle/release/renew fenced)
- A stale worker (older generation/version) can NEVER finalize, overwrite, or
  transition work after a newer generation took over.
- Lease expiry → safe takeover: `reapExpiredClaims` / `claimRedriveDispatch`
  reclaim expired leases; the new owner gets a strictly greater generation.
- Terminal transitions (`succeeded`/`failed_terminal`/`dead_letter`/
  `run_created`/`rejected`) clear the active lease so a stale owner cannot act.

## 7. Retry classification and policy

`FailureClass` distinguishes: transient infrastructure, rate_limited/retry-after,
provider temporary, permanent validation, authorization, policy, quota,
cancelled, timeout, unknown terminal. Policy/quota/auth/validation/cancelled/
timeout rejections are terminal — NEVER retried as infrastructure.

Retries are bounded + persisted: `maxAttempts`, exponential backoff with bounded
jitter, `nextRetryAt` timestamps, `retryClass` + `lastError` (sanitized, 500
char cap), attempt counter. Terminal exhaustion → `dead_letter` (distinct from
`failed_terminal`). Recovery after restart derives pending retries from durable
state (`next_retry_at <= now`) — no in-memory timers as source of truth.

## 8. Dead-letter / redrive semantics

- Exhausted/poisoned work → explicit terminal `dead_letter` state with a
  sanitized diagnostic (`lastError`, `retryClass`; no secrets).
- Operator redrive (control plane, admin-authorized, tenant-scoped):
  - `POST /operations/dead-letter/:id/redrive` (ops)
  - `POST /operations/dispatches/:id/redrive` (dispatch)
- Redrive is idempotent (re-arming an already-re-armed item is a no-op),
  never creates duplicate durable identities, creates an audit trail
  (`work_redriven`), and NEVER resurrects a terminal
  succeeded/`run_created`/`rejected` item. Permanent policy/auth/quota
  rejection is never auto-retried.

## 9. Reconciliation guarantees

`ReliabilityReconciliationService` detects: expired ops leases, due retries,
stranded dispatches (fenced redrive), abandoned/stale runs (reconcileRun),
leaked quota capacity. It is safe to run repeatedly + concurrently: every
repair is a fenced/idempotent transition; it never scans and blindly rewrites;
it never invokes agent execution (reconcileRun re-projects + re-drives
idempotently through the AutomationService seam; the dispatcher deduplicates
on (runId, stepId)). Bounded batch (default 100) + continuation cursor so it
is never an unbounded DB operation. `reconcileAll(maxBatches)` bounds the whole
pass.

## 10. Capacity / fairness behavior

Per-tenant concurrency ceiling (Phase 1E, unchanged) + Phase 2E global capacity
ceiling. A reservation that fits its per-scope ceiling but exceeds the global
ceiling is rejected honestly (`QUOTA_GLOBAL_FULL`) — work is queued, never
silently dropped. Capacity is released on terminal completion (settle/release)
for BOTH counters; leaked capacity is recovered after crashes (reapExpired
decrements both). One tenant cannot consume another tenant's reserved capacity
(separate per-scope counters; the global ceiling bounds the SUM fairly). A
delayed tenant receives an honest state (409/queued), never a silent drop.

## 11. Cancellation / timeout race rules

Durable-ordered (fenced CAS), not process-timed:
- cancel vs completion — fenced runVersion CAS; exactly one wins, the other is
  a no-op (terminal idempotent).
- timeout vs completion — same CAS.
- lease expiry vs completion — the lease fence rejects the stale worker.
- redrive vs late retry — the redrive lease fence + terminal-state guard
  reject a late retry on terminal work.

A late worker can NEVER resurrect cancelled/terminal work.

## 12. Observability + redaction guarantees

Structured telemetry via `AuditTelemetrySink` → durable audit log (additive
event types; TEXT persisted). Stable identifiers: tenantId, runId, dispatchId,
sourceEventId, triggerId, attempt, worker identity (safe operational handle,
never a raw secret/principal credential), timestamps, durations, failure class.
NEVER emits: credentials, authorization headers, API keys, access/refresh
tokens, secret references that reveal secret material, or unrestricted raw
payloads. `sanitizeMetadata` strips secret keys + opaque secret values; the
metadata builders never put secrets in in the first place. Redrive diagnostics
are redacted (`redact()` strips bearer/userinfo/token=). Cross-tenant reads
return 404 (no existence leak).

## 13. Operational APIs (control plane)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/operations/retry-status` | tenant | retry/dead-letter overview (ops + dispatches) |
| POST | `/operations/dead-letter/:id/redrive` | admin | redrive an ops item |
| POST | `/operations/dispatches/:id/redrive` | admin | redrive a dead-lettered dispatch |
| POST | `/operations/reconcile` | admin | bounded reconcile pass (?all=true for all) |
| POST | `/operations/timeout-scan` | admin | bounded timeout pass |
| POST | `/runs/:id/cancel` | tenant | cooperative durable cancel |
| GET | `/readiness` | (auth) | liveness/readiness probe |
| GET | `/operations/health/reliability` | tenant | per-tenant operational health |

Errors: 401 unauthenticated, 403 forbidden, 404 (cross-tenant = no existence
leak), 409 fenced/state conflict, 422 semantic, 5xx (no stack traces/secrets).

## 14. Tests executed with exact results

`npx vitest run packages/vaulltcore-reliability/test/reliability.test.ts` →
**19 passed / 0 failed**. Covers: (1) worker crash after lease, (2) lease
expiry + safe takeover, (3) stale completion rejected, (4) transient retry
succeeds, (5) retry exhaustion → dead-letter, (6) policy rejection terminal,
(7) redrive idempotent, (8) reconciliation repeatable no duplicates, (9)
reconciliation races safely with live worker, (10) duplicate scans no duplicate
work, (11) capacity released after success, (12) leaked capacity recovered
after crash, (13) cross-tenant capacity isolation, (global ceiling bounds
sum), (17) telemetry redacts secrets, (18) restart recovery from durable
state, (19) bounded batch continuation.

`npx tsc --build packages/vaulltcore-reliability packages/vaulltcore-control` →
**0 TypeScript errors**.

## 15. Existing tests preserved

Full suite (`npm test`) — see the final completion report for the exact count.
The Phase 1–2D suite (375 passed / 25 env-gated skips at the Phase 2D baseline)
remains green; the Phase 2E additions are additive and do not weaken any
existing invariant.

## 16. Exactly-once boundaries vs at-least-once execution

Execution stays at-least-once. Exactly-once is claimed ONLY at durable identity
/ linearization boundaries: webhook dedup (tenant+provider+providerEventId),
external mutation (tenant+connectionId+operationId), dispatch reservation
(tenant+sourceEventId+triggerId), dispatch redrive lease (claim is unique per
generation), automation run (tenant+runId+idempotencyKey), job dispatch
((runId,stepId)→jobId), delivery (tenant+runId+idempotencyKey), schedule
occurrence (occ:scheduleId:scheduledTime), ops work (tenant+idempotencyKey),
quota reservation (tenant+requestKey). Reconciliation never duplicates a
committed identity.

## 17. Health / readiness semantics

Readiness = process alive AND durable storage reachable. It does NOT depend on
external providers — a provider outage degrades only affected work (retries/
backoff; triggers keep matching against durable state), never the whole control
plane. Per-tenant health reports ops backlog (pending/failed_retriable/
dead_letter), global capacity, leaked reservations, and an honest `healthy`
flag. Cross-tenant reads return nothing.

## 18. Known limitations

- Cancellation/timeout enforcement over live automation runs relies on the
  existing `AutomationService.cancelRun` fence; live multi-connection server
  races are Tier B (env-gated), not exercised in the sandbox.
- The webhook trigger → AutomationService run dispatch wiring (idempotency_key
  derived from dispatch identity) is deferred to a future phase per the Phase
  2D recommendations; the dispatch redrive lease + dead-letter path are in
  place and tested.
- Live external-provider conformance (GitHub/GitLab/Linear/Slack/OpenAI/
  Anthropic/Google) remains env-gated (Tier C); not exercised in the sandbox.

## 19. Proven by tests vs requires future live validation

Proven by Tier A deterministic tests (in-memory SQLite + the real durable
layer): lease crash/expiry/stale-completion, retry exhaustion, dead-letter,
redrive idempotency, reconciliation idempotency + safe racing, capacity
release/recovery/isolation/global ceiling, telemetry redaction, restart
recovery, bounded batch continuation.

Requires future live validation: multi-connection PostgreSQL server races
(Tier B, env-gated), live provider conformance (Tier C, env-gated), and
real-network webhook trigger → run dispatch end-to-end under load.
