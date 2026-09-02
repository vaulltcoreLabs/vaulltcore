# Phase 2D — Connected Product Activation, OAuth, Trigger-to-Run Dispatch & Live Provider Conformance

**Status: COMPLETE.** 375 passed / 25 environment-gated skips / 0 failures. Zero TypeScript errors (`tsc --build`).

Phase 2D turns the Phase 2C provider capabilities into a real connected B2B
product. A customer connects an external provider, completes a secure
authorization lifecycle, creates declarative versioned triggers, receives
external events through durable verified ingress, matches those events
deterministically, and creates/re-drives automation runs safely through the
existing admission boundary — without a second agent runtime, workflow
engine, authorization model, credential model, or provider-specific core.

**Copy capabilities, not code.** OpenHands informed the product surface
(study in `docs/phase2c-openhands-study.md`); Vaulltcore's durable execution,
admission boundary, tenant isolation, and provider neutrality remain the
source of truth. OpenHands is NOT a runtime dependency and its source is NOT
reproduced.

Baseline: Phase 2C commit `e9fcaa1`.

---

## 1. Objective and baseline

Objective: deliver the full durable connected-product flow —

> Customer connects GitHub/GitLab/Linear/Slack or a model provider → Vaulltcore
> securely owns the connection lifecycle → external events enter through
> verified durable ingress → declarative versioned triggers match
> deterministically → each event/trigger identity dispatches once at the
> durable boundary → existing policy, authorization and quota admission decides
> whether work may start → an immutable automation run is created → the Phase 1
> execution kernel performs work with at-least-once recovery → artifacts,
> approvals, delivery, audit, metering and billing remain attached to the same
> durable business identity.

Baseline: Phases 1A–1F (durable execution, ownership fencing, recovery, SQL
durability, B2B economics, quotas, metering, billing, reconciliation, runtime
enforcement), 2A (immutable automation product model), 2B (artifacts, delivery,
scheduling, operations, recovery, SSE), 2C (credentials, integrations,
GitHub/GitLab, Linear/Slack, BYOK models, durable webhook ingestion).

## 2. Architecture

Phase 2D is additive. New code lives behind existing seams; no runner, no
agent runtime, no second authorization model.

| Area | Package | Responsibility |
|---|---|---|
| Connection lifecycle | `vaulltcore-credentials` | Durable OAuth connection state machine; authorization attempts + PKCE + state binding + one-time callback settlement + replay-safe callback; provider identity verification; credential persistence through the existing `ConnectionStore`/`SecretProvider`; refresh/degraded/revoked lifecycle. |
| OAuth adapters | `vaulltcore-credentials` (`oauth-adapter.ts`) | Provider-neutral `OAuthProviderAdapter` + `OAuthAdapterRegistry`; capability-driven (OAuth authorization-code, PKCE, refresh, webhook, api_key, app-installation, service-identity). No provider SDK in core. |
| Trigger model | `vaulltcore-automation` (`trigger.ts`, `trigger-store.ts`) | Immutable, versioned trigger definitions + revisions; declarative deterministic matching; trigger classes `webhook_event`/`schedule`/`manual`/`integration_event`; reuses Phase 2B scheduler (no second scheduling system). |
| Trigger → run dispatch | `vaulltcore-automation` (`dispatch.ts`) | Durable dispatch ledger; exactly-once per `(tenant, source_event_id, trigger_id)`; admission → run creation through a narrow `TriggerRunSink` seam; honest policy/quota rejection; retryable recovery. |
| Model connection activation | `vaulltcore-models` (`connection-service.ts`) | BYOK register/verify/activate/deactivate/revoke; tenant `ModelRestrictions`; bounded explicit connectivity probe (no uncontrolled discovery). |
| Control plane | `vaulltcore-control` (`phase2d-routes.ts`) | Authenticated, tenant-safe routes for connections, OAuth callback, triggers, dispatches, provider capabilities. |
| Live conformance | per-adapter `test/live-conformance.test.ts` | Tier C env-gated live tests (GitHub, GitLab, Linear, Slack, OpenAI, Anthropic, Google); honestly skipped when unconfigured. |

