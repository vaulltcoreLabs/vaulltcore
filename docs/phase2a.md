# Phase 2A — Automation Product Layer

> **Status:** Complete. 208 passed / 17 environment-gated skips (10 PostgreSQL, 7 Docker) / 0 failures. TypeScript strict clean.

Phase 2A builds the customer-facing **Automation Product Layer** above the frozen
Phase 1 durable-execution kernel. It answers: *what does a B2B customer configure,
run, approve, and receive from Vaulltcore?*

The core hierarchy:

```
Tenant → Organization → Project → AutomationTemplate → AutomationVersion → AutomationRun
                                                                          ├── Inputs (durable revision)
                                                                          ├── Execution Job(s) (Phase 1)
                                                                          ├── Artifacts
                                                                          ├── Approval Gates
                                                                          └── Delivery
```

## 1. Architecture

A dedicated package, `packages/vaulltcore-automation`, owns all product logic.
The Phase 1 runner (`vaulltcore-runner`) is **not modified** and never imports
the product layer.

Dependency direction (enforced, no cycles):

```
identity / policy
       ↓
automation product layer (vaulltcore-automation)
       ↓
control-plane integration (vaulltcore-control → automation-routes.ts)
       ↓
Phase 1 runner contracts (vaulltcore-runner: JobEvent, JobState, JobMetrics)
       ↓
environment / agent engine
```

The automation package depends only on `@vaulltcore/runner` (types only),
`@vaulltcore/store-sql` (SqlStoreBase + dialect seam), `@vaulltcore/identity`
(ResolvedPrincipal, Role, authorization), and `@vaulltcore/audit` (append-only
sanitized audit). It does **not** depend on `vaulltcore-control`. Control depends
on automation, never the reverse.

### Modules

| File | Responsibility |
|------|----------------|
| `contracts.ts` | All product types: template, version, definition, run, input, artifact, approval, delivery, job mapping, events |
| `ids.ts` | Deterministic ULID-style id generators (template_, ver_, run_, apr_, dlv_, art_, map_) |
| `version.ts` | `stableString`, `definitionChecksum`, `verifyVersionChecksum`, `validateDefinition`, `validateStepGraph`, `buildVersion`, `executionOrder` |
| `input.ts` | `validateInput`, `buildInputRevision`, `contentChecksum` |
| `run.ts` | `buildRun`, run state-machine transitions (`isTerminalRunStatus`, `RUN_TRANSITIONS`) |
| `artifact.ts` | `buildArtifact`, `verifyArtifact`, `InMemoryArtifactStore` (ArtifactStore abstraction) |
| `approval.ts` | `buildApprovalRequest`, `authorizeApprover` (role-rank CAS), `ApprovalDecision` |
| `delivery.ts` | `DeliveryProvider` seam, `buildDeliveryAttempt`, `FakeDeliveryProvider` (deterministic test provider) |
| `projection.ts` | `projectStepEvents` (runner events → stable automation events), `stepStatusFromJobStatus`, `extractOutputs` |
| `store.ts` | `AutomationStore` contract + `SqlAutomationStore` (extends `SqlStoreBase`, dialect-aware) + `AUTOMATION_MIGRATIONS` |
| `store-memory.ts` | `InMemoryAutomationStore` (reference impl for tests; same contract, fenced CAS) |
| `service.ts` | `AutomationService` — the product aggregate root: create/archive template, publish version, create/advance/cancel/reconcile run, decide approval, deliver |
| `index.ts` | Public exports |

## 2. Product aggregate boundaries

Two distinct aggregates that must never merge:

- **`AutomationRun`** — the *product-level* aggregate. Owns the customer-facing
  lifecycle (validating → running → collecting → awaiting_approval → delivering →
  completed). Does not execute models.
- **`Job`** (Phase 1) — the *execution-level* aggregate. Owns durable
  checkpoints, events, ownership leases, recovery. The product layer observes it
  through a narrow `AutomationJobDispatcher` seam; it never touches runner
  internals.

The `JobMapping` `(runId, stepId) → jobId` is the durable bridge. It is unique,
so a restart never creates duplicate execution work for the same step.

## 3. Template / version model

**`AutomationTemplate`** — stable product identity with immutable ownership
(`tenantId`, `orgId`, `projectId`). States: `draft → active → archived`.
Archiving blocks new runs but preserves all historical versions and runs.

**`AutomationVersion`** — the immutable executable definition. Once published,
never mutated; any change creates a new version with a monotonic `version`
number. Carries a deterministic `checksum` over the canonical definition so
corruption is detectable on load. Constraints:

