# Phase 2C — Enterprise Integration, BYOK & Connectivity Plane

**Status: COMPLETE.** 345 passed / 18 environment-gated skips (10 PG + 7 Docker + 1 pglite-server) / 0 failures. Zero TypeScript errors across all packages (`tsc --build`).

Phase 2C adds a provider-neutral enterprise connectivity layer so Vaulltcore
automations can securely connect to external systems (GitHub, GitLab, Linear,
Slack, S3/SMTP/LLM providers), bring their own models, and react to real
business events via durable webhooks — without Vaulltcore becoming dependent
on OpenHands, any single provider, any LLM vendor, or any cloud.

**Copy capabilities, not code.** OpenHands informed the product surface
(study in `docs/phase2c-openhands-study.md`); Vaulltcore's durable execution,
economic enforcement, tenant isolation, integration contracts, recovery
semantics, and provider neutrality remain the source of truth. OpenHands is
NOT a runtime dependency and its source is NOT reproduced.

---

## 1. Architecture

Six new packages, all additive, none modifying the runner:

| Package | Responsibility | Tests |
|---|---|---|
| `vaulltcore-credentials` | Durable credential/connection lifecycle (create/inspect/rotate/revoke/expire/refresh/disconnect/last-used); `CredentialResolver` + `ConnectionStore` + `ProviderCredential` + `ConnectionCapability`; replaceable `SecretProvider` seam; never plaintext. | 12 |
| `vaulltcore-integration` | Neutral provider seam (`IntegrationProvider`, `ProviderRegistry`), shared `verifyHmacSha256` (constant-time, `sha256=`/`v0=`), `deterministicEventId`, SSRF-guarded `ProviderHttpClient`, `classifyResponse`, `NormalizedEvent`, `ExternalMutation` idempotency identity. | 13 |
| `vaulltcore-git` | Neutral `GitProvider` contract + GitHub + GitLab adapters (OAuth/App identity, repo list/metadata, branches, file read/write, commits, branch/PR create+inspect, issue read/create/update, webhook verify + normalize). | 15 |
| `vaulltcore-connectors` | Neutral PM connector seam (`PmProvider`) + Linear (GraphQL) + Slack; webhook verify + normalize; reuses Phase 2B delivery guarantees. | 10 |
| `vaulltcore-models` | BYOK model plane: `ModelRegistry` → `CredentialResolver` → `ModelProviderAdapter`; OpenAI-compatible / Anthropic / Google adapters; immutable `ModelDescriptor` cost metadata; tenant `ModelRestrictions`. | 10 |
| `vaulltcore-webhooks` | Durable webhook gateway (verify → resolve → tenant auth → dedupe → persist → enqueue → audit) + `SubscriptionMatcher` fan-out. Never executes an agent in the request path. | 10 |

Only Phase 1 file touched: `vaulltcore-audit/src/contracts.ts` — purely
additive (10 new integration event types appended to the `AUDIT_EVENT_TYPES`
const; type persisted as TEXT, no schema change). No Phase 1/2A/2B semantic
invariant weakened.

## 2. Dependency graph (enforced, no cycles)

```
identity/policy
      ↓
credentials/integration/connectors/git/models/webhooks
      ↓
automation
      ↓
runner
      ↓
environment/engine
```

- `credentials` → {identity, store-sql, audit}
- `integration` → {credentials (types), audit}
- `git` → {integration, credentials, delivery}
- `connectors` → {integration, credentials, delivery}
- `models` → {credentials, integration}
- `webhooks` → {integration, credentials, audit, store-sql}

The runner imports NONE of these. The runner's `AgentEngine`/`ModelProvider`
seam remains authoritative; the models package emits neutral
`ModelStreamEvent`s that the agent layer (a future adapter above the runner)
bridges — no second agent runtime is created.

## 3. OpenHands study

See `docs/phase2c-openhands-study.md`. Adopted concepts (each: OpenHands
capability → Vaulltcore interpretation → location → why → rejected):

- **Token validation/provider detection** → `CredentialResolver` +
  `ProviderCredential.family` (credentials). Rejected: exporting secrets as
  env vars to a shared runtime (Vaulltcore resolves transiently per-call,
  never ambient).
