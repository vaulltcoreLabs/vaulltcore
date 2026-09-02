# Phase 2F — Durable Metering, Immutable Usage Ledger, Cost Attribution & B2B Usage Governance

## 1. Objective

Build Vaulltcore's durable, provider-neutral B2B metering and usage-accounting
foundation. Phase 2F lets the platform determine, safely and durably: which
tenant consumed a resource; which org/project/service identity initiated it
(where the existing model supports those dimensions); which immutable run or
operation caused the consumption; which model/provider/tool/runtime resource
was consumed; how much; when; whether a usage record has already been
accounted for; how usage maps to enforceable quotas; how to aggregate without
treating mutable summaries as the financial source of truth; and how
at-least-once execution retries avoid double-accounting.

This phase builds metering and billing **readiness**. It does NOT implement
payment capture, Stripe checkout, invoices, subscriptions, tax, currency
conversion, or card handling. The authoritative usage ledger comes first.

## 2. Core accounting invariant

Execution remains **at-least-once**. Usage accounting is **exactly-once** only
at explicit durable accounting identity boundaries. A retry may attempt to emit
usage more than once; the durable usage ledger ensures the same accounting
identity cannot be committed twice. A summary, cache, dashboard aggregate, or
telemetry stream is NEVER the authoritative source for billable usage. The
immutable durable usage ledger is authoritative.

## 3. Exact architectural flow

```
Phase 1 execution kernel (at-least-once)
  → committed JobEvents (authoritative execution history)
  → eventsToUsageAttributed(identity, events, attribution)   [Phase 2F]
  → validateUsageInput (reject negative/non-integer/unknown-kind/bad-unit)
  → SqlMeteringStore.record()  ── durable INSERT
       ON CONFLICT (tenant_id, job_id, kind, dedup_key) DO NOTHING  ← exactly-once
  → immutable usage_events row (authoritative ledger; never UPDATEd)
  → (optional) VersionedCostCatalog.attributeCost()  ← DERIVED cost, never authoritative
  → (optional) SqlBillingStore.chargeJobUsage / settleUsage  ← immutable ledger_entries
  → (optional) QuotaSettlementService.settleAgainstActualUsage()
       reads metered actuals → quota.settle() (idempotent + fenced)  ← no second quota authority
  → bounded /usage control-plane queries (derived aggregates; tenant-scoped)
  → reconciliation (reconcileJob re-projects + re-drives idempotently; NEVER executes an agent)
```

## 4. Package boundaries

Additive only. No Phase 1–2E package semantic was weakened. Dependency
direction is enforced and acyclic.

| Package | Role | Depends on |
|---|---|---|
| `@vaulltcore/metering` (extended) | immutable usage ledger + attribution + bounded queries + adapter | store-sql, runner (types) |
| `@vaulltcore/billing` (extended) | immutable cost ledger + append-only adjustments | store-sql, metering |
| `@vaulltcore/audit` (extended) | Phase 2F audit event types (additive) | — |
| `@vaulltcore/reconcile` (extended) | optional AttributionProvider in reconciliation deps | metering, automation, audit |
| `@vaulltcore/usage-governance` (NEW) | bounded query + cost catalog + quota settlement + job attribution | store-sql, metering, billing, quota |
| `@vaulltcore/control` (extended) | Phase 2F `/usage/*` routes (additive layer) | usage-governance + existing stores |

The runner is NOT modified. There is no second agent runtime, no second LLM
abstraction, no second quota authority, and no provider SDK in any core
package. The hard seam holds.

## 5. Authoritative ledger definition

`usage_events` is the append-only authoritative ledger. Each committed row:

- `event_id` (immutable identity of the row)
- `tenant_id`, `org_id`, `project_id` (tenant scope; isolation enforced)
- `job_id` (the immutable run that caused consumption)
- `kind` (normalized, validated `UsageKind`)
- `quantity` (non-negative integer; never float)
- `unit` (canonical per kind; mismatched units rejected)
- `dedup_key` (the **accounting identity** — durable UNIQUE with tenant+job+kind)
- `recorded_at` (epoch ms; deterministic ordering)
- `provider`, `model` (Phase 2F attribution — public identifiers only, never credentials)

Rows are immutable after commit. There is no UPDATE/DELETE path for usage
history. Corrections are append-only **adjustments** in `ledger_entries`
(referencing `original_entry_id`), never silent rewrites.

## 6. Accounting identity semantics