Only Phase 1 file touched: `vaulltcore-audit/src/contracts.ts` — purely
additive (Phase 2D audit event types appended to the `AUDIT_EVENT_TYPES`
const; type persisted as TEXT, no schema change). No Phase 1/2A/2B/2C
semantic invariant was weakened.

## 3. Package dependency graph

```
identity/policy
      │
credentials ──► integration ──► audit
      │              │
      │              ├──► git ──► delivery
      │              ├──► connectors ──► delivery
      │              └──► models
      │
automation ──► {trigger-store, store-sql, identity(types), audit}
      │
      └── dispatch ──► {trigger-store, automation(types), audit, identity(types)}
control ──► {automation, scheduler, ops, credentials, git, connectors, models, webhooks, integration}
webhooks ──► {integration, credentials, audit, store-sql}
```

Dependency direction is enforced and acyclic. The runner imports NONE of these.
`dispatch.ts` never imports the runner directly; it drives run creation
through the narrow `TriggerRunSink` seam the control plane implements over
`AutomationService.createRun`. The hard seam holds.

## 4. Connection lifecycle

```
disconnected
  → authorization_pending
  → authorization_verified
  → active
  → degraded
  → expired
  → revoked
  → disconnected
```

Transitions are explicit and validated by `assertConnectionTransition(from,
to)`. Invalid transitions fail deterministically with `409` (never silently
mutate state). A connection carries only safe metadata and references —
never raw OAuth access tokens, refresh tokens, authorization codes, or
client secrets outside the `SecretProvider` boundary.

Lifecycle operations:
- `createAuthorizationAttempt` — durable state/nonce generation, PKCE
  (`codeVerifier`/`codeChallenge`) where the provider supports OAuth
  authorization-code, expiry, state bound to `tenant/org/project/principal/
  provider/connection-attempt` BEFORE redirect.
- callback validation — one-time settlement; the attempt is consumed
  (`consume`) on first use; a duplicate callback returns the original
  outcome without re-exchanging or creating a contradictory state.
- credential persistence — the exchanged token is routed through the
  `SecretProvider`; only `secretRef` + `secretFingerprint` persist.
- provider identity verification — `verifyIdentity` after exchange; a
  connection activates ONLY after verification succeeds.
- refresh lifecycle — supported providers rotate the secret (identity stable)
  on refresh; a refresh failure transitions safely to `degraded` (recoverable)
  rather than `revoked`.
- revocation/disconnect — `revoke()` (terminal `revoked`) vs `disconnect()`
  (`disconnected`, re-authorizable); `CredentialResolver.resolve()` returns
  `null` for revoked/disconnected/expired.

## 5. OAuth trust boundary

- State is generated durably and bound to the authenticated principal BEFORE
  redirect; the callback NEVER trusts tenant/project/principal/provider scope
  from the request body/query alone.
- The OAuth callback (`GET /oauth/callback`) is UNAUTHENTICATED at the edge
  (the browser cannot present a Bearer token); the tenant is resolved FROM
  the durable state record (`getByStateGlobal`), then the binding is
  re-validated against the authenticated-ish scope encoded in the attempt.
- State is one-time and consumed on settlement; a replayed state cannot
  create a second credential or contradictory connection state.
- Expired authorization attempts are rejected.
- Wrong tenant/principal/project binding is rejected.
- PKCE `codeVerifier` is bound to the attempt and verified at exchange.
- No provider SDK is hard-coded into core; adapters implement
  `OAuthProviderAdapter.exchange`.

## 6. Provider capability model

Capabilities are represented explicitly, not via provider-name conditionals:

```
oauth_authorization_code
oauth_pkce
refresh_token
webhook
api_key
app_installation
service_identity
```

`OAuthAdapterRegistry.listCapabilities()` returns `AuthorizationCapability[]`
(`provider`, `family`, `methods`, `identityKind`, `supportsScopes`,
`supportsRefresh`, `supportsWebhooks`). The control plane uses capabilities,
not provider-name branches. GitHub/GitLab app-installation identity remains
distinguishable from user OAuth identity (`identityKind`), so authorization
semantics are not flattened into a generic string. BYOK model providers
retain explicit API-key connection flows (OAuth is not forced where it does
not genuinely apply).

