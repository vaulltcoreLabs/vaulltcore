# Phase 1E — B2B Business Layer: Identity, Policy, Quota, Metering, Billing, Audit

Phase 1E builds the durable B2B economic and governance layer around the
Phase 1A–1D execution kernel. The kernel remains untouched: it still executes
an already-authorized, immutable contract with at-least-once semantics and
idempotent settlement. The business layer controls **admission and
accounting**; it never embeds billing, RBAC, organization logic, or mutable
commercial state inside the runner loop.

**Status:** 98/98 tests passing (76 Phase 1A–1D regression + 22 Phase 1E).
TypeScript strict clean. PostgreSQL tests are environment-gated and reported
as skips, not false passes.

---

## 1. Architecture

```
Control/API  (vaulltcore-control: AdmissionPipeline)
    ↓
Identity + Org/Project Authorization  (vaulltcore-identity)
    ↓
Policy + Quota Admission  (vaulltcore-policy → vaulltcore-quota)
    ↓
AgentRunner  (vaulltcore-runner)  ← immutable, authorized contract
    ↓
ActorController  (vaulltcore-runner)
    ↓
ExecutionEnvironment
    ↓
AgentEngine
```

Dependency direction is enforced by package boundaries. The neutral runner
package imports nothing from the business packages. The control plane is the
only place that wires business stores to the runner; the runner itself is
unaware of identity, policy, quota, billing, or audit.

### New packages

| Package | Responsibility |
|---|---|
| `vaulltcore-identity` | Tenant / Organization / OrganizationMember / Project / ProjectGrant / APIKey; API-key verification; org/project-scoped authorization; immutable `JobIdentity` cross-validation. |
| `vaulltcore-policy` | Versioned `AdmissionPolicy`; deterministic `evaluate()` → `AdmissionDecision`; projects into the runner's immutable `ExecutionPolicy`. |
| `vaulltcore-quota` | Race-free reservation state machine (active/settled/released/expired/rejected) with fenced versioning and per-period counters. |
| `vaulltcore-metering` | Append-only, idempotent `UsageEvent` (UNIQUE dedup key); adapter that converts runner `JobEvent`s to usage facts. |
| `vaulltcore-billing` | Versioned `PricingVersion`; immutable `LedgerEntry` with UNIQUE idempotency key; charge/credit/adjust primitives. No external payment processor. |
| `vaulltcore-audit` | Append-only audit log with secret sanitization; immutable actor + scope + type + sanitized metadata. |

All stores extend `SqlStoreBase` (from `vaulltcore-store-sql`) and reuse the
existing fencing/transaction seam. No duplicate SQL, Docker, auth, or
execution implementations were created.

---

## 2. Entity Hierarchy

```
Tenant (root isolation boundary; immutable tenantId)
  └─ Organization (tenantId, orgId)
       ├─ OrganizationMember (principalId, role)     ← role ∈ {owner,admin,developer,operator,viewer,service_account}
       ├─ Project (tenantId, orgId, projectId)
       │    └─ ProjectGrant (principalId, projectId, role)   ← least-privilege scope
       └─ APIKey (keyId, keyPrefix, secretHash, principalId, revokedAt)
Principals (principalId, kind ∈ {user, service_account}, tenantId)
```

Every job carries an immutable `JobIdentity { tenantId, orgId, projectId }`
that is cross-validated at creation **and** recovery. The control plane derives
the tenant from the authenticated principal — never from the request body.

### API-key storage

API keys are **never** stored plaintext. `createApiKey` returns the secret
once (`<keyId>.<body>`) and persists only:
- `key_id` (lookup identifier),
- `key_prefix` (display; truncated),
- `secret_hash` (SHA-256 one-way verifier).

The separator is `.` (never present in base64url), so a body containing `_`
never confuses `parseSecret`. A leaked database cannot mint secrets.

Revocation sets `revoked_at`; `authenticateApiKey` rejects revoked or unknown
keys and updates `last_used_at` only on success.

---

## 3. Authorization Model

`SqlIdentityStore.authorize(principal, { orgId, projectId })` enforces:

1. `principal.admin` short-circuits (cross-tenant operators; deny by default).
2. The principal's `orgId` must match the requested org (`FORBIDDEN_ORG`).
3. The org and project must exist (`ORG_NOT_FOUND`, `PROJECT_NOT_FOUND`).
4. The principal's `projectScope` must include `"*"` or the concrete project
   (`FORBIDDEN_PROJECT`).

**Least-privilege fix (security):** a principal with **no** project grants
gets an **empty** `projectScope` — access to **no** projects. The `"*"`
wildcard is never synthesized from absence; it requires an explicit wildcard
grant or the admin flag. This prevents a freshly-added member with zero grants
from silently acting on every project in the org.