Identities are deterministic and derived from committed execution lifecycle
semantics (job id + durable event seq + bucket/attempt), never instance
state — so a fresh instance re-deriving usage over the same committed history
produces the SAME identities and the ledger records each fact exactly once.
`AccountingIdentity` builders: `tokens(jobId, seq, bucket)`,
`modelStep(jobId, seq)`, `tool(jobId, seq)`, `duration(jobId)`,
`snapshot(jobId, snapshotId)`, `providerRequest(jobId, seq)`.

The database UNIQUE `(tenant_id, job_id, kind, dedup_key)` is the
exactly-once boundary. A duplicate/concurrent/retried record returns the
existing row (`duplicated: true`) and never creates a second charge. The
`record()` return distinguishes: newly committed (`duplicated: false`),
already-committed duplicate (`duplicated: true`), invalid (throws
`MeteringError`), and transient infrastructure failure (throws a DB error —
retryable by the caller; the UNIQUE boundary keeps it idempotent).

## 7. Exactly-once accounting vs at-least-once execution

Execution is at-least-once. A retry may re-emit `eventsToUsageAttributed`
over the same committed history; because the dedup keys are derived from the
committed event seq (not the attempt count), the re-derivation produces the
same identities and `ON CONFLICT DO NOTHING` collapses the retry to one
durable charge. The dedup keys in `eventsToUsageAttributed` are IDENTICAL to
the legacy `eventsToUsage` keys, so adding attribution later never
double-accounts.

## 8. Usage kinds/units actually implemented

Only real measurements the runtime can truthfully provide are modeled. Each
known kind has a canonical unit; mismatched units are rejected. Quantities are
non-negative integers (no float).

- `model_tokens` — tokens
- `model_input_tokens` — tokens
- `model_output_tokens` — tokens
- `model_reasoning_tokens` — tokens (only when the runtime reports it)
- `model_request` — request
- `provider_api_request` — request
- `tool_call` — call
- `tool_invocation` — invocation
- `shell_execution` — execution
- `execution_duration` — ms
- `runtime_duration` — ms
- `environment_allocation` — allocation
- `snapshot_storage` — byte-ms

Unknown kinds are safely representable via the `allowCustomKind` escape hatch
(requires an explicit unit; never an unsafe cast) and `isKnownUsageKind`
returns `false` honestly. No metric unavailable from the runtime is ever
fabricated or guessed.

## 9. Model/tool/runtime instrumentation boundaries

Model attribution integrates through the existing
`ModelRegistry → CredentialResolver → ModelProviderAdapter → AgentEngine/ModelProvider`
seam. There is no new LLM abstraction. The adapter `eventsToUsageAttributed`
attaches public `provider`/`model` identifiers (resolved from the job spec,
never from credentials) to every produced usage event. The job attribution
provider (`jobAttributionProvider`) resolves provider/model from a
job→model lookup + a model→provider resolver; it returns `null` honestly when
attribution is unavailable — it never guesses a provider/model and never reads
credentials. Tool metering uses the committed `tool_response` JobEvent seam,
not log parsing. Execution duration is measured at explicit boundaries
(checkpoint event seq); cancellation/timeout produce no fabricated
post-terminal usage because metering derives only from committed events up to
the terminal boundary.

## 10. Cost attribution limitations

`VersionedCostCatalog` resolves a unit rate for `(provider, model, kind)` from
an immutable `PricingVersion` with optional provider/model-specific overrides.
Cost is **derived metadata** — the usage quantity remains authoritative
independently of cost. Unknown pricing resolves to `null` (honestly unknown,
never a guess). The pricing identity (`pricingId` + `version` + `effectiveAt`)
is traceable on any persisted attribution. A future price change ships a NEW
pricing version; it never rewrites a historical attribution persisted under an
earlier version. Amounts are integer micro-currency (rate × quantity); no
floating-point arithmetic for authoritative values. This is NOT live billing
— no invoices, payments, or tax are produced.

## 11. Quota reservation vs settlement

Two distinct concepts, not conflated:

- **Admission reservation** (Phase 1E quota): holds a concurrency slot before
  execution. Unchanged authority.
- **Post-usage accounting** (Phase 2F): `QuotaSettlementService` derives ACTUAL
  metered usage for a job from the immutable ledger and settles the job's
  reservation against it by calling the existing `quota.settle()` exactly
  once. It does NOT create a second quota authority.