- `UNIQUE (template_id, version)` — no two versions share a number.
- Cross-tenant references rejected (`VERSION_SCOPE_MISMATCH`).
- Execution against a version not belonging to the requested template/project
  rejected (`VERSION_TEMPLATE_MISMATCH`).
- Checksum verified on every load; mismatch → `AutomationError` (corruption
  detected, never silently served).

## 4. Execution graph restrictions

Phase 2A is deliberately **not** a general workflow engine. The definition
supports one or more named steps, each with:

- stable `stepId`
- `execution` spec (engine, model, prompt template, limits: maxSteps/maxTokens/maxDurationMs, allowedTools)
- `inputMappings` (fieldId → placeholder)
- `outputMappings` (key → JSON path)
- `dependsOn` (step references)

`validateStepGraph` runs before publish and rejects:

- duplicate step IDs
- cycles (topological sort fails)
- missing dependencies (references a non-existent stepId)
- dependencies outside the version

No arbitrary loops or unbounded recursion. `executionOrder` produces a
deterministic topological order; steps run in that order, each receiving
upstream step outputs via prompt templating (`${steps.stepX.output.key}`).

## 5. AutomationRun state machine

```
created → validating_input → admitted → running → collecting → awaiting_approval → delivering → completed
                                                                                     ↘ (rejected) → rejected
                                                              (failed) → failed      (cancelled) → cancelled
                                                              (suspended)
```

Every transition is validated against `RUN_TRANSITIONS` and fenced by
`runVersion` (CAS). Illegal transitions throw without partially advancing the
run. Terminal states (`completed`, `failed`, `cancelled`, `rejected`) are
immutable. `suspended` is an explicit non-terminal park (e.g. changes_requested).

## 6. Input durability

Typed input contracts support: required/optional fields, `string`/`number`/
`boolean`/`json`/`artifact_ref` types, min/max/enum constraints.

Input is validated **before** any run or job is created — invalid input creates
nothing. The exact accepted input is frozen as an immutable `InputRevision`
(stored in `automation_run_inputs`) with a content `checksum`. Every job
mapping carries `inputRevisionId`, so every execution is traceable to the exact
input that produced it. Historical input is never silently replaced.

## 7. Job orchestration and recovery

`AutomationJobDispatcher` is the narrow seam:

```ts
interface AutomationJobDispatcher {
  dispatchAndRun(request: DispatchStepRequest): Promise<DispatchStepResult>
  listJobEvents(jobId: string, afterSeq?: number): Promise<readonly JobEvent[]>
  getJobState(jobId: string): Promise<JobState | null>
}
```

The control plane implements this (`AdmissionJobDispatcher`) over the existing
admission + runner contracts. The product layer:

1. derives an idempotency key `auto:${runId}:${stepId}` (collapses duplicate creates)
2. dispatches via the seam
3. records the durable `JobMapping`
4. observes committed `JobEvent`s
5. projects safe execution state into `AutomationRun` + step state + automation events

**Recovery:** if orchestration crashes after a job was created but before the
mapping was projected, `reconcileRun` re-projects from committed job events
(read-only) and, if the run is stuck in a non-terminal state, re-drives it
forward via `advanceRun`. Re-drive is idempotent: the dispatcher deduplicates on
`(runId, stepId)`, so **no duplicate execution work** is created — only the
interrupted projection completes. A fresh process rebuilds run state from the
durable store + job events.

## 8. Artifact model

`AutomationArtifact` is a durable product output, not a temp file:

- `artifactId`, `runId`, `versionId`, `stepId` (or null), `type`, `name`
- `contentRef` (opaque pointer into `ArtifactStore`), `checksum`, `size`
- immutable metadata

`ArtifactStore` is a vendor-neutral abstraction (`put`, `get`). Phase 2A ships
`InMemoryArtifactStore` for tests. No S3/R2/Cloudflare dependency. `verifyArtifact`
re-checks the checksum on every read (corruption detected before delivery).
Artifact records remain valid historical references even after delivery —
delivery stores a `resultRef`, but the artifact record is the source of truth.

## 9. Approval state machine

```
pending → approved | rejected | changes_requested | expired
```

`ApprovalRequest` carries immutable run/version identity, `minApproverRole`
(authorized via the existing identity role-rank system — no second auth model),
context artifacts, optional expiry, and decision actor/time/metadata (sanitized).

Decisions are **idempotent + fenced** (`approvalVersion` CAS):

- Two concurrent approvers cannot produce contradictory terminal decisions —
  the fenced CAS ensures exactly one wins; the loser throws a version conflict.