- **GitHub/GitLab App installation** → `GitProvider` adapters with
  installation-id identity (git). Rejected: provider SDKs in core (narrow
  HTTP seam only).
- **litellm `provider/model` BYOK** → `ModelRegistry` + `ModelDescriptor`
  with `apiBase` from connection metadata (models). Rejected: litellm as a
  dependency; a single LLM abstraction that flattens provider differences
  (Vaulltcore keeps per-provider adapter shapes; only the neutral stream
  vocabulary is shared).
- **Webhook event triggering** → durable `WebhookGateway` + `SubscriptionMatcher`
  (webhooks). Rejected: executing the agent directly from the webhook
  request (Vaulltcore persists + enqueues, processes async).
- **Custom webhook sources / signature headers** → provider adapters
  declare their signature header; `verifyHmacSha256` handles `sha256=` and
  `v0=` forms (integration).

## 4. Integration contracts

`IntegrationProvider` (neutral seam in `vaulltcore-integration`):
- `kind: ProviderKind` (family + provider + label + capabilities)
- `verifyIdentity(credential)` → `ProviderIdentity`
- `verifyWebhook(raw, {secret})` → `WebhookVerifyResult` (verified + normalized event)
- git/providers additionally expose read + scoped mutation operations
  (`listRepos`, `readFile`, `createCommit`, `createPullRequest`, …), each
  carrying tenant scope via the resolved credential and an idempotency
  strategy (`ExternalMutation` identity) where mutation occurs.

No GitHub/GitLab/Linear/Slack types leak into the neutral contracts.

## 5. Credential lifecycle

`ConnectionStore` (durable, SQL-backed via `SqlStoreBase`):
- create / inspect metadata / rotate (new secretRef, same connectionId +
  account identity) / revoke / expire / refresh / disconnect / last-used
- states: `active` → `expired`/`revoked`/`disconnected`
- `CredentialResolver.resolve(tenantId, connectionId)` is the ONLY boundary
  where a usable secret crosses into an adapter: enforces lifecycle
  (active + not expired; revoked/disconnected/expired → null), dereferences
  the opaque `secretRef` through the configured `SecretProvider`, stamps
  last-used (best-effort, never an authorization source).
- **Secrets never appear** in API responses, logs, audit metadata, errors,
  list/get endpoints. Only a SHA-256 `secretFingerprint` is stored.
- Storage is replaceable (`SecretProvider` seam: in-memory for tests,
  pluggable for KMS/Vault in production). No single secret vendor hard-coded.
- Rotation changes the secret without changing connection identity.

## 6–9. Provider designs (GitHub / GitLab / Linear / Slack)

- **GitHub** (`git/github.ts`): HMAC-SHA256 webhook verify (`sha256=` form),
  event normalization (push/PR/issue/review/release → `NormalizedEvent`),
  idempotent PR creation (GET search before POST to dedupe on
  `tenant+connectionId+operationId`), App installation identity preferred
  over a global PAT.
- **GitLab** (`git/gitlab.ts`): same neutral `GitProvider`; OAuth identity,
  project listing, branches, file ops, commits, merge requests, issues,
  webhook verify + normalize. No GitHub types leak into the generic contract.
- **Linear** (`connectors/linear.ts`): GraphQL over `ProviderHttpClient`;
  workspace identity, teams, issue read/create/update, comments, status,
  labels, webhook verify + normalize. Generic `PmProvider` seam so Jira etc.
  can be added without redesign.
- **Slack** (`connectors/slack.ts`): workspace connection, channel mapping,
  authenticated outbound ops, `v0=` signature handling, reuses Phase 2B
  delivery guarantees (never bypasses them).

## 10. BYOK model plane

`ModelRegistry` → `CredentialResolver` → `ModelProviderAdapter`:
- Adapters: OpenAI-compatible (OpenAI, OpenRouter, Azure-compatible, generic
  gateways), Anthropic, Google (Gemini). No provider SDK is a core dependency.