## 7. Credential boundaries

- `CredentialResolver.resolve()` is the SOLE boundary where a usable secret
  crosses into a provider adapter. Revoked/disconnected/expired connections
  resolve to `null`.
- Only `secretRef` (opaque handle) + `secretFingerprint` (SHA-256) persist;
  raw tokens never appear in SQL, logs, audit metadata, errors, list-get
  endpoints, or JSON responses.
- `toPublicView` (control plane) strips secret-bearing fields from any
  external response.
- `lastUsedAt` is best-effort async, never an auth source.
- No ambient provider secrets through unrestricted `process.env`.

## 8. Trigger versioning

A trigger is NOT execution. A trigger is an immutable, versioned definition
associated with a specific automation version:

- `triggerId` + monotonic `revision` (any change = new revision; checksum
  verified on every load, corruption detected).
- Match criteria (`provider`, `eventKinds`, `resourcePattern` glob, optional
  `action`, optional `connectionId`, optional `selectors`) — declarative
  and deterministic ONLY. No arbitrary JavaScript or unbounded user code.
- `triggerRevision` is pinned into every dispatch so a historical match stays
  explainable against the definition active at match time — a newer revision
  never reinterprets a past match.
- Trigger classes: `webhook_event`, `schedule`, `manual`,
  `integration_event`. Schedule triggers reuse the Phase 2B scheduler
  (`scheduleId`); no second scheduling system.
- `enabled`/`disabled` state, fenced by revision CAS.

## 9. Event normalization

Provider adapters translate external payloads into a stable neutral
`NormalizedEvent` envelope preserving: event identity (`eventId` +
`providerEventId`), `provider`, `kind`, `resource`, `action`,
`occurred`/`received` timestamps, tenant/project/connection resolution
references, resource identity, actor identity when safely available, and the
normalized `payload`. Unknown event types remain safely representable
(`kind: "custom"`) without corrupting the event stream. Credentials and
authorization headers are never retained in raw payload storage. Raw
payload is retained for forensics only behind the webhook store's
quarantine, never exposed.

## 10. Webhook-to-run sequence

```
External Event
  → verify (HMAC, constant-time)
  → durable webhook event (UNIQUE (tenant, eventId) dedup linearization)
  → normalize (provider adapter → NormalizedEvent)
  → resolve tenant/project/connection (from route/signature, NEVER body)
  → find eligible triggers (durable revisions active now)
  → deterministic match (declarative criteria only)
  → reserve durable dispatch identity (UNIQUE per event/trigger)
  → admission pipeline (policy/quota) — NEVER bypassed
  → automation run creation (Phase 2A, idempotent on triggerId)
  → existing execution lifecycle (at-least-once)
```

The webhook package remains responsible for durable ingress and deduplication.
Trigger dispatch happens AFTER durable persistence, never as an unprotected
side effect of request processing. A webhook request NEVER executes an agent.

## 11. Dispatch state machine

```
received/matched → dispatching → admitted → run_created   (terminal)
                              ↘ rejected (policy/quota/invalid_input/disabled_trigger)  (terminal)
                              ↘ retryable_failure → (redrive) → run_created / rejected / dead_letter
                              ↘ dead_letter  (terminal, exhausted attempts)
```

- `reserveDispatch` is the linearization point: `UNIQUE (tenant_id,
  source_event_id, trigger_id)` is the exactly-once boundary. A duplicate
  match returns the existing dispatch without creating new work.
- `driveDispatch` honors disabled triggers (rejected, no run), policy/quota
  rejection (honest, terminal, never retried as infra), and retryable infra
  failure (`retryable_failure`, re-driveable).
- `redrive` re-drives non-terminal dispatches idempotently (the dispatch
  identity is unique, so re-driving never duplicates). After `maxAttempts`
  it dead-letters honestly.

## 12. Exactly-once vs at-least-once boundaries