Invariants: no double-settlement (a settled reservation returns its recorded
outcome, `duplicated: true`); no negative balances (actuals are summed from
non-negative ledger quantities; the concurrency hold is released exactly once);
no releasing already-settled reservations (settle/release are no-ops on
terminal states); no cross-tenant settlement (wrong-tenant id returns 404
indistinguishable from absence); no fabricated usage for a reservation with no
linked job (rejected honestly). Policy/quota rejection remains honest and
terminal — never retried as infrastructure.

## 12. Aggregate / reconciliation model

Aggregates/summaries are DERIVED data, recomputed from the immutable ledger
on every query — never a mutable summary table. `UsageQueryService` enforces
bounded ranges (`MAX_AGGREGATION_RANGE_MS` = 1 year), bounded page sizes
(`MAX_QUERY_LIMIT`), deterministic ordering `(recorded_at, event_id)`, and
cursor pagination. `queryAll` is capped by `maxPages`. Reconciliation
integrates with Phase 2E reliability: `reconcileJob` re-projects and
idempotently re-drives metering from committed events; the optional
`AttributionProvider` lets it attach provider/model attribution during
re-projection. Reconciliation NEVER invokes agent execution, NEVER fabricates
usage, NEVER alters immutable historical entries, NEVER double-commits
accounting identities. If a source usage event cannot be truthfully
reconstructed, it is surfaced as an observable reconciliation problem, not an
invented quantity.

## 13. Adjustment model

Adjustments are append-only. `recordAdjustment` inserts a new `ledger_entries`
row of `type='adjustment'` with its OWN unique accounting identity
(`UNIQUE (scope, idempotency_key)`), referencing `original_entry_id`, carrying
a typed `AdjustmentReason` and an optional sanitized note. It never mutates the
original quantity. A duplicate adjustment (same idempotency key) returns the
existing entry (`duplicated: true`). A cross-tenant original reference is
rejected (no existence leak). Adjustments are authorized (admin-governed) and
audited.

## 14. API surface