- `ModelDescriptor` is immutable per version (cost metadata pinned; pricing
  changes ship a new descriptor, never rewrite history — Phase 1E billing
  immutability).
- Tenant `ModelRestrictions` (allowedProviders/models, maxInput/outputTokens)
  enforced by the registry. BYOK credentials flow ONLY through the resolver.
- Usage attribution: `ModelStreamEvent` usage events (input/output tokens)
  are compatible with Phase 1E metering (`eventsToUsage`).
- Error normalization: 401→auth_config, 429→rate_limited, 5xx/timeout→
  transient, 4xx→permanent_validation, via shared `classifyResponse`.
- The existing `AgentEngine`/`ModelProvider` seam remains authoritative; the
  models package does NOT depend on the runner and creates no second runtime.

## 11. Webhook architecture

```
HTTP webhook
  → verify signature (provider adapter; constant-time HMAC)
  → resolve integration → tenant + connectionId (NEVER from body)
  → tenant authorization
  → deduplicate provider event (UNIQUE eventId)
  → timestamp validation (stale/future rejection)
  → persist normalized event (durable)
  → enqueue trigger (durable; idempotent)
  → audit (accepted/rejected; sanitized, no secrets)
```

The request NEVER executes an agent. `eventId = sha256(tenant|provider|providerEventId)`
is the dedup linearization point (UNIQUE `(tenant_id, event_id)`): a duplicate
webhook returns `duplicate` and never re-enqueues. Raw events that fail
normalization are quarantined (forensics; never reprocessed as instructions).

## 12. Event fan-out

`SubscriptionMatcher` (provider-neutral): matches `NormalizedEvent` →
`Subscription`(provider, kinds, resource glob, actions) → `TriggerRequest`
with deterministic `triggerKey = trig:tenant:subscription:eventId`. No
one-off trigger logic per provider. The trigger is dispatched to the Phase 2A
automation layer, which applies its own run `idempotency_key` (exactly-once
at the run identity boundary). Execution stays at-least-once.

## 13. Security model

Threat-modelled + explicitly tested:
- cross-tenant credential access (resolver returns null; store get returns
  null on tenant mismatch — no existence leak)
- cross-project credential access
- revoked/expired credentials (resolve → null)
- webhook forgery (HMAC mismatch → `unverified`, nothing persisted)
- webhook replay (UNIQUE eventId dedup; timestamp stale/future rejection)
- SSRF (`SsrfGuard` blocks loopback/RFC1918/link-local before outbound; URL
  userinfo stripped by `redactUrl`)
- credential leakage (secrets redacted from logs/errors/events/audit/metrics/
  responses; only SHA-256 fingerprint stored)
- malicious repo URLs / path traversal (content-addressed artifacts, badRef
  rejected — Phase 2B artifacts)
- oversized payloads (bounded)
- unauthorized mutation (every op carries tenant + connection scope via
  resolved credential; idempotency identity on mutations)

## 14. Tenant isolation

Every integration is tenant-scoped and authorization-checked. Tenant identity
is derived from the authenticated principal (control plane) or the
route/signature secret (webhooks) — NEVER from the request body. Cross-tenant
reads return null/404 (no existence leak) on every path.

## 15. Idempotency boundaries

| Boundary | Identity | Guarantee |
|---|---|---|
| Webhook dedup | `tenant + provider + providerEventId` (eventId) | at-most-once ingest |
| External mutation | `tenant + connectionId + operationId` | idempotent settlement (replay returns original result) |
| Automation trigger | `tenant + subscriptionId + eventId` | at-most-once trigger |
| Automation run | `tenant + runId + idempotencyKey` (Phase 2A) | exactly-once run creation |
| Provider execution | — | at-least-once (never claim exactly-once) |

Execution stays at-least-once; exactly-once is only at durable identity
boundaries (event/ledger/run). Provider execution is NEVER claimed exactly-once.

## 16. Recovery model

Provider outages never corrupt durable execution state. Retry classification
(transient/rate_limited/auth_config/permanent_validation/provider_rejection/
unknown_uncertain) is shared via `classifyResponse`. A worker retry re-drives
stuck triggers idempotently (UNIQUE eventId prevents duplicate work; Phase 2A
`reconcileRun` re-projects from committed events without invoking the agent).
Recovery NEVER invokes the agent merely to repair integration projections.