- **Exactly-once only at durable identity boundaries:**
  - webhook dedup: `(tenant, provider, providerEventId)` / `(tenant, eventId)`
  - dispatch: `(tenant, source_event_id, trigger_id)`
  - automation run: `(tenant, runId, idempotencyKey)`
  - delivery settlement: `(tenant, runId, idempotency_key)`
  - schedule occurrence: `occ:<scheduleId>:<scheduledTime>`
- **Execution stays at-least-once.** A crash after dispatch reservation but
  before run projection recovers by reconciliation/re-drive, NOT by blindly
  creating another dispatch. The dispatch identity is unique; re-driving
  re-projects the run idempotently through `AutomationService.reconcileRun`.
- **Never claim exactly-once execution.** Provider execution remains
  at-least-once; settlement is exactly-once only at the durable identity
  boundary.

## 13. Admission/policy/quota interaction

Trigger dispatch NEVER bypasses admission. `TriggerRunSink.createRunForTrigger`
routes through the Phase 1E admission pipeline (authenticate → authorize →
idempotency → `policy.evaluate` → `quota.reserve` → `runner.createJob` with
compensation). A policy/quota denial is surfaced as a typed
`TriggerRunRejection` (`kind: "policy"|"quota"|"invalid_input"`) and recorded
as `rejected` (terminal) — NEVER silently retried as infrastructure failure.
Tenant is derived from the authenticated principal, never the request body.
A disabled trigger creates no run.

## 14. Recovery algorithm

> The durable watermark and authoritative records are the sole progress source.

`TriggerDispatchService.redrive`:
1. List non-terminal dispatches (`listPending`) ordered by `createdAt`.
2. If `attempts >= maxAttempts`, dead-letter honestly.
3. Re-hydrate a minimal `NormalizedEvent` from the dispatch's source (the full
   payload is held by the durable webhook store); re-derive the match identity
   from the trigger revision PINNED into the dispatch.
4. Re-drive through `driveDispatch` (idempotent on `dispatchId`).

Recovery NEVER invokes an agent directly, NEVER bypasses admission, NEVER
duplicates a committed dispatch identity, and NEVER reinterprets a historical
trigger definition using a newer revision.

## 15. Model/BYOK activation

`ModelConnectionService` finishes the deferred BYOK path:
- register a supported model connection (`family: "model"`); the raw API key is
  routed through the `SecretProvider` by the caller; only `secretRef` +
  `secretFingerprint` persist.
- `verifyConnectivity` — a bounded, explicit one-token probe (NOT automatic
  model discovery that makes uncontrolled provider calls). The secret crosses
  the resolver boundary only, transiently, for the probe; it is never
  logged/returned/audited.
- activate/deactivate/revoke; `deactivate` → `degraded` (cannot resolve);
  `revoke` → `revoked` (terminal).
- tenant `ModelRestrictions` (`allowedProviders`/`allowedModels`/
  `maxInputTokens`/`maxOutputTokens`) enforced by `ModelRegistry` at resolve.
- inspect safe metadata + health (no secret).
- Model selection continues through `ModelRegistry → CredentialResolver →
  ModelProviderAdapter → existing AgentEngine/ModelProvider seam`. No second
  LLM abstraction. The models package never depends on the runner.

## 16. Provider conformance tiers

- **Tier A — deterministic local tests** (fakes/PGlite). ALWAYS run. Proves
  the neutral OAuth adapter contract, dispatch invariants, model connection
  isolation.
- **Tier B — provider-neutral contract tests** every adapter must satisfy
  (capability metadata, exchange routing through `SecretProvider`,
  no-silent-fallback on unregistered provider).
- **Tier C — live vendor conformance**, env-gated and HONESTLY skipped when
  credentials/services are absent. A skipped live test is a SKIP, never a fake
  pass. Live tests use dedicated test resources and cleanup; they never run
  destructive operations against arbitrary production resources.

## 17. Security model

- OAuth state cannot be replayed (one-time, consumed on settlement).
- Expired authorization attempts are rejected.
- Wrong tenant/principal/project binding is rejected.
- Duplicate callback cannot create contradictory state; retry is idempotent.
- Cross-tenant/cross-project (no grant) connection access returns `404` (no
  existence leak).
