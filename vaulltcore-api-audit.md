# Vaulltcore Backend — Frontend Integration Forensic API Audit

**Repo**: `vaulltcore` monorepo (npm workspaces) · **Baseline HEAD**: `c606cd1f5bb26cc1b0cc5909207dce63bc341b75`
**Audit type**: READ-ONLY · **Mode**: Source-of-truth hierarchy enforced (implementation > types > validation > schema > tests > config > docs)
**Scope**: Control-plane HTTP API surface + domain packages that the frontend must integrate against.

> Status legend: **CONFIRMED** = read directly from implementation. **INFERRED** = derived from types/tests/adjacent code. **UNKNOWN** = not determinable from repo.
> Every material claim carries `File:Line` evidence. Where an endpoint/behavior is absent, that absence is itself a finding.

---

## 1. Executive Summary

Vaulltcore exposes a single Node HTTP control plane (`packages/vaulltcore-control`) whose entrypoint is `serve.ts` (port 3000). The API is a **layered, additive** set of Phase routes (1C jobs, 2A automation, 2B schedules/deliveries/metrics/SSE, 2D connections/oauth/triggers, 2E reliability/ops, 2F usage, 2G identity/auth). All `/identity/*` and `/auth/*` routes are gated behind a `phase2g` layer that **is not wired into the production `serve.ts`** (see §40). All tenant-scoped routes resolve identity from the **authenticated principal**, never the request body. Cross-tenant access returns `404` (no existence leak). Secret material (API keys, OAuth secrets, credential secrets) is **never** returned in list/get/lifecycle responses; issuance returns a secret exactly once.

**Top integration risks for the frontend team**:
1. **No authentication endpoint is actually mounted in the shipped server** — `/auth/*` (Better Auth sign-up/sign-in) and `/identity/*` are only assembled in the test harness, not `serve.ts` (§4, §40).
2. **No org- or project-creation endpoint exists** anywhere in the route surface (§9, §40).
3. **No audit-log read endpoint exists** — audit is append-only internal (§12, §40).
4. **Timestamps are epoch-ms `number`s**, not ISO strings — frontend must parse as numbers (§28).
5. **IDs are opaque prefixed monotonic strings** (`job_`, `run_`, `tmpl_`, `ver_`, `apr_`, `dlv_`, `trg_`, `dsp_`, …) — never construct or parse them (§28).
6. **Most list endpoints are unpaginated** (full arrays); only SSE (`after` seq cursor) and `/usage*` (cursor) paginate (§11).

---

## 2. Audit Methodology & Source-of-Truth Hierarchy

- Repository cloned/read at baseline SHA; no files modified, no installs, no migrations.
- For every endpoint: located route registration → traced handler → traced service/store call → read request/response shaping → read error mapping → cross-checked types.
- Where the implementation and a doc/comment disagreed, the **implementation won.
- Focused subagents extracted per-file contract tables (automation-routes, phase2b, phase2d, phase2e/2f, server) and deep-read `vaulltcore-auth`, `vaulltcore-identity/policy/quota`, `vaulltcore-metering/billing/audit/usage-governance`, and the integration adapters (git/models/credentials/webhooks/connectors/integration/delivery/artifacts).

---

## 3. Repository Structure Overview

- 29 packages under `packages/`. Control plane = `packages/vaulltcore-control/src/*`.
- Entry: `serve.ts` → builds stores (Postgres via `pg` if `DATABASE_URL` set, else SQLite `node:sqlite`), a `WorkerHost`, an OpenCode runner, and a `ControlPlane` that `dispatch()`es requests.
- Packages of interest to the frontend: `vaulltcore-control` (HTTP), `vaulltcore-identity`, `vaulltcore-auth`, `vaulltcore-automation`, `vaulltcore-scheduler`, `vaulltcore-ops`, `vaulltcore-credentials`, `vaulltcore-models`, `vaulltcore-metering`, `vaulltcore-billing`, `vaulltcore-quota`, `vaulltcore-usage-governance`, `vaulltcore-audit`.
- Hard seam holds: runner (`vaulltcore-runner`) is neutral and never imports business/product packages; the control plane never adds business logic to the runner loop.

---

## 4. Authentication & Trust Boundaries

- **Public endpoints (no auth)**: `GET /health`; `GET /auth/*` (Better Auth bridge, *only if `phase2g.betterAuth` set*); webhook/OAuth external trust boundaries (not in control HTTP surface here).
- **Production auth path (intended)**: Better Auth session cookie → `ActorResolver` → `ResolvedPrincipal` for `/identity/*`. For all other routes, a `ControlAuthenticator` (`HeaderAuthenticator` by default) issues an `AuthnPrincipal{tenantId,orgId,projectId,admin}` (server.ts:127, 141).
- **Test/legacy auth**: `HeaderAuthenticator` trusts `x-vc-tenant` / `x-vc-org` / `x-vc-project` headers — explicitly test-only (auth.ts). The default `serve.ts` uses this, so a deployed binary without `phase2g` authenticates by header (§40).
- **`/auth/*` bridge**: `server.ts:276` rewrites `/auth/<x>` → `/api/auth/<x>` and calls `BetterAuthAdapter.handleRequest`. **Conditional on `phase2gContext.betterAuth`, which `serve.ts` never provides.**
- **Cookie**: Better Auth default cookie (name NOT overridden in `better-auth-adapter.ts` — adapter only sets `advanced:{disableOriginCheck:false,disableCSRFCheck:false}`, secret≥32, baseURL required). **INFERRED**: cookie name = Better Auth framework default (`better-auth.session_token`-style); frontend must read `Set-Cookie` from the sign-in response, not hardcode a name. `httpOnly` + `sameSite=lax` per adapter defaults (better-auth-adapter.ts:13).
- **Actor model** (`vaulltcore-auth`): `Actor{actorClass, principalId, tenantId, orgId, role, projectScope, permissions, attribution}`; `attribution` carries only ids/fingerprints (phase2g-routes.ts:119-129).

---

## 5. API Contract Table (all endpoints)

Routes are registered per layer and tried in this dispatch order (server.ts): `/auth/*` → `/identity/*` → `/health` → `JOB_ROUTES` → `PHASE2B_ROUTES` → `AUTOMATION_ROUTES` → `PHASE2B` (again) → `PHASE2E_ROUTES` → `PHASE2F_ROUTES`.