## 17. Provider conformance

Provider-neutral conformance suites in each package test: authentication,
authorization, read ops, mutation ops, retry behavior, idempotency, error
normalization, revocation behavior, webhook verification, tenant isolation.
Live-vendor tests are environment-gated and honestly skipped (never fake
passes). PGlite (real PostgreSQL) continues to run in every suite.

## 18. Deployment model

The HTTP process is never the long-running job owner (Phase 1D rule): a
webhook request transactionally persists the normalized event + enqueues a
trigger, then returns. Workers process triggers asynchronously and restart
independently without losing correctness. Credentials live behind a
replaceable `SecretProvider` (KMS/Vault in production).

## 19. Limitations

- **Control-plane HTTP routes** for connections/credentials/repos/providers/
  webhooks/subscriptions/BYOK models/integration health are designed but
  deferred to Phase 2D (additive `phase2c` layer over the control facade);
  all Phase 2C functionality is testable via the packages directly.
- **Live provider conformance** (real GitHub/GitLab/Linear/Slack/OpenAI/
  Anthropic/Google) is provider-dependent — adapters are proven locally
  against fake HTTP/SSE responders + PGlite, not against live vendor APIs.
- **OAuth callback flows** (state issuance, code exchange, state replay
  protection) are contract-level; the full HTTP callback handler is deferred.
- **Model provider discovery** (listing a tenant's available models) is
  capability-metadata-only where safe; live `/models` enumeration is deferred.

## 20. Explicitly rejected approaches

- OpenHands as a runtime dependency — rejected.
- Reproducing OpenHands source — rejected.
- Provider SDKs in core packages — rejected (narrow HTTP/protocol seam only).
- A single flattened LLM abstraction that hides provider differences —
  rejected (per-provider adapter shapes; only the neutral stream vocabulary
  is shared).
- Executing the agent directly from a webhook request — rejected (persist +
  enqueue, process async).
- Exactly-once provider execution — rejected (at-least-once execution;
  exactly-once only at durable identity boundaries).
- Ambient secrets exported as env vars to a shared runtime — rejected
  (transient per-call resolution through the resolver boundary).
- A second agent runtime — rejected (the `AgentEngine` seam stays
  authoritative).
- Hard-coding one secret-management vendor — rejected (replaceable
  `SecretProvider`).

## 21. Phase 2D recommendations

1. Control-plane `phase2c` HTTP routes (connections, credentials metadata,
   OAuth lifecycle, repos, providers, webhook status, subscriptions, BYOK
   models, integration health) over the existing facade — additive, tenant-
   scoped, idempotent where mutating.
2. OAuth callback handler (state issuance + code exchange + state replay
   protection) wired to the credential connection lifecycle.
3. Live provider conformance harness (environment-gated on
   `GITHUB_TEST_TOKEN` / `GITLAB_TEST_TOKEN` / `LINEAR_API_KEY` /
   `OPENAI_API_KEY` / …) — honestly skipped when unavailable.
4. Bridge neutral `ModelStreamEvent` → runner `ModelProvider` adapter so a
   job can execute against a tenant BYOK model (adapter above the runner;
   runner unchanged).
5. Webhook trigger → automation run dispatch wiring (connect
   `SubscriptionMatcher` triggers to `AutomationService` with run
   `idempotency_key` derived from `triggerKey`).

## Validation tiers (honest)

- `proven locally`: all package unit/security/tenant-isolation/idempotency/
  webhook-replay/conformance tests over fake HTTP/SSE + PGlite (345 passed).
- `provider-conformance tested`: neutral conformance suites exist; live
  vendor execution is provider-dependent and environment-gated (deferred).
- `provider-dependent`: live GitHub/GitLab/Linear/Slack/OpenAI/Anthropic/
  Google calls — deferred to Phase 2D harness.
- `deferred`: control-plane routes, OAuth callback handler, model discovery,
  trigger→run dispatch wiring.