Phase 2F routes (registered additively when the `phase2f` layer is wired;
matched before generic routes):

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/usage` | bounded, paginated raw usage events | authenticated |
| GET | `/usage/summary` | derived aggregate over a filtered scope | authenticated |
| GET | `/usage/runs/:id` | per-job derived aggregate (cross-tenant → empty) | authenticated |
| GET | `/usage/ledger` | explicit bounded ledger query (same as /usage) | authenticated |
| POST | `/usage/reconcile` | trigger usage reconciliation | **admin only** |

Semantics: 401 unauthenticated; 404/no-existence-leak on inaccessible tenant;
422 invalid bounded filters / oversized limit / unbounded range; 409 fenced
conflict; secrets NEVER returned. Aggregates are DERIVED and never
authoritative. Tenant identity comes from the authenticated principal, never
the body. Reconciliation emits `usage_reconciliation_requested` +
`usage_reconciliation_completed` audit events (sanitized; no usage payload).

## 15. Migrations

Migration NAME is globally unique (Phase 1F dedup-by-name preserved). No
destructive migration. The metering store migration `metering_attribution`
adds the `provider`/`model` columns + index to `usage_events` (additive). The
billing store migration `billing_adjustments` adds `original_entry_id`/
`reason`/`note` columns + index to `ledger_entries`. All state-changing writes
remain fenced by UNIQUE constraints. No secrets are persisted in any
ledger/usage row.

## 16. Security / privacy rules

- No secrets, API keys, auth headers, credential-bearing prompts, or raw
  sensitive payloads in any usage record, ledger row, audit event, error, or
  API response.
- Attribution carries ONLY public provider/model strings (resolved from job
  spec), never credentials or secret references.
- Tenant identity from the authenticated principal, never the request body.
- Cross-tenant reads/settlement return 404/empty (no existence leak).
- Errors are bounded and redacted (no stack traces, no secret material).
- Reconciliation routes require explicit admin authorization.
- High-volume metering belongs in the usage ledger, NOT the audit log (audit
  records significant administrative actions only).

## 17. Known limitations

- No live payment/billing: no Stripe, invoices, subscriptions, tax, or
  currency conversion. The cost catalog produces derived estimates, not
  invoices.
- `JobAttributionProvider` resolves attribution from a job→model lookup the
  caller wires (e.g. from the job store / admission record); when that lookup
  is unavailable, attribution is honestly `null`.
- Provider usage metadata that the runtime does not return is represented as
  unavailable (never fabricated). Live provider conformance is env-gated and
  honestly skipped when credentials are absent.
- Materialized summary tables are intentionally NOT introduced; aggregates are
  recomputed. If future query/performance needs require materialization,
  reconciliation must be capable of detecting and repairing drift (the seam
  exists).

## 18. Future billing integration seam

The immutable usage ledger + immutable cost ledger + versioned pricing +
append-only adjustments are the authoritative foundation a future billing
phase can build on: a payment processor would read derived balances (never
mutate them), persist invoices as new ledger-linked records, and rely on the
existing idempotency boundaries. No billing work was done in this phase beyond
the seam and derived attribution.

## 19. Validation

- Tier A deterministic (PGlite — real PostgreSQL engine, ALWAYS runs):
  metering attribution/kinds/validation/idempotency/bounded queries/isolation
  (14), usage-governance cost catalog/bounds/quota-settlement/attribution (14),
  billing append-only adjustments/immutable pricing (5), control-plane
  `/usage/*` routes incl. 401/422/403/200 + cross-tenant empty + pagination +
  audit (10).
- Tier B multi-connection PostgreSQL server races: env-gated on `PG_TEST_*`
  (skipped honestly when no server is provisioned). PG skips are reported as
  skips, never passes.
- Tier C live provider conformance: env-gated (GitHub/GitLab/Linear/Slack/
  OpenAI/Anthropic/Google); honestly skipped when credentials are absent.
- The Node `node:sqlite` ExperimentalWarning is suppressed in the `test` npm
  script via `NODE_OPTIONS=--disable-warning=ExperimentalWarning` (targeted,
  only ExperimentalWarning).

### Verification commands / results

- `npm run typecheck` → `tsc --build packages/*` → **0 errors**.
- `npm test` → **437 passed / 25 environment-gated skips (10 PG + 7 Docker +
  1 pglite-server + 7 live-conformance) / 0 failures**.
- New tests added: **43** (14 metering + 14 usage-governance + 5 billing +
  10 control-plane).

### Files added / changed

Added:
- `packages/vaulltcore-metering/test/phase2f-metering.test.ts`
- `packages/vaulltcore-billing/test/phase2f-billing.test.ts`
- `packages/vaulltcore-usage-governance/` (new package: `src/contracts.ts`,
  `src/cost-catalog.ts`, `src/query-service.ts`, `src/quota-settlement.ts`,
  `src/attribution.ts`, `src/index.ts`, `package.json`, `tsconfig.json`,
  `test/phase2f-governance.test.ts`)
- `packages/vaulltcore-control/src/phase2f-routes.ts`
- `packages/vaulltcore-control/test/phase2f-routes.test.ts`
- `docs/phase2f.md`

Changed (additive only):
- `packages/vaulltcore-metering/src/contracts.ts` (attribution fields, kinds,
  validation, bounded-query types, AccountingIdentity)
- `packages/vaulltcore-metering/src/store.ts` (provider/model columns,
  bounded queries, aggregateFiltered, breakdownByKind)
- `packages/vaulltcore-metering/src/adapter.ts` (eventsToUsageAttributed)
- `packages/vaulltcore-metering/src/index.ts` (exports)
- `packages/vaulltcore-billing/src/contracts.ts` (AdjustmentReason,
  AdjustmentInput, AccountBalance, LedgerEntry fields)
- `packages/vaulltcore-billing/src/store.ts` (migration v12, LedgerRow,
  DEFAULT_PRICING, recordAdjustment/getEntry/listAdjustmentsFor)
- `packages/vaulltcore-audit/src/contracts.ts` (Phase 2F audit event types)
- `packages/vaulltcore-reconcile/src/service.ts` (AttributionProvider)
- `packages/vaulltcore-reconcile/src/index.ts` (export)
- `packages/vaulltcore-control/src/server.ts` (phase2f layer option + wiring)
- `packages/vaulltcore-control/src/index.ts` (export)
- `packages/vaulltcore-control/package.json` (usage-governance dependency)
- root `tsconfig.json` (usage-governance reference)

### Authoritative vs derived

- **Authoritative**: `usage_events` rows (immutable; exactly-once by
  accounting identity); `ledger_entries` rows (immutable charges + append-only
  adjustments).
- **Derived** (never authoritative; recomputable): `UsageQueryService`
  aggregates/summaries, `breakdownByKind`, `VersionedCostCatalog` cost
  attributions, `AccountBalance`.

### Confirmation

Execution remains at-least-once. Accounting is exactly-once ONLY at durable
accounting identity boundaries (`usage_events` UNIQUE
`(tenant_id, job_id, kind, dedup_key)`; `ledger_entries` UNIQUE
`(scope, idempotency_key)`; quota settlement idempotent + fenced). No
Phase 1–2E invariant was weakened.