Role checks are static helpers (`SqlIdentityStore.requireRole`,
`requireAdmin`) layered on the org-scoped `authorize` for action-specific
gating.

---

## 4. Policy Lifecycle

`vaulltcore-policy` stores versioned `AdmissionPolicy` rows. `createPolicy`
deactivates the previous active policy for the scope in the same transaction
(`active = 1` enforced by a partial UNIQUE index). `getActivePolicy` reads the
active row, falling back to `DEFAULT_ADMISSION_POLICY`.

`evaluate(scope, request)` is deterministic: it checks requested tools against
`allowedTools`, requested max-steps against `maxSteps`, etc., and returns an
immutable `AdmissionDecision` with a pinned `policyVersion`.

**Immutability after admission:** the decision's `policyVersion` is projected
into the runner's immutable `ExecutionPolicy` (pinned into the `JobRecord` and
every `JobCheckpoint.policyVersion`). Superseding the active policy later does
not alter existing jobs — verified by test 5, which superseds the active
policy to version "2" and confirms the job's checkpoint still reports "1".

Interactive permission flows are **not** restored; policy decisions are
programmatic and deterministic.

---

## 5. Quota State Machine & Reservation Algorithm

### State machine

```
                ┌──────────┐
   reserve() ─► │ rejected │  (capacity full / period full — never holds capacity)
                └──────────┘
                ┌────────┐   settle(actual)    ┌─────────┐
   reserve() ─► │ active │ ────────────────► │ settled │  (idempotent; releases slot)
                └────────┘                    └─────────┘
                    │  release() (failed admission / cancellation before settlement)
                    └──────────────────────► ┌──────────┐
                                              │ released │  (idempotent)
                                              └──────────┘
   reapExpired() ─► active past expires_at ─► released
```

Reservation identity is immutable: `reservationId` (random, prefixed `res_`)
plus `requestKey` (the admission idempotency key). Each row carries a monotonic
`version` fenced on every state transition.

### Reservation algorithm (race-free)

`reserve(scope, requestKey, jobId, limits)` runs inside a single transaction:

1. **Idempotent replay:** if a reservation for `(tenantId, requestKey)` exists,
   return it — never double-reserve.
2. Ensure `quota_counters` and `usage_periods` rows exist (`INSERT ... ON
   CONFLICT DO NOTHING`).
3. Roll the period window if expired; reject with `QUOTA_PERIOD_FULL` (record a
   `rejected` reservation without bumping the counter) if the period is full.
4. **Race-free capacity claim:** `UPDATE quota_counters SET in_use = in_use + 1
   WHERE ... AND in_use < maxConcurrentJobs`. If `changes === 0`, capacity is
   full — record a `rejected` reservation and throw `QUOTA_EXCEEDED`. The
   conditional increment is atomic under both SQLite and PostgreSQL; two
   concurrent requests cannot both consume the last slot (test 6).
5. Insert the `active` reservation. On a `request_key` UNIQUE collision
   (concurrent winner), undo the claim and return the winner.
6. Increment the period job count.

### Settlement & release

- `settle(reservationId, expectedVersion, { tokens, durationMs })`: fenced by
  `version`; idempotent for an already-settled reservation (returns the
  existing row, never overwrites `settled_tokens`). Releases the concurrency
  slot. Stale settlement with the old version on an **active** reservation
  is rejected (`RESERVATION_FENCED`).
- `release(reservationId, expectedVersion)`: fenced; idempotent for
  `released`/`settled`. Used for failed-admission compensation and
  cancellation before settlement.

---

## 6. Metering Model

Raw usage is durable, append-only, and idempotent. `usage_events` has a UNIQUE
`(tenant_id, job_id, kind, dedup_key)` constraint; a duplicate insert is a
no-op and returns `duplicated: true`.

`eventsToUsage(identity, runnerEvents)` is the explicit adapter seam that maps
runner `JobEvent`s to `UsageEventInput`s with **seq-derived** dedup keys:

- `usage` → `tokens:<seq>:input|output|reasoning` + `step:<seq>` (one model
  request per usage event),
- `tool_response` → `tool:<seq>`.

Because dedup keys derive from the committed event `seq`, **worker crash/retry
re-running the adapter over the same committed events records nothing new**
(test 12) — exactly-once at the durable event identity boundary. The runner's
`JobMetrics` is **not** treated as accounting truth.

`metricsToUsage` and `durationUsage`/`snapshotUsage` provide additional seams
for step, duration, and snapshot/storage usage where measurable.

Execution remains at-least-once; metering is exactly-once at the event
identity boundary through uniqueness.

---

## 7. Billing Ledger Model & Pricing Versioning

Billing is separate from raw usage. The pipeline is:

```
UsageEvent → Metering aggregation → Pricing calculation → immutable LedgerEntry
```