| Method | Path | Layer | Auth | Perm (if any) | Body | Success | Errors |
|---|---|---|---|---|---|---|---|
| POST | `/jobs` | 1C | principal | — | spec/engine/model/input/policy/projectId + `Idempotency-Key` hdr | 201 `{id,reservationId,status}` / 200 replay | 400,409,413,422,403,500 |
| GET | `/jobs/:jobId` | 1C | principal | — | — | 200 `JobView` | 401,404 |
| GET | `/jobs/:jobId/events` | 1C | principal | — | `after`,`follow` | 200 JSON or SSE | 401,404 |
| POST | `/jobs/:jobId/cancel` | 1C | principal | — | — | 200 `{status}` | 401,404 |
| POST | `/jobs/:jobId/input` | 1C | principal | — | `{text}` | 200 `{status}` | 400,401,404 |
| GET | `/jobs/:jobId/usage` | 1C | principal | — | — | 200 `{jobId,usage}` | 401,404 |
| GET | `/health` | 1C | none | — | — | 200 `{ok:true}` | — |
| POST | `/automation/templates` | 2A | principal | — | name,description?,orgId?,projectId? | 201 `AutomationTemplate` | 400,403,409 |
| GET | `/automation/templates` | 2A | principal | — | `orgId?`,`projectId?` | 200 `{templates[]}` | 401 |
| POST | `/automation/templates/:id/versions` | 2A | principal | — | definition,inputContract | 201 `AutomationVersion` | 401,404,409 |
| GET | `/automation/templates/:id/versions` | 2A | principal | — | — | 200 `{versions[]}` | 401 |
| POST | `/automation/runs` | 2A | principal | — | templateId,versionId,input[],orgId?,projectId? + `Idempotency-Key` hdr | 201 `AutomationRun` | 400,401,403,404,409 |
| GET | `/automation/runs/:runId` | 2A | principal | — | — | 200 `AutomationRun` | 401,404 |
| GET | `/automation/runs/:runId/events` | 2A | principal | — | `after?` | 200 `{events[]}` | 401 |
| GET | `/automation/runs/:runId/artifacts` | 2A | principal | — | — | 200 `{artifacts[]}` | 401 |
| POST | `/automation/runs/:runId/advance` | 2A | principal | — | — | 200 `AutomationRun` | 401,404,409 |
| POST | `/automation/runs/:runId/cancel` | 2A | principal | — | — | 200 `AutomationRun` | 401,404 |
| POST | `/automation/approvals/:id/approve` | 2A | principal+min-role | — | metadata? | 200 `{approval,run}` | 401,404,409 |
| POST | `/automation/approvals/:id/reject` | 2A | principal+min-role | — | metadata? | 200 `{approval,run}` | 401,404,409 |
| POST | `/automation/approvals/:id/changes` | 2A | principal+min-role | — | metadata? | 200 `{approval,run}` | 401,404,409 |
| POST | `/automation/schedules` | 2B | principal | — | name,automationVersionId,kind,cron?,scheduledAt?,timezone?,missedRunPolicy?,maxCatchUp?,input? | 201 `scheduleView` | 401,422,409 |
| GET | `/automation/schedules` | 2B | principal | — | `orgId?`,`projectId?` | 200 `{schedules[]}` | 401 |
| GET | `/automation/schedules/:id` | 2B | principal | — | — | 200 `scheduleView` | 401,404 |
| POST | `/automation/schedules/:id/pause` | 2B | principal | — | — | 200 `scheduleView` | 401,404,409 |
| POST | `/automation/schedules/:id/resume` | 2B | principal | — | — | 200 `scheduleView` | 401,404,409 |
| POST | `/automation/schedules/:id/cancel` | 2B | principal | — | — | 200 `scheduleView` | 401,404,409 |
| GET | `/automation/schedules/:id/occurrences` | 2B | principal | — | — | 200 `{occurrences[]}` | 401,404 |
| GET | `/automation/runs/:runId/deliveries` | 2B | principal | — | — | 200 `{deliveries[]}` | 401,404 |
| GET | `/automation/runs/:runId/stream` | 2B | principal | — | `after?`,`follow?` | SSE | 401,404 |
| GET | `/automation/metrics` | 2B | principal | — | `orgId?`,`projectId?` | 200 metrics | 401 |
| GET | `/operations/retry-status` | 2B/2E | principal | — | `kind?`,`state?` | 200 `{items[]}` | 401 |
| GET | `/operations/health/p2b` | 2B | principal | — | — | 200 health | 401 |
| GET | `/integrations/capabilities` | 2D | principal | — | — | 200 `{capabilities[]}` | 401 |
| POST | `/connections` | 2D | principal | — | provider,redirectUri,method?,scopes?,codeVerifier? | 201 `{attemptId,state,authorizeUrl,codeChallenge}` | 401,422,409 |
| GET | `/connections` | 2D | principal | — | `family?` | 200 `{connections[]}` | 401 |
| GET | `/connections/:id` | 2D | principal | — | — | 200 `ConnectionView` | 401,404 |
| POST | `/connections/:id/reconnect` | 2D | principal | — | `{redirectUri}` | 200 `{attemptId,state,authorizeUrl}` | 401,404,422,409 |
| POST | `/connections/:id/refresh` | 2D | principal | — | — | 200 `ConnectionView` | 401,404,409 |
| POST | `/connections/:id/disconnect` | 2D | principal | — | — | 200 `ConnectionView` | 401,404,409 |
| GET | `/oauth/callback` | 2D | **PUBLIC** | — | `state`,`code` (query) | 200 `{connectionId,attemptId,replayed,externalId,displayName,state}` | 422,404,409 |
| POST | `/triggers` | 2D | principal | — | templateId,versionId,name,triggerClass,criteria?,scheduleId?,inputMapping?,state? | 201 `TriggerView` | 401,422,409,404 |
| GET | `/triggers` | 2D | principal | — | — | 200 `{triggers[]}` | 401 |
| GET | `/triggers/:id` | 2D | principal | — | — | 200 `TriggerView` | 401,404 |
| POST | `/triggers/:id/enable` | 2D | principal | — | — | 200 `TriggerView` | 401,404,409 |
| POST | `/triggers/:id/disable` | 2D | principal | — | — | 200 `TriggerView` | 401,404,409 |
| POST | `/triggers/:id/invoke` | 2D | principal | — | — | 201 `{dispatches,runIds[]}` | 401,404,422,409 |
| GET | `/triggers/dispatches/:id` | 2D | principal | — | — | 200 dispatch | 401,404 |
| POST | `/integrations/dispatch` | 2D | principal | — | eventId,provider,kind?,resource?,action?,payload? | 201 `{dispatches,runIds[]}` | 401,422,409,404 |
| GET | `/operations/dead-letter` | 2E | principal | — | — | 200 `{items[],deadLetter[],dispatchDeadLetter[]}` | 401 |
| POST | `/operations/dead-letter/:id/redrive` | 2E | principal+admin | — | — | 200 redrive | 403,501 |
| POST | `/operations/dispatches/:id/redrive` | 2E | principal+admin | — | — | 200 redrive | 403,501 |
| POST | `/operations/reconcile` | 2E | principal+admin | — | `all?` | 200 `ReconciliationResult` | 403 |
| POST | `/operations/timeout-scan` | 2E | principal+admin | — | — | 200 `TimeoutScanResult` | 403 |
| POST | `/runs/:id/cancel` | 2E | principal | — | — | 200 `{runId,status}` | 401 |
| GET | `/readiness` | 2E | auth only | — | — | 200 `ReadinessReport` | (401 if unauth) |
| GET | `/operations/health/reliability` | 2E | principal | — | — | 200 `TenantHealthReport` | 401 |
| GET | `/usage` | 2F | principal | — | `from?,to?,kind?,provider?,model?,runId?,cursor?,limit?` | 200 `{items[],nextCursor,hasMore}` | 401,422 |
| GET | `/usage/summary` | 2F | principal | — | filters (1yr max) | 200 `UsageSummary` | 401,422 |
| GET | `/usage/runs/:id` | 2F | principal | — | — | 200 `UsageAggregate` | 401 |
| GET | `/usage/ledger` | 2F | principal | — | (alias of `/usage`) | 200 `{items[],nextCursor,hasMore}` | 401,422 |
| POST | `/usage/reconcile` | 2F | principal+admin | — | — | 200 reconcile | 403,501 |
| GET | `/identity/me` | 2G | actor | — | — | 200 actor | 401 |
| GET | `/identity/permissions` | 2G | actor | — | — | 200 `{permissions[]}` | 401 |
| GET | `/identity/orgs` | 2G | actor | — | — | 200 `{organizations[]}` | 401 |
| GET | `/identity/orgs/:orgId/members` | 2G | actor | `member.read` | — | 200 `{members[]}` | 404,403 |
| POST | `/identity/orgs/:orgId/members` | 2G | actor | `member.manage` | userId,role,projects? | 201/200 member | 404,403,422 |
| PATCH | `/identity/orgs/:orgId/members/:principalId` | 2G | actor | `member.manage` | `{role}` | 200 `{principalId,role}` | 404,403,422 |
| DELETE | `/identity/orgs/:orgId/members/:principalId` | 2G | actor | `member.manage` | — | 200 `{removed:true}` | 404,403 |
| POST | `/identity/service-identities` | 2G | actor | — | name,permissions[],projects? | 201 id | 422 |
| GET | `/identity/service-identities` | 2G | actor | — | — | 200 `{serviceIdentities[]}` | 401 |
| POST | `/identity/service-identities/:id/disable\|enable\|revoke` | 2G | actor | — | — | 200 id | 401 |
| POST | `/identity/service-identities/:id/credentials` | 2G | actor | — | expiresInMs? | 201 `{credentialId,serviceIdentityId,prefix,fingerprint,secret,expiresAt}` | 401 |
| GET | `/identity/service-identities/:id/credentials` | 2G | actor | — | — | 200 `{credentials[]}` | 401 |
| POST | `/identity/credentials/:credentialId/revoke` | 2G | actor | — | — | 200 cred | 401 |
| GET | `/identity/sessions` | 2G | actor (human) | — | — | 200 `{sessions[]}` | 403 |
| POST | `/identity/sessions/revoke` | 2G | actor (human) | — | — | 200 `{revoked}` | 403 |
| POST | `/identity/users/:userId/disable` | 2G | actor | `member.manage` | — | 200 `{userId,status,revokedSessions}` | 404,403 |
| POST | `/identity/users/:userId/revoke-sessions` | 2G | actor | `session.manage` | — | 200 `{revoked}` | 404,403 |