- Credentials never appear in responses/audit/errors.
- Refresh failure → `degraded`/`expired` (recoverable, not revoked).
- Revoked/disconnected/expired connection cannot resolve a credential.
- Forged integration event cannot dispatch work (HMAC verification →
  unverified → nothing persisted).
- Duplicate webhook event cannot duplicate a dispatch (UNIQUE dispatch
  identity).
- One event matching N triggers → N dispatches (one per trigger identity).
- Crash between dispatch reservation and run creation recovers without
  duplicate dispatch (re-drive idempotent on `dispatchId`).
- Policy rejection never starts execution.
- Quota rejection never starts execution.
- Retryable infrastructure failure re-drives safely.
- Disabled trigger creates no run.
- Historical trigger matching remains explainable after trigger update
  (revision pinned into the dispatch).
- Model connection isolation is tenant/project safe.
- Live provider tests skip honestly when unconfigured.
- No SSRF (loopback/RFC1918/link-local blocked before outbound; URL userinfo
  stripped). `redactSecrets`/`redactHeaders` strip bearer/userinfo/token=
  from errors.

## 18. Migration design

Migrations are name-globally-unique (the Phase 1F migration-ledger
dedup-by-name correction is preserved — different packages intentionally use
overlapping version numbers). Durable concepts:

- authorization attempts (`oauth_authorization_attempts`) — state nonce
  (UNIQUE), PKCE, binding, expiry, one-time outcome settlement.
- connections (`provider_connections`) — extends the Phase 2C connection
  table with OAuth lifecycle fields (rotated-from, expires-at, last-used).
- trigger definitions/revisions (`automation_triggers`) — revision +
  checksum; `UNIQUE (tenant, org, project, name)`; immutable-on-load.
- trigger dispatches (`automation_trigger_dispatches`) — `UNIQUE (tenant_id,
  source_event_id, trigger_id)` exactly-once boundary; fenced state
  transitions; `attempts`/`last_error`.
- dead-letter records — represented as the terminal `dead_letter` dispatch
  state (no separate table needed).

All state-changing writes are fenced by version CAS / state guards. No
secrets in these tables.

## 19. Failure scenarios

- **Crash after job creation before projection:** `AutomationService.reconcileRun`
  re-projects from committed events + idempotently re-drives; never duplicates
  work.
- **Crash after dispatch reservation before run creation:** the dispatch is
  `retryable_failure`; `redrive` re-drives idempotently (unique dispatch
  identity → no duplicate).
- **Duplicate webhook:** dedup linearization (`UNIQUE (tenant, eventId)`)
  returns the original; never re-enqueues or re-dispatches.
- **Policy/quota denial:** terminal `rejected`; never retried as infra.
- **Refresh failure:** `degraded` (recoverable); resolver returns null only
  for revoked/disconnected/expired.
- **Forged webhook:** unverified → nothing persisted; no existence leak.
- **Webhook replay (timestamp):** stale/future rejected; dedup on eventId.
- **Provider HTTP 401/429/5xx:** classified `auth_config`/`rate_limited`/
  `transient`; retryable classes re-drive; permanent terminal.
- **Superseded worker (partition):** fenced generation — superseding
  generation can never complete superseded work.

## 20. Test matrix

| Suite | Proves | Tests |
|---|---|---|
| `vaulltcore-credentials/test/oauth-lifecycle.test.ts` | OAuth trust boundary (proofs 1-6, 8-10) | 9 |
| `vaulltcore-credentials/test/conformance.test.ts` | Tier A+B neutral adapter contract | 4 |
| `vaulltcore-automation/test/trigger-dispatch.test.ts` | Dispatch boundary (proofs 11-19) | 9 |
| `vaulltcore-models/test/model-connection.test.ts` | BYOK activation + isolation (proof 8, 10, 20) | 5 |
| `vaulltcore-git/test/live-conformance.test.ts` | Tier C GitHub/GitLab (env-gated) | 1 + 2 skipped |
| `vaulltcore-models/test/live-conformance.test.ts` | Tier C OpenAI/Anthropic/Google (env-gated) | 1 + 3 skipped |
| `vaulltcore-connectors/test/live-conformance.test.ts` | Tier C Linear/Slack (env-gated) | 1 + 2 skipped |
| (full suite) | no regressions vs Phase 2C baseline | 375 passed / 25 skipped |