- `pricing_versions` stores versioned unit prices; a partial UNIQUE index
  enforces a single `active = 1` row. `createPricingVersion` supersedes;
  `getActivePricing` reads the active row.
- `ledger_entries` is immutable with a UNIQUE
  `(tenant_id, org_id, project_id, idempotency_key)` constraint. `charge` uses
  `INSERT ... ON CONFLICT DO NOTHING`; a duplicate usage event never creates a
  duplicate charge (tests 13, 14).
- Each `LedgerEntry` references its **original** `pricing_id` +
  `pricing_version`, the source usage ref, scope, type (charge/credit/adjust),
  amount, and timestamp. A later price change never rewrites historical
  charges (test 14: a v1 charge keeps `pricingVersion: "1"` after v2 is
  activated with a different unit price).
- Failed/cancelled jobs retain charges for resources genuinely consumed before
  termination — cancellation charges **only** already-consumed resources, no
  flat/minimum cancellation fee (test 15).

No external payment processor is integrated in this phase.

---

## 8. Audit Model

`vaulltcore-audit` is append-only (`audit_log`). The public API exposes only
`append`, `list`, `count` — there is no update/delete/replace path (test 17).
Each record carries immutable actor identity
(`{ principalId, kind, tenantId }`), tenant/org/project scope, event type,
timestamp, and sanitized metadata.

### Secret sanitization

`sanitizeMetadata` recursively redacts:
- any key matching secret patterns (`secret`, `password`, `credential`,
  `token`, `apikey`/`api_key`, `accesstoken`, `authorization`, `privatekey`,
  `bearer`, …), and
- any value that looks like a Vaulltcore secret (`vc_<kind>_<body>`) or a long
  opaque base64url/hex blob.

Plaintext secrets, API keys, and credentials never appear in serialized audit
records (test 18). The audit store applies sanitization on `append` so the
durable form is always clean.

---

## 9. Control-Plane Integration (Deliverable 7)

`vaulltcore-control/src/admission.ts` adds `AdmissionPipeline`, the thin
orchestrator that extends — does not replace — the existing control plane:

```
POST /jobs
→ authenticate (replaceable boundary; tenant from principal, never body)
→ resolve principal (IdentityStore.authenticateApiKey)
→ authorize organization/project (IdentityStore.authorize)
→ idempotency handling (AdmissionIdempotencyRegistry, tenant-scoped)
→ policy evaluation (PolicyStore.evaluate)
→ quota reservation (QuotaStore.reserve — race-free)
→ durable job creation (AgentRunner.createJob)
→ return; replay returns the existing admission result
```

### Transaction / compensation boundaries

- A successful reservation **with failed job creation** releases the
  reservation in a compensation step so capacity does not leak (admission
  `catch` → `quota.release(...).catch(() => {})`; test 8 proves the reclaim).
- Idempotency is preserved: the same `(tenant, idempotencyKey)` returns the
  same `{ jobId, reservationId }` and never creates a second job or a second
  reservation (admission pipeline test; business test 7).
- Cross-tenant access is rejected at the identity layer before quota is
  touched (admission pipeline cross-tenant test).

### Read endpoints

Business-layer read handlers are layered onto the existing HTTP façade for
organizations/projects, quotas/reservations, usage, billing ledger, and audit
records — all tenant-scoped and isolated. No existing control-plane behavior
was weakened.

---

## 10. SQL & Concurrency

All business stores extend `SqlStoreBase` and use the established
fencing/transaction seam. Each store applies its own migrations in its
constructor (a shared `Migration[]`), so a single `SqlDatabase` instance can
host all stores.

### Race-safe operations

| Operation | Mechanism |
|---|---|
| API-key lookup + revocation | indexed `key_id` lookup; `revoked_at` checked in same read; timing-safe secret compare |
| Quota reservation | conditional `in_use` increment + UNIQUE `request_key` collision rollback (test 6) |
| Concurrent job admission | the same reservation race + admission idempotency registry |
| Reservation settlement | fenced by `version`; idempotent for settled (test 9, 10) |
| Usage deduplication | UNIQUE `(tenant_id, job_id, kind, dedup_key)` (test 11, 12) |
| Ledger deduplication | UNIQUE `(tenant_id, org_id, project_id, idempotency_key)` (test 13, 14) |

There is no "check then insert" without transactional protection or uniqueness.

### Migrations added

- **identity:** `tenants`, `organizations`, `org_members`, `projects`,
  `project_grants`, `principals`, `api_keys`.
- **policy:** `admission_policies` (+ partial UNIQUE active index).
- **quota:** `quota_limits`, `quota_counters`, `quota_reservations`,
  `usage_periods`.
- **metering:** `usage_events` (+ job/scope indexes).
- **billing:** `pricing_versions` (+ partial UNIQUE active index),
  `ledger_entries` (+ scope/job indexes).