**`/auth/*` (Better Auth)**: paths mounted at `/api/auth/*` behind the `/auth/` rewrite — e.g. `/auth/sign-up`, `/auth/sign-in`, `/auth/sign-out`, `/auth/session`, `/auth/callback/*`. **UNKNOWN exact subpaths** (Better Auth generates them); **NOT mounted in `serve.ts`** (§40).

---

## 6. Request/Response Schemas (detailed)

**`JobView`** (`GET /jobs/:jobId`): `{id,tenantId,orgId:string|null,projectId:string|null,status,createdAt:number,updatedAt:number,usage:{inputTokens,outputTokens,reasoningTokens,totalTokens,steps,toolCalls},pendingInput:string[]}`.

**`JobEvent`** (`GET /jobs/:id/events`, no-follow): `{jobId,seq:number,timestamp:number,type:JobEventType,data:unknown}`; `JobEventType` ∈ `queued,started,resumed,checkpoint,message,tool_request,tool_response,usage,warning,error,budget_exhausted,completed,cancelled`.

**`AutomationTemplate`**: `{templateId,name,description:string|null,status:TemplateStatus,createdAt:number,createdBy:string,archivedAt:number|null,tenantId,orgId,projectId}`.

**`AutomationVersion`** (immutable): `{versionId,templateId,version:number,status,definition:AutomationDefinition,inputContract:InputContract,checksum:string,createdAt:number,createdBy:string,tenantId,orgId,projectId}`. `AutomationDefinition={steps:AutomationStep[],artifacts:ArtifactSpec[],approval:ApprovalSpec,delivery:DeliverySpec}`. `InputContract={fields:InputField[]}`, `InputField={fieldId,type:InputFieldType,required,description:string|null,min?,max?,enum?}`.

**`AutomationRun`**: `{runId,templateId,versionId,version:number,status:RunStatus,inputRevisionId,runVersion:number (fence),createdBy,error:string|null,createdAt:number,updatedAt:number,suspendedAt:number|null,completedAt:number|null,tenantId,orgId,projectId}`.

**`AutomationArtifact`**: `{artifactId,runId,versionId,stepId:string|null,type:string,name:string,contentRef:string (opaque),checksum:string,size:number|null,createdAt:number,metadata:{}}`.

**`ApprovalRequest`**: `{approvalId,runId,versionId,gateId,status:ApprovalStatus,minApproverRole,contextArtifacts:string[],createdAt:number,expiresAt:number|null,decisionActor:{principalId,kind}|null,decisionTime:number|null,decisionMetadata:{}|null,approvalVersion:number (fence)}`.

**`scheduleView`**: `{scheduleId,tenantId,orgId,projectId,name,state:ScheduleState,version,lastAdmittedAt:number|null,createdAt,updatedAt,currentVersion:{kind:ScheduleKind,cron:string|null,scheduledAt:number|null,timezone,automationVersionId,missedRunPolicy,maxCatchUp,input,checksum}|null}`.

**`occurrenceView`**: `{occurrenceId,scheduleId,version:number,scheduledTime:number,admittedRunId:string|null,admittedAt:number|null}`.

**`sanitizedDelivery`**: `{deliveryId,runId,status,attempts:number,resultRef:string|null,updatedAt:number,lastError:string|null (redacted),destination:string (masked)}`.

**`ConnectionView`**: `{connectionId,tenantId,orgId,projectId,family:ProviderFamily,provider,account:{externalId,displayName:string|null},capabilities:ConnectionCapability[],state:ConnectionState,version:number,lastUsedAt:number|null,expiresAt:number|null,createdAt,updatedAt}`. `ConnectionState` ∈ `disconnected|authorization_pending|authorization_verified|active|degraded|expired|revoked`. **Never includes `secretRef`/`secretFingerprint`.**