- Once terminally decided, the request cannot change.
- A run `awaiting_approval` does not continue execution or delivery until a
  valid `approved` decision permits it.
- `rejected` terminates the run; `changes_requested` parks it `suspended`.
- Replayed approvals return the original decision with no duplicate side effects
  (delivery is not re-driven).

## 10. Delivery guarantees

`DeliveryProvider` is a provider-neutral seam. Phase 2A ships
`FakeDeliveryProvider` (deterministic). A `DeliveryAttempt` has:

- stable `deliveryId`, `runId`, `idempotencyKey` (`delivery:${runId}:${destination}`)
- `destination`, `status` (`in_progress → delivered | failed`), `attemptCount`,
  `resultRef`, timestamps

Guarantees:

- **At-least-once delivery attempts** with **idempotent settlement**: a crash
  never falsely marks undelivered as delivered. The attempt transitions to
  `in_progress` (fenced) *before* calling the provider; only a confirmed provider
  result transitions to `delivered`. A crash mid-delivery leaves the attempt
  `in_progress` or `failed` — never falsely `delivered`.
- **Retry reuses the same delivery identity** (`UNIQUE (run_id, idempotency_key)`).
  A retry calls the provider with the same key; the provider deduplicates.
- Final delivery result is historically recoverable from `delivery_attempts`.

## 11. Product events vs runner events

Runner `JobEvent`s are execution evidence — internal, engine-specific, never
exposed as the customer API. The product layer projects stable, sanitized
**automation events** (append-only in `automation_events`):

```
automation.run.created
automation.run.admitted
automation.step.started
automation.step.progress
automation.step.completed
automation.artifact.created
automation.approval.requested
automation.approval.approved
automation.approval.rejected
automation.delivery.started
automation.delivery.completed
automation.run.completed
automation.run.failed
```

Projection is deterministic: the same committed job events always produce the
same automation events. Reconciliation re-derives them without creating new
execution work.

## 12. SQL schema and constraints

One migration (`automation_core`, version 2 within this package; name is
globally unique so the shared `schema_migrations` ledger applies it once across
all stores sharing the database). Tables:

| Table | Key constraints |
|-------|----------------|
| `automation_templates` | PK `template_id`; `UNIQUE (tenant_id, org_id, project_id, name)` |
| `automation_versions` | PK `version_id`; FK → templates (CASCADE); `UNIQUE (template_id, version)` |
| `automation_runs` | PK `run_id`; `run_version` fenced CAS on every transition |
| `automation_run_inputs` | PK `input_revision_id`; FK → runs (CASCADE); `checksum` |
| `automation_run_steps` | PK `(run_id, step_id)` — unique step identity per run |
| `automation_job_mappings` | PK `mapping_id`; `UNIQUE (run_id, step_id)` — no duplicate job per step |
| `automation_artifacts` | PK `artifact_id`; FK → runs (CASCADE); `checksum` |
| `approval_requests` | PK `approval_id`; `approval_version` fenced CAS on decide |
| `delivery_attempts` | PK `delivery_id`; `UNIQUE (run_id, idempotency_key)`; `delivery_version` fenced CAS |
| `automation_events` | PK `(run_id, seq)` — append-only, ordered |

All writes use `SqlStoreBase` fenced CAS (expected version) — a stale writer can
never overwrite a newer state. Cross-tenant reads return null (no existence leak).

## 13. Idempotency boundaries

| Operation | Identity boundary | Mechanism |
|-----------|-------------------|-----------|
| Run creation | `(tenant, idempotency_key)` | In-memory registry + store lookup; replay returns original run |
| Job dispatch | `(runId, stepId)` → `auto:runId:stepId` | Dispatcher deduplicates; `UNIQUE (run_id, step_id)` mapping |
| Approval decision | `(approval_id, approval_version)` | Fenced CAS; terminal decision immutable |
| Delivery | `(run_id, idempotency_key)` | `UNIQUE` constraint + fenced transition; provider deduplicates |
| Input revision | `input_revision_id` | Immutable row; checksum verified |

## 14. Exactly-once vs at-least-once

Execution remains **at-least-once** (Phase 1 invariant, unchanged). The product
layer adds **durable idempotent settlement at explicitly defined identity
boundaries**:

- A job may be dispatched more than once (crash + retry), but the dispatcher
  deduplicates on `(runId, stepId)` — the *work* is not duplicated.
- A delivery may be attempted more than once, but settlement is idempotent on
  `(run_id, idempotency_key)` — the *delivered result* is not duplicated.