## 21. Skipped-test policy

A skipped live test is a SKIP, never a fake pass. Every Phase 2D skip is
environment-gated on a missing credential/resource:

| Provider | Gate env vars | Skip reason |
|---|---|---|
| GitHub | `GITHUB_TEST_TOKEN`, `GITHUB_TEST_REPO` | no live GitHub test creds |
| GitLab | `GITLAB_TEST_TOKEN`, `GITLAB_TEST_PROJECT` | no live GitLab test creds |
| Linear | `LINEAR_API_KEY` | no live Linear test creds |
| Slack | `SLACK_TEST_TOKEN` | no live Slack test creds |
| OpenAI | `OPENAI_TEST_API_KEY`, `OPENAI_TEST_MODEL` | no live OpenAI test creds |
| Anthropic | `ANTHROPIC_TEST_API_KEY`, `ANTHROPIC_TEST_MODEL` | no live Anthropic test creds |
| Google | `GOOGLE_TEST_API_KEY`, `GOOGLE_TEST_MODEL` | no live Google test creds |
| PostgreSQL (multi-conn) | `PG_TEST_*` | no PG server provisioned |
| Docker | `DOCKER_CMD` / daemon | no Docker daemon |
| PGlite server | `PG_TEST_*` | no PG server provisioned |

The 18 baseline skips (10 PG + 7 Docker + 1 pglite-server) are unchanged from
Phase 2C; the 7 new skips are the live-conformance gates above. No failing
test was converted to a skip.

## 22. Production deployment notes

- Provision a `SecretProvider` implementation (KMS/Vault-backed) — never the
  in-memory provider in production.
- Provision the OAuth redirect base URL publicly so external providers can
  reach `GET /oauth/callback`.
- Configure the `OAuthAdapterRegistry` with the provider adapters you
  support; unsupported capabilities throw `CapabilityUnsupportedError`
  honestly (never pretend).
- Provision PostgreSQL for multi-connection durability (PGlite is for tests).
- Provision the Phase 1D worker + Phase 2B ops worker for dispatch re-drive
  and operational work (delivery retry, abandoned run, snapshot GC).
- Rate-limit `/oauth/callback` and webhook ingress; both are unauthenticated
  at the edge (state/signature verified, not Bearer).
- Configure tenant `ModelRestrictions` per business policy.
- Live conformance gates are opt-in via env vars; they do not run unless a
  credential is present.

## 23. Limitations

- The OAuth callback handler resolves the tenant from the durable state
  record (unauthenticated edge); production should additionally bound callback
  latency and rate.
- Model `verifyConnectivity` is a one-token probe, not full model discovery;
  discovery is explicit and bounded, never automatic.
- The execution graph remains deliberately constrained (no loops/parallel/
  recursion) — Phase 2A's constraint is unchanged.
- Provider execution remains at-least-once; exactly-once is claimed ONLY at
  the durable identity boundaries listed in §12.
- Live conformance is minimal (one read-only identity/branch probe per
  provider); it proves authentication, not the full product flow.

## 24. Phase 2E recommendation

- Full control-plane HTTP integration tests over PGlite for the Phase 2D
  routes (currently typechecked + unit-tested; end-to-end HTTP coverage
  deferred).
- OAuth callback state replay protection hardened with a signed, short-TTL
  cookie bound to the principal session (in addition to the durable state
  record).
- Trigger filter criteria extended with a safe declarative expression subset
  (currently literal + glob; no JMESPath) once a security review of the
  evaluator is complete.
- Webhook trigger → `AutomationService` run dispatch wiring with
  `idempotency_key` derived from the dispatch identity (currently the sink
  seam is in place; the live wiring across the control plane is the next
  integration step).
- Live provider conformance expanded to write-then-cleanup flows
  (create-then-delete a test issue/PR/channel) behind the same env gates.