**`TriggerView`**: `{triggerId,templateId,versionId,triggerClass:TriggerClass,name,criteria:TriggerMatchCriteria|null,scheduleId:string|null,inputMapping:{},state:TriggerState,revision:number,createdAt,createdBy,updatedAt}`. `TriggerClass` ∈ `webhook_event|schedule|manual|integration_event`.

**`UsageEventLite`** (`/usage`): `{eventId,kind,quantity:number,unit:string|null,provider:string|null,model:string|null,jobId,recordedAt:number}`.

**`UsageAggregate`**: `{jobId:string|null,inputTokens,outputTokens,reasoningTokens,totalTokens,steps,toolCalls,durationMs:number}` (all `number`).

**`ServiceIdentity` (sanitized)**: `{serviceIdentityId,name,status,permissions:string[],createdAt,disabledAt:number|null,revokedAt:number|null}`. **`MachineCredential` (sanitized)**: `{credentialId,serviceIdentityId,prefix,createdAt,revokedAt:number|null,expiresAt:number|null,lastUsedAt:number|null}`. **Issuance** returns the secret once: `{credentialId,serviceIdentityId,prefix,fingerprint,secret,expiresAt}`.

---

## 7. Error Model & Status Code Map

- **Envelope**: `{ error: { code: string, message: string } }` (single consistent shape).
- **Status map**: `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` (cross-tenant isolation — indistinguishable from absence) · `409 CONFLICT` (fenced/version conflict, idempotency conflict, template archived) · `422 INVALID_INPUT` · `413 PAYLOAD_TOO_LARGE` (jobs >64 KiB) · `425 IDEMPOTENCY_INFLIGHT` (admission in progress) · `429` (quota) · `500 INTERNAL` · `501 NOT_CONFIGURED` (admin op not wired).
- Error code strings are stable strings (e.g. `JOB_NOT_FOUND`, `POLICY_DENIED`, `QUOTA_*`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_INFLIGHT`, `TEMPLATE_ARCHIVED`, `VERSION_NOT_FOUND`, `RUN_NOT_FOUND`, `CALLBACK_REJECTED`, `TRIGGER_DISABLED`, `NOT_MANUAL`, `INVALID_CALLBACK`).
- **No stack traces, secrets, or raw credentials** leak in errors (redaction applied in delivery/ops layers).
- Admission pipeline error mapping (admission.ts): `FORBIDDEN_ORG`/`IDENTITY_MISMATCH` → 403, else 404 on identity; `POLICY_DENIED` → 403; `QUOTA_REJECTED` → 429; `IDEMPOTENCY_CONFLICT` → 409; `IDEMPOTENCY_INFLIGHT` → 425.

---

## 8. Identity, Roles & Authorization Model

- **Roles** (ROLE_RANK): `owner`(50),`admin`(40),`developer`(30),`operator`(20),`viewer`(10),`service_account`(5). `ADMIN_ROLES={owner,admin}`; `SERVICE_ACCOUNT_ROLES={operator,viewer,service_account}`.
- **Permission catalog** (central `authorize(actor, permission)`): includes `member.read`, `member.manage`, `session.manage`, and automation/connection/trigger permissions (exact full set in `vaulltcore-auth`). Permission check is per-request (no embedded-claims authz); role/disable/revocation changes take effect at next request.
- **Actor** resolved via `ActorResolver` from session cookie (Better Auth) or bearer secret (machine credential / API key). `AuthorizationError` → 403.
- **`admin` flag**: on `AuthnPrincipal` (header auth) and on `ResolvedPrincipal` (Better Auth). Admin can read cross-tenant job state and perform reconcile/timeout/redrive/usage-reconcile.
- **Service identities**: bounded permission subset; creators cannot grant permissions they lack (enforced in `ServiceIdentityService`).

---

## 9. Organization & Project Hierarchy

- **Read**: `GET /identity/orgs` lists the principal's memberships (`{tenantId,orgId,role}`). `GET /identity/orgs/:orgId/members` lists members (`{principalId,role,createdAt}`).
- **Member management**: add/upsert (`POST`), change role (`PATCH`), remove (`DELETE`) under `member.manage`.
- **Project scope**: a member's `projectScope` is an array of project IDs (or `["*"]`). `grantProject` binds a member to a project. Projects are referenced by ID in `AutomationRun`/`Job`/`Connection` scope.
- **GAP — no org creation endpoint**: there is **no** `POST /identity/orgs` or `POST /identity/orgs/:id/projects` route anywhere (phase2g-routes.ts:356-375). Org/project creation is not exposed via HTTP in this snapshot (§40). Frontend cannot create an org through the documented API.

---

## 10. Idempotency & Replay Semantics

- **`Idempotency-Key` header** is **required** on `POST /jobs` and `POST /automation/runs` (missing → 400 `BAD_REQUEST`).
- **Admission idempotency** (admission.ts): slot keyed `(tenantId, idempotencyKey)`, fenced by `UNIQUE(tenant_id, idempotency_key)`. A **replay** (same key + same SHA-256 fingerprint of `{tenant,org,project,engine,model,input}`) returns the **original** job/run without re-reserving quota or re-creating (admission.ts:254-275). Different fingerprint under same key → **409** `IDEMPOTENCY_CONFLICT`.
- **Inflight**: if another process holds the slot `pending`, caller gets **425** `IDEMPOTENCY_INFLIGHT` (back off + re-read).
- **Automation run idempotency**: `Idempotency-Key` → durable run identity; same key returns same `AutomationRun`.
- **Trigger/webhook dispatch**: idempotency key = `trig:<triggerId>:<dispatchId>`; duplicate webhook/callback returns original outcome (no duplicate work).
- **Quota reservation** is idempotent on `requestKey = idempotencyKey` (no double-charge on replay).

---

## 11. Pagination, Cursors & List Semantics

- **Unpaginated (full-array) lists**: `/automation/templates`, `/automation/templates/:id/versions`, `/automation/runs/:runId/artifacts`, `/automation/runs/:runId/events` (cursor `after` only), `/automation/schedules`, `/automation/schedules/:id/occurrences`, `/automation/runs/:runId/deliveries`, `/operations/retry-status`, `/operations/dead-letter`, `/connections`, `/triggers`, `/identity/orgs`, `/identity/orgs/:orgId/members`, `/identity/service-identities`, `/identity/service-identities/:id/credentials`, `/identity/sessions`. **Frontend must paginate client-side or via filter query params** — server returns everything in tenant scope.
- **Cursor pagination (server)**: `/usage` and `/usage/ledger` use `cursor` (base64url `{recordedAt,eventId}`) + `limit` (default 200, max `MAX_QUERY_LIMIT=500`), returning `{items,nextCursor,hasMore}`. `parseFilter` also accepts `from`,`to`,`kind`,`provider`,`model`,`runId`.
- **SSE cursor**: `after` = last seen `seq` (number); client replays from `after` then follows live.
- **No offset/page-number pagination** exists anywhere.

---

## 12. Audit Logging & Observability

- **Audit store** (`vaulltcore-audit`): append-only, `sanitizeMetadata` redacts secret keys + opaque secret values. Event types include identity/auth/automation/metering/billing/integration events. No update/delete path.
- **Audit is written internally** by admission pipeline, phase2g handlers, etc. **There is NO HTTP GET endpoint to read the audit log** in any control route file (§40). Frontend cannot surface audit history through the current API.
- **Observability endpoints** (tenant-scoped): `GET /operations/health/p2b`, `GET /operations/health/reliability`, `GET /operations/retry-status`, `GET /readiness`, `GET /automation/metrics`. These are derived from durable records, never mutable counters.

---

## 13. Job (Execution) Lifecycle

- **`JobStatus`**: `queued → leased → preparing → running ⇄ checkpointing → suspended → resuming → running → completed | failed | cancelled`.
- Created via `POST /jobs` (admission pipeline: authenticate→authorize→idempotency→policy→quota→createJob). `GET /jobs/:id` returns `JobView`; `GET /jobs/:id/events` streams `JobEvent`s; `POST /jobs/:id/cancel` cancels (durable, fenced); `POST /jobs/:id/input` supplies pending input; `GET /jobs/:id/usage` returns `JobMetrics`.
- `pendingInput` array in `JobView` indicates the job is blocked awaiting `input`.
- Budget exhaustion emits `budget_exhausted` event + cancels through a durable state preserving the checkpoint boundary (billing/quota never sacrifice checkpoint correctness).

---

## 14. Automation (Product) Lifecycle

- **`RunStatus`**: `created → validating_input → admitted → running → collecting → awaiting_approval → delivering → completed`; terminal `failed | cancelled | rejected`; `suspended` (non-terminal).
- **Distinct from Job**: `AutomationRun` is product-level; it drives one or more `Job`s via `JobMapping(runId,stepId)→jobId` (UNIQUE, no duplicate work). Cross-entity, never merged.
- Phases: `createRun` (validates input against `InputContract`, freezes `InputRevision`) → steps execute as Jobs → `collecting` gathers artifacts → `awaiting_approval` blocks delivery until `approve` → `delivering` → `completed`. `advance` manually progresses; `cancel` cancels (fenced by `runVersion`).
- `runVersion` is a **fencing token** — every state-changing write CAS-checks it; stale writes → 409.

---

## 15. Schedules & Cron

- `POST /automation/schedules`: `kind` `one_time` (requires `scheduledAt` epoch ms) or `recurring` (requires `cron`). `timezone` default `UTC`; `missedRunPolicy` `skip|catch_up` (default `skip`); `maxCatchUp` default 1.
- Deterministic next-run; occurrences are idempotent via `occurrenceId = occ:<scheduleId>:<scheduledTime>` + UNIQUE row (scheduler crash never duplicates a run).
- `pause/resume/cancel` are fenced by `publishVersion` CAS. `GET .../occurrences` lists `occurrenceView[]` (with `admittedRunId` once fired).

---

## 16. Triggers & Webhooks

- `TriggerClass` ∈ `webhook_event|schedule|manual|integration_event`. Declarative deterministic matching ONLY (provider+eventKinds+resourcePattern glob+action+connectionId+selectors) — **no arbitrary code**.
- `triggerRevision` is pinned into every dispatch so historical matches stay explainable; **the dispatch UNIQUE key is `(tenantId, sourceEventId, triggerId)`**, not revision (two distinct triggers at rev 1 each get their own dispatch).
- `enable/disable` are fenced by `revision` CAS (stale → 409). Disabled trigger → no run (rejected dispatch). `invoke` only for `manual` class (else 422 `NOT_MANUAL`; disabled → 409 `TRIGGER_DISABLED`).
- `GET /triggers/dispatches/:id` shows `state`, `rejectionKind`, `rejectionReason`, `attempts`, `lastError`.
- `POST /integrations/dispatch` = manual dispatch (test/recovery) creating `dispatches`+`runIds`.

---

## 17. Approvals & Gates

- `ApprovalRequest` carries `minApproverRole`, `approvalVersion` (fence), `expiresAt`. `approve`/`reject`/`changes` call `decideApproval` with fixed decision; fenced CAS on `approvalVersion` → concurrent approvers yield exactly one terminal (no contradiction). `awaiting_approval` blocks `delivering` until approved.
- Frontend shows the approval gate UI when run `status === awaiting_approval` and the principal's role rank ≥ `minApproverRole`.

---

## 18. Deliveries

- `GET /automation/runs/:runId/deliveries` returns `sanitizedDelivery[]` (destination **masked**, `lastError` **redacted**, `idempotencyKey` dropped).
- Delivery is at-least-once with idempotent settlement (`UNIQUE(runId, idempotency_key)`); `in_progress` recorded before provider call; crash never falsely marks delivered. `failed_retriable` not claimable until `nextRetryAt`.

---

## 19. Artifacts

- `GET /automation/runs/:runId/artifacts` → `AutomationArtifact[]` with `contentRef` (opaque store pointer), `checksum` (SHA-256), `size`. **No download endpoint is exposed in the control plane** — `contentRef` is opaque; retrieval depends on the artifact store (in-memory or S3 signed URL) and is NOT via these HTTP routes (§40). Frontend displays metadata; actual content fetch path is undefined in the API surface.

---

## 20. Connections & Credentials (OAuth/BYOK)

- `POST /connections` begins an OAuth flow: returns `{attemptId,state,authorizeUrl,codeChallenge}`; frontend redirects the user to `authorizeUrl` (PKCE where supported). `state` is the trust root (one-time, consumed on callback).
- `GET /oauth/callback` is **PUBLIC**: resolves tenant/org/project/principal **from the durable authorization-attempt state record** via `getByStateGlobal(state)` — never from query. Duplicate callback → 200 `replayed:true`. Expired/wrong-binding/consumed → 409 `CALLBACK_REJECTED` (idempotent).
- `reconnect` (new attempt), `refresh` (rotates secret, identity stable; failure → `degraded`), `disconnect` (→ `disconnected`/`revoked`). `revoke()` is terminal.
- **`InMemorySecretProvider` is used in `serve.ts`** (serve.ts:72) — **NOT durable**; secrets are lost on restart. Production-secret storage is a gap (§40).
- `ConnectionState` transitions: `disconnected → authorization_pending → authorization_verified → active → degraded → expired → revoked → disconnected`.

---

## 21. Models & BYOK

- `ModelRegistry` resolves `{CredentialResolver} → ModelProviderAdapter` over SSRF-guarded HTTP (no provider SDK in core). `ModelConnectionService` (phase2d) does register/verifyConnectivity/activate/deactivate/revoke; `verifyConnectivity` is a bounded one-token probe (not auto-discovery). Tenant `ModelRestrictions` (allowedProviders/allowedModels/maxInput/maxOutput) enforced at resolve.
- **No `/models` HTTP route in control plane** — model/BYOK management is exposed only via the connections/credential seams. Frontend model selection must come from `GET /integrations/capabilities` + connection state.

---

## 22. Usage, Metering & Billing

- `GET /usage` (+ `/usage/ledger` alias) lists `UsageEventLite[]` (cursor). `GET /usage/summary` returns `UsageSummary{filter,aggregate,breakdown,totalEvents}` (derived, never authoritative; bounded to 1yr else 422 `RANGE_TOO_LARGE`). `GET /usage/runs/:id` returns `UsageAggregate` (empty aggregate, not 404, for cross-tenant/missing — no leak).
- Quantities are **integers** (`inputTokens` etc.); currency is **micro-units** (int), never floats. `UsageKind` ∈ 13 literals (model_tokens, model_input_tokens, model_output_tokens, model_reasoning_tokens, model_request, provider_api_request, tool_call, tool_invocation, shell_execution, execution_duration, runtime_duration, environment_allocation, snapshot_storage).
- **Billing** is immutable ledger; corrections are append-only adjustments referencing `original_entry_id`. Pricing versions are immutable (future price never rewrites history).

---

## 23. Quota & Capacity

- Admission reserves quota (`QUOTA_REJECTED` → 429). `quota_global_capacity` (phase1F/2E) enforces a global concurrent ceiling (`QUOTA_GLOBAL_FULL` honest reject; per-scope reservation rolled back). Capacity released on terminal completion; leaked capacity recovered after crashes; one tenant cannot consume another's reserved capacity.
- Settlement against **actual** metered usage is idempotent + fenced (no double-settle, no negative balance). Expired orphan reservations reaped idempotently.

---

## 24. Reconciliation & Reliability

- `POST /operations/reconcile` (admin): durable watermark as sole progress source; detects gaps; repairs only safe missing downstream projections (rebuilds UsageEvents from JobEvents, retries pricing/ledger idempotently, releases orphaned reservations). **Never re-executes agent steps/tool calls.** Returns `ReconciliationResult{scanned,expiredLeases,dueRetries,strandedDispatches,abandonedRuns,leakedCapacity,nextCursor}`.
- `POST /operations/timeout-scan` (admin): durable cooperative cancel/timeout fenced by `runVersion`. Returns `{scanned,timedOut}`.
- `ReliabilityReconciliationService` is bounded + watermarked + concurrent-safe + idempotent.

---

## 25. Dead-Letter & Redrive

- `GET /operations/dead-letter` lists `items[]` (ops work), `deadLetter[]` (terminal dead-letter), `dispatchDeadLetter[]` (trigger dispatches).
- `POST /operations/dead-letter/:id/redrive` and `POST /operations/dispatches/:id/redrive` (**admin only**, else 403; 501 if store unwired). Redrive is authorized + tenant-isolated + idempotent; never resurrects terminal; never creates duplicate durable identities; audited. Permanent policy/auth/quota rejection is never auto-retried.

---

## 26. SSE / Streaming Event Model

Two independent SSE streams:

**Job stream** — `GET /jobs/:jobId/events?follow=true&after=<seq>`:
```
event: job-event
data: {"jobId":"...","seq":<n>,"timestamp":<ms>,"type":"<JobEventType>","data":<unknown>}

event: done
data: {"done":true}
```
No explicit `id:` field (seq lives in `data`). Headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Client disconnect → `abort()`; job continues. No heartbeat frames.

**Run stream** — `GET /automation/runs/:runId/stream?follow=true&after=<seq>`:
```
event: automation-event
data: <run event JSON with seq>

event: done
data: {"done":true,"status":"<terminal status>"}   # when status terminal
```
Polls every 50ms; advances cursor = max(cursor, e.seq) (no-gap replay + duplicate suppression). `follow` defaults **true**.

**Frontend guidance**: use `EventSource` for `follow=true`; parse `data` as JSON; on `event: done` close. For reconnect, reopen with `after=` = last received `seq`. Both streams require auth (principal/actor).

---

## 27. Webhook Ingestion

- A durable `WebhookGateway` exists in `vaulltcore-webhooks` (verify→resolve→tenant-auth→dedupe→persist→enqueue→audit). **It is NOT mounted in `serve.ts`** (no webhook HTTP route in the control plane surface; only `GET /oauth/callback` and the trigger dispatch paths). Webhook ingestion is therefore **not exposed via the control HTTP server in this snapshot** (§40). Duplicate webhook → `UNIQUE(tenant_id,event_id)` linearization (no duplicate automation work).

---

## 28. Time, Timestamps & IDs

- **All timestamps are epoch-ms `number`** (createdAt/updatedAt/expiresAt/scheduledTime/recordedAt/etc.). Frontend must format with `new Date(ms)`, never assume ISO strings.
- **IDs are opaque prefixed monotonic strings** generated by `ascending()` (vaulltcore-runner/src/ids.ts:14): `time(12 hex) + random`. Prefixes: `job_`, `tmpl_`, `ver_`, `run_`, `inp_`, `art_`, `apr_`, `dlv_`, `map_`, `trg_`, `dsp_`. Frontend must treat them as **opaque tokens** (URL params / state keys), never parse or reconstruct.

---

## 29. Data Types & Serialization

- JSON over HTTP; `Content-Type: application/json` request/response. Body parsed via `readBody` (JSON only; malformed → 400). Jobs body capped at 64 KiB (413).
- Enums are **string literals** (`status`, `state`, `kind`, `triggerClass`, `connectionState`, `usageKind`). Frontend should model them as string unions.
- `metadata`/`data`/`payload` fields are `Record<string,unknown>` / `unknown` — opaque to the backend, pass-through.
- Numbers are JSON numbers; large IDs are strings. No binary in JSON bodies.

---

## 30. Secrets Handling

- **Never returned**: API keys, OAuth secrets, credential secrets, `secretRef`, `secretFingerprint` (except issuance).
- **Issuance returns secret once**: `POST /identity/service-identities/:id/credentials` → `{credentialId,serviceIdentityId,prefix,fingerprint,secret,expiresAt}`. Frontend must capture `secret` at creation and store it securely (it will never be returned again).
- Bearer auth: machine credential / API key presented in `Authorization` header; backend resolves to actor but never echoes the secret.
- Redaction applied to `lastError` (delivery/ops) and audit metadata. `redactSecrets`/`redactUrl` strip bearer/userinfo/token=.

---

## 31. Multi-Tenancy & Isolation

- Tenant identity derived **only** from the authenticated principal (never request body). Every store query is tenant-scoped.
- Cross-tenant access → **404** (uniform with absence) on jobs, runs, schedules, connections, triggers, dispatches, service-identities, sessions, members, usage.
- No cross-tenant economic/audit read. `admin` flag permits cross-tenant *read* of job state + operational endpoints, but never writes across tenants.
- Better Auth session isolation + `ActorResolver` per-request lookup enforces boundaries.

---

## 32. Rate Limiting & Concurrency

- **No HTTP-level rate limiting** is implemented in the control plane (only 64 KiB body cap). Throttling is economic: quota reservation (429) + global capacity ceiling (`QUOTA_GLOBAL_FULL`).
- **Concurrency control is via fenced CAS** on `runVersion`/`approvalVersion`/`publishVersion`/`revision`/reservation `version`/ops `generation` — stale writers get 409 and must re-read.
- SSE polls at 50ms server-side; client should not open unbounded streams without `after`/close handling.

---

## 33. Sequence Diagrams

### 33.1 Job creation + SSE (admission pipeline)
```
Client → POST /jobs (Idempotency-Key, spec) 
  → ControlPlane.authenticate (principal)
  → AdmissionPipeline.admit:
       authorize(org/project) → 404 if cross-tenant
       idempotency.claim → 409 conflict / 425 inflight / replay
       policy.evaluate → 403 if denied
       quota.reserve → 429 if full
       runner.createJob (durable) → on fail: quota.release + slot retriable
       quota.attachJob + idempotency.complete
  → 201 {id,reservationId,status}
Client → GET /jobs/:id/events?follow=true&after=0
  → SSE: job-event* → done
```

### 33.2 OAuth connection bootstrap
```
Client → POST /connections {provider,redirectUri}
  → 201 {attemptId,state,authorizeUrl,codeChallenge}
Client → browser redirect to authorizeUrl (user authenticates at provider)
Provider → GET /oauth/callback?state&code   (PUBLIC)
  → attemptStore.getByStateGlobal(state) resolves tenant/principal
  → lifecycle.completeCallback → 200 {connectionId,replayed,...}
Client → GET /connections/:id → ConnectionView(state=active)
```

### 33.3 Trigger → run (webhook/class)
```
external event → WebhookGateway (NOT mounted here) → persist+dedupe
  → TriggerDispatchService.reserveDispatch UNIQUE(tenant,sourceEventId,triggerId)
  → driveDispatch → AutomationService.createRun (idempotencyKey = trig:<t>:<d>)
  → run state machine; SSE /automation/runs/:runId/stream
```

### 33.4 Approval gate
```
run → awaiting_approval (delivery blocked)
Client → GET /automation/runs/:runId → status=awaiting_approval, approvals[]
Client → POST /automation/approvals/:id/approve {metadata?}
  → decideApproval fenced by approvalVersion → 409 on stale
  → run → delivering → completed
```

---

## 34. Frontend Integration Contract (auth/session)

- **Current server (`serve.ts`) authenticates via `HeaderAuthenticator`** (x-vc-tenant/x-vc-org/x-vc-project) and does **not** mount `/auth/*` or `/identity/*`. Until `phase2g` is wired, the **only working auth is header-based** (test mode). **This is a blocking gap** (§40).
- **Intended flow**: Better Auth session cookie. Frontend calls `/auth/sign-up`, `/auth/sign-in` (Better Auth-generated paths under `/auth/*`), receives an `httpOnly` session cookie, then sends it automatically on subsequent requests. `GET /identity/me` returns the actor; `GET /identity/permissions` returns the permission set for UI gating.
- **Do NOT hardcode the cookie name** — read `Set-Cookie` from sign-in. Cookie is `httpOnly`+`sameSite=lax` (CSRF protected; do not disable).
- **Org/project context**: chosen by the user from `GET /identity/orgs`; selected `orgId`/`projectId` must be sent per request (header auth today; in Better Auth flow, the actor's `orgId`/`projectScope` come from the session — confirm whether project selection is header/query or session-bound once `/identity/*` is live).
- **Machine-to-machine**: issue a service-identity credential once (`POST .../credentials`) and send as `Authorization: Bearer <secret>`; store the secret securely (never returned again).

---

## 35. Frontend Routing & Entity Models

Map UI routes to API entities:
- **Orgs/Members**: `/identity/orgs`, `/identity/orgs/:orgId/members` (CRUD members). No org-creation route → UI "create org" is unsupported by API (§40).
- **Templates/Versions**: list `GET /automation/templates`; publish `POST /automation/templates/:id/versions` (needs `AutomationDefinition` + `InputContract` — a **builder UI** is required; these are complex nested objects).
- **Runs**: `GET /automation/runs/:runId`; live via `GET /automation/runs/:runId/stream` (SSE); artifacts, deliveries, events sub-views.
- **Approvals**: gate UI driven by `run.status === awaiting_approval` + `ApprovalRequest`.
- **Schedules**: CRUD + occurrences.
- **Triggers/Connections**: connection OAuth bootstrap; trigger CRUD; `GET /integrations/capabilities` for provider options.
- **Usage**: `/usage`, `/usage/summary`, `/usage/runs/:id`, `/usage/ledger` (charts from `UsageAggregate`).
- **Ops/Reliability**: `/operations/retry-status`, `/operations/health/*`, `/operations/dead-letter` (admin), redrive (admin).

Entity model suggestion: typed interfaces generated from the shapes in §6 (string-union enums, epoch-ms numbers, opaque ID strings). Shared packages (`@vaulltcore/automation`, `@vaulltcore/identity`, `@vaulltcore/auth` types) can be imported directly to avoid drift (§39).

---

## 36. Frontend State Management Implications

- **Optimistic UI must handle 409 fencing**: on edit conflicts, re-fetch the entity (which carries the new `runVersion`/`revision`) and re-apply.
- **Event streams**: maintain a `seq` cursor per job/run; reconnect with `after=`. Treat `done` as terminal; do not poll after `done`.
- **Idempotency**: the frontend should generate and send a stable `Idempotency-Key` per user action (e.g., a client-generated UUID) so retries are safe on `POST /jobs` and `POST /automation/runs`.
- **Permissions**: gate UI controls by `GET /identity/permissions` (or the actor's `permissions` from `/identity/me`) rather than role strings alone.
- **Lists are full-array**: for large orgs, implement client-side virtualization/filtering; server-side pagination exists only for `/usage*`.

---

## 37. Frontend Error Handling

- Parse the uniform `{error:{code,message}}` envelope. Map:
  - `401` → redirect to sign-in / refresh session.
  - `403` → show "insufficient permissions" (do not retry).
  - `404` → treat as "not found or not permitted" (no leak); for entity views show generic not-found.
  - `409` → conflict/version mismatch; refetch + reconcile (do not blindly resend).
  - `422` → surface field validation from `message`.
  - `425` → backoff + re-read (idempotency inflight).
  - `429` → honor quota; show retry-after-style messaging.
  - `501` → feature not wired in this deployment.
  - `5xx` → generic failure; do not expose raw message.
- Do **not** rely on HTTP body for secrets; the backend already redacts.

---

## 38. Frontend Real-time (SSE) Integration

- Use native `EventSource` for `follow=true` streams (job + run). `EventSource` only supports GET — both streams are GET, so this works.
- Parse `event` field to branch (`job-event`/`automation-event` vs `done`). Parse `data` as JSON.
- Keep last `seq`; on `EventSource` `onerror`/close, reopen with `?after=<seq>` for gap-free resume.
- Show connection state; tolerate no-heartbeat (backend sends none) — rely on `done` or reconnect logic.
- Auth: `EventSource` sends cookies automatically (same-origin). For header auth, `EventSource` cannot set headers — a deploy using `HeaderAuthenticator` would need a cookie or fetch-based stream; flag this (§40).

---

## 39. OpenAPI / Schema Generation Feasibility

- **No OpenAPI/JSON-schema is generated** by the backend. Contracts live in handler code + TypeScript types.
- **Feasible**: import the published TypeScript types directly from `@vaulltcore/automation`, `@vaulltcore/identity`, `@vaulltcore/auth`, `@vaulltcore-runner`, `@vaulltcore-usage-governance`, etc., into the frontend (monorepo) — strongest drift protection.
- **Alternatively**: write a small codegen that walks the `*_ROUTES` tables (each route has `method`, `pattern`, `handler`) + extracts request/response types via `tsc` inference. The route tables are structured and machine-readable — a generator is realistic.
- **Recommendation**: shared types package + a thin client SDK generated from the route tables; document the SSE frame formats (§26) explicitly since they are not in any type.

---

## 40. Gaps, Risks & Discrepancies

1. **`/auth/*` and `/identity/*` NOT mounted in `serve.ts`** (phase2g layer omitted; only wired in `phase2g-routes.test.ts`). The shipped binary has **no sign-up/sign-in and no identity management HTTP surface**; it falls back to `HeaderAuthenticator`. **BLOCKER** for real auth. (CONFIRMED: serve.ts:110-140 omits `phase2g`; server.ts:276 requires `phase2gContext.betterAuth`.)
2. **No org- or project-creation endpoint** in any route file. (CONFIRMED: phase2g-routes.ts:356-375 has no POST /identity/orgs or projects.)
3. **No audit-log read endpoint.** Audit is append-only internal; frontend cannot display it. (CONFIRMED: no GET audit route in any control file.)
4. **No artifact download endpoint** — `contentRef` is opaque; retrieval path undefined in HTTP surface. (CONFIRMED: artifacts routes only list metadata.)
5. **Webhook ingestion not mounted** in control plane (`WebhookGateway` exists but no route). (CONFIRMED: no webhook route in server.ts dispatch.)
6. **`InMemorySecretProvider` in `serve.ts:72`** — OAuth/credential secrets are non-durable (lost on restart). Production gap. (CONFIRMED.)
7. **No model/BYOK management HTTP route** — model selection depends on connection state + capabilities only. (CONFIRMED: no `/models` route.)
8. **SSE + header auth incompatibility**: `EventSource` cannot send `x-vc-*` headers; a header-auth deployment breaks SSE auth. (INFERRED; resolved once Better Auth cookie auth is mounted.)
9. **Cookie name unknown/unstable** — not overridden in adapter; frontend must read `Set-Cookie`. (INFERRED.)
10. **`GET /automation/templates` etc. unpaginated** — large tenants risk large payloads. (CONFIRMED.)

---

## 41. Recommendations

1. **Wire `phase2g` into `serve.ts`** (construct `BetterAuthAdapter` + `ActorResolver` + `SqlB2bAuthStore` + `ServiceIdentityService` and pass `phase2g`) before any frontend auth work; otherwise build against header auth only as a stopgap.
2. **Add org/project creation endpoints** (or document the Better-Auth-signup-created-org contract) — frontend cannot onboard orgs otherwise.
3. **Expose a read-only audit endpoint** (tenant-scoped) if the UI needs audit visibility.
4. **Define and document an artifact download route** (signed URL or gateway) so the UI can fetch `contentRef`.
5. **Mount the webhook gateway** if external triggers are in scope; otherwise document triggers as manual/`/integrations/dispatch`-only.
6. **Replace `InMemorySecretProvider`** with a durable secret store in production wiring.
7. **Generate a typed client SDK** from the `*_ROUTES` tables + shared types (§39).
8. **Frontend**: send `Idempotency-Key` on all mutating POSTs; model timestamps as numbers; treat IDs as opaque; handle 409 by refetch; use `EventSource` with `after=` resume.
9. **Document the SSE frame formats** (§26) in the frontend contract since they are not type-defined.

---

## 42. Evidence Index

| Finding | File:Line |
|---|---|
| `/auth/*` bridge conditional on `phase2g.betterAuth` | server.ts:276 |
| `/identity/*` resolved via `ActorResolver` | server.ts:293-311 |
| Default `HeaderAuthenticator` (test auth) | server.ts:141 |
| `phase2g` omitted from `serve.ts` | serve.ts:110-140 (no `phase2g` key) |
| `InMemorySecretProvider` in prod wiring | serve.ts:72 |
| Admission idempotency claim/replay/conflict/inflight | admission.ts:253-285, 279(409), 284(425) |
| Policy denied → 403; quota → 429 | admission.ts:294, 311 |
| Job SSE frame format | server.ts (job-event/done; subagent extraction) |
| Run SSE frame format + 50ms poll + `after` cursor | phase2b-routes.ts (subagent extraction) |
| Phase 2G route table | phase2g-routes.ts:356-375 |
| Sanitized identity/credential/session projections | phase2g-routes.ts:317-350 |
| Better Auth adapter config (secret≥32, baseURL, CSRF/origin on) | better-auth-adapter.ts:60-75 |
| ID generator (prefixed monotonic) | vaulltcore-runner/src/ids.ts:14-34 |
| Roles / ROLE_RANK / ADMIN roles | vaulltcore-identity/src/contracts.ts |
| Usage cursor pagination + MAX_QUERY_LIMIT=500 | phase2f-routes.ts (subagent extraction) |
| Connection state machine + no secret in view | phase2d-routes.ts (subagent extraction) |
| Trigger dispatch UNIQUE (tenant,sourceEventId,triggerId) | phase2d-routes.ts (subagent extraction) |

---

## 43. Appendix: Full Endpoint Inventory

(See §5 for the complete table. Layer summary: 1C jobs = 7 endpoints; 2A automation = 13; 2B schedules/deliveries/metrics/SSE/ops = 11; 2D connections/oauth/triggers = 18; 2E reliability/ops = 9; 2F usage = 5; 2G identity = 20; plus `/health` and `/auth/*` (unmounted). Total mounted-in-tests ≈ 83 endpoints; mounted-in-`serve.ts` ≈ 63 (2G + 2D partially via callback only + all others), with auth/identity unmounted.)

**Confidence summary**: contract shapes & status codes = CONFIRMED (read from handlers). Cookie name, org-creation contract, artifact-download path, webhook mounting = INFERRED/UNKNOWN with explicit gaps called out in §40.