- An approval may be decided more than once (replay), but the terminal state is
  immutable — no duplicate side effects.

Vaulltcore does **not** claim exactly-once execution. It claims exactly-once
*settlement* at the durable identity boundaries.

## 15. Reconciliation behavior

`reconcileRun(principal, runId)`:

1. Re-projects existing job mappings from committed `JobEvent`s (read-only) —
   repairs missing step-state projections, automation events, and artifacts.
2. If the run is stuck in a non-terminal execution state (`admitted`/`running`/
   `collecting` — e.g. a crash left it before a mapping was saved), re-drives it
   forward via `advanceRun` (idempotent re-dispatch; no duplicate work).

Reconciliation **never** invokes agent execution directly. It reads `listJobEvents`
and projects forward. Safe to run repeatedly (idempotent). A fresh process can
rebuild complete run state from the durable store + job events.

## 16. Security / isolation model

Cross-tenant and cross-project isolation are mandatory. Every operation
authorizes via the existing Phase 1E `ResolvedPrincipal` + role-rank system:

- Template/version/run/artifact/approval/delivery access all check ownership.
- Client-supplied IDs are never trusted without validating tenant/project scope.
- Cross-tenant reads return `null` (no existence leak); cross-project access
  denied with `403`.
- A principal with no project grants has access to no projects (wildcard never
  synthesized from absence).

Audited actions (sanitized metadata via the existing audit approach):
template create/archive, version publish, run create/cancel, approval decisions,
delivery settlement, run failure/completion.

## 17. Known limitations

- **No general workflow engine:** no loops, parallel branches, or unbounded
  recursion. Steps run in a strict topological order.
- **Delivery providers:** only `FakeDeliveryProvider` shipped. Slack/email/
  webhooks deferred to Phase 2B.
- **Artifact storage:** only `InMemoryArtifactStore`. S3/R2 integration deferred.
- **Approval expiry reaper:** `expireApproval` exists but no scheduled reaper;
  expired approvals block until explicitly resolved or expired on read.
- **Tier B PG multi-connection tests:** not added (matching Phase 1F; Tier A
  PGlite conformance proves SQL-level invariants against real PostgreSQL).
- **No SSE streaming of automation events** in the control routes yet (events
  are queryable via `GET /automation/runs/:id/events`).

## 18. Recommended Phase 2B

- SQL-backed `ArtifactStore` (S3/R2 content + SQL metadata).
- Real delivery providers (webhook, Slack, email) with retry/backoff.
- Scheduled approval-expiry reaper + delivery retry reaper.
- SSE streaming of automation events.
- Tier B PostgreSQL multi-connection conformance tests.
- Automation run triggers (cron/event) building on the scheduling seam.
- Artifact signing + provenance attestation.

## Control plane

Product-facing routes (extend the existing control plane; preserve auth,
tenant/project authorization, idempotency, audit, safe error semantics):

```
POST   /automation/templates
GET    /automation/templates
POST   /automation/templates/:templateId/versions
GET    /automation/templates/:templateId/versions
POST   /automation/runs
GET    /automation/runs/:runId
GET    /automation/runs/:runId/events
GET    /automation/runs/:runId/artifacts
POST   /automation/runs/:runId/advance
POST   /automation/runs/:runId/cancel
POST   /automation/approvals/:approvalId/approve
POST   /automation/approvals/:approvalId/reject
POST   /automation/approvals/:approvalId/changes
```

Cross-tenant resources return `404` (no existence leak). The tenant is always
derived from the authenticated principal, never the request body.

## Phase 1 contract changes

The only Phase 1 file modified is `packages/vaulltcore-audit/src/contracts.ts`,
and the change is **purely additive**: new automation event types appended to the
`AUDIT_EVENT_TYPES` const array. The audit store persists `type` as `TEXT`, so
no schema migration is required. No Phase 1 semantic, invariant, or contract was
weakened or redesigned. The runner package is completely unmodified.

## Completion gate

```
npx tsc --build --clean
npx tsc --build        # exit 0, clean
npx vitest run         # 208 passed, 17 skipped, 0 failed
```

Skips (all environment-gated, never faked):
- PostgreSQL-gated (10): `postgres-conformance.test.ts` (8) + `postgres-conformance-1f.test.ts` (2) — require a live PG server at `/tmp/pgsock:5434`.
- Docker-gated (7): `docker-provider.test.ts` — requires Docker daemon.

Tier A PGlite conformance (9 tests, real PostgreSQL in-process) **always runs**
and proves the SQL-level invariants hold against genuine PostgreSQL.