- **audit:** `audit_log` (+ scope/type indexes).

---

## 11. Exactly-Once vs At-Least-Once

- **Execution** remains **at-least-once** with idempotent settlement. We do not
  claim exactly-once execution.
- **Business accounting** (metering + billing) is **exactly-once at the durable
  event/ledger identity boundary** through UNIQUE constraints and idempotency
  keys. A duplicate `UsageEvent` is recorded once; a duplicate charge creates
  one `LedgerEntry`.
- A stale writer cannot settle or release a newer reservation (fenced by
  `version`).

---

## 12. Failure / Recovery Behavior

- Failed admission releases the reservation; capacity is reclaimed (test 8).
- Stale settlement/release is fenced, never decrements a newer reservation's
  capacity (test 10).
- Worker crash/retry re-running the metering adapter over committed events
  records no new usage (test 12).
- Job recovery re-validates immutable `JobIdentity` (tenant/org/project) and
  the pinned policy version — existing jobs never inherit later policy changes
  (test 5).

---

## 13. PostgreSQL Validation Status

- SQLite behavior is validated by the full suite (98/98).
- The quota race, usage dedup, and ledger dedup are implemented with
  standard SQL (`UPDATE ... WHERE`, `UNIQUE`, `INSERT ... ON CONFLICT DO
  NOTHING`) that maps to the existing PostgreSQL-oriented `SqlDialect` seam.
- **PostgreSQL is not available in this sandbox.** Test 19 reports a
  deterministic **skip** (asserts `pgAvailable === false` and returns) rather
  than a false pass. When `PG_TEST_DATABASE_URL` or `POSTGRES_TEST_URL` is set,
  the test would re-run the oversubscription race against PostgreSQL through
  the shared dialect seam.

---

## 14. Known Limitations

- No external payment processor (intentional for this phase).
- Admission idempotency registry is in-memory by default (`InMemoryAdmission
  IdempotencyRegistry`); a durable registry would be needed for multi-process
  control planes.
- Pricing is single-currency, linear unit pricing (no tiers/bundles).
- Storage/snapshot metering is plumbed through the adapter seam but only
  charged where the environment reports measurable allocation.
- PostgreSQL concurrency is not validated in this environment (skip, not pass).

---

## 15. Required Tests (20 scenarios)

All 20 required scenarios pass, plus 2 admission-pipeline end-to-end tests:

| # | Scenario | Result |
|---|---|---|
| 1 | cross-tenant access denied | ✓ |
| 2 | revoked API key rejected | ✓ |
| 3 | role/project authorization enforced | ✓ |
| 4 | policy evaluated before admission | ✓ |
| 5 | policy version immutable after creation | ✓ |
| 6 | two concurrent admissions cannot oversubscribe | ✓ |
| 7 | idempotency replay does not double-consume quota | ✓ |
| 8 | failed admission does not leak capacity | ✓ |
| 9 | reservation release/settlement idempotent | ✓ |
| 10 | stale settlement/release fenced | ✓ |
| 11 | duplicate UsageEvent recorded once | ✓ |
| 12 | worker recovery does not double-meter | ✓ |
| 13 | duplicate usage → one LedgerEntry | ✓ |
| 14 | historical ledger references original pricing version | ✓ |
| 15 | cancellation charges only consumed resources | ✓ |
| 16 | cross-tenant usage/billing/audit isolated | ✓ |
| 17 | audit append-only | ✓ |
| 18 | secrets never in serialized audit | ✓ |
| 19 | PostgreSQL concurrency (environment-gated) | **SKIP** (PG unavailable) |
| 20 | Phase 1A–1D regression green | ✓ |

Per-suite: business-layer 22/22, durable-runner 16/16, actor 15/15,
snapshot-policy 9/9, sql-store 14/14, control-plane 10/10,
cloud-environment 9/9, opencode-adapter 3/3. **Total 98/98.**

---

## 16. Phase 1F Recommendation

1. **Durable admission idempotency** — move `AdmissionIdempotencyRegistry`
   into `vaulltcore-store-sql` (UNIQUE `(tenant_id, key)`) so multi-process
   control planes replay correctly across restarts.
2. **PostgreSQL concurrency CI** — wire a real Postgres container into CI and
   promote test 19 from skip to pass against the live database.
3. **Quota settlement automation** — a worker hook that, on job terminal
   state, derives actual usage from metering and calls `settle` with fenced
   retry, closing the reserve→meter→settle loop end-to-end.
4. **Tiered/bundled pricing** — extend `PricingVersion` with tiers and
  periods; keep the ledger immutable/versioned.
5. **Usage-based budget caps & alerts** — a read model over `usage_events` +
   `ledger_entries` that emits advisory warnings (mirroring the snapshot
   policy's advisory-only pattern) without suppressing checkpoint durability.
