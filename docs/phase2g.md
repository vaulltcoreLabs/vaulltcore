# Phase 2G — B2B Identity, Authentication, Authorization & Tenant Security Hardening

**Result:** 467 passed / 25 environment-gated skips (10 PG + 7 Docker + 1 pglite-server + 7 live-conformance) / 0 failures. Zero TypeScript errors (`tsc --build`). 30 new tests (22 in `vaulltcore-auth`, 8 integration tests in `vaulltcore-control`).

## 1. Baseline inspected

- **Authentication boundary**: `vaulltcore-control` resolved principals via the replaceable `Authenticator` seam (default `HeaderAuthenticator` reading `x-vc-tenant/org/project` headers) plus `SqlIdentityStore.authenticateApiKey`. This was the *authentication* seam — thin by design, no session concept, no CSRF notion.
- **Authorization**: domain checks went through `SqlIdentityStore.resolvePrincipal` + Phase 1E role-rank (`owner/admin/developer/operator/viewer`) and crude string `role` checks at routes.
- **Multi-tenancy**: `tenants/organizations/projects/memberships/grants` lived in `vaulltcore-identity` (authoritative already). Tenant derived from the authenticated principal, never from request body.
- **Webhooks/OAuth**: verified-signature ingress (`vaulltcore-webhooks`) and durable one-time OAuth state (`vaulltcore-credentials/oauth`) own their own trust boundaries.
- **Better Auth**: not present before Phase 2G. Introduced fresh (v1.7.1) this phase.

## 2. Better Auth integration architecture

Better Auth owns session *authentication* mechanics only. One narrow adapter exists: `packages/vaulltcore-auth/src/better-auth-adapter.ts` (`BetterAuthAdapter`).

- Owns sign-up/sign-in/session validation/sign-out/OAuth plumbing and the Better Auth schema via its own Kysely migrations (`getMigrations()` → `runMigrations()`). Runs on a *separate* `node:sqlite` `DatabaseSync` in tests; any Kysely-compatible database in production.
- Hardcoded security posture: explicit secret (≥32 chars), explicit baseURL, email/password enabled. The adapter **explicitly sets `advanced: { disableOriginCheck: false, disableCSRFCheck: false }`** because Better Auth defaults `skipOriginCheck` when `NODE_ENV=test`, which is exactly the kind of insecure default this phase forbids.
- Used in exactly two places: the control-plane public `/auth/*` bridge and the session-validation path of the `ActorResolver`. Core domain packages never import Better Auth.

## 3. Authentication vs authorization authority separation

- **Authentication**: *who* successfully authenticated (Better Auth session cookie, Vaulltcore API key, or machine credential).
- **Authorization**: *what* the actor may do, resolved against Vaulltcore's own membership/role/permission model (`vaulltcore-auth/src/permissions.ts`), enforced by the central `authorize(actor, permission)` contract.
- A valid Better Auth session **does not imply access**: with no organization membership, resolution throws `ORG_NOT_MEMBER` (404 at HTTP). No implicit access anywhere; session ≠ permission.

## 4. Identity and tenant model

- New durable concepts (Phase 2G migration `b2b_auth_core` in `vaulltcore-auth/src/auth-store.ts`):
  - `UserIdentity` (durable bridge from Better Auth user id to Vaulltcore principal; `active|disabled` lifecycle; provisioned idempotently at first resolution).
  - `ServiceIdentity` (org-scoped machine principal; `active|disabled|revoked`).
  - `MachineCredential` (metadata row: prefix + SHA-256 fingerprint; never plaintext).
  - Session registry (SHA-256 fingerprint → revocation ledger; bounded user info).
- Existing authoritative concepts unchanged: Tenant, Organization, Membership, Role, Principal, API key (`vaulltcore-identity`).
- **Actor classes**: `user` (authenticated human), `service` (machine/API key), `system` (internal calls where explicitly required — the `identify` concept is extensible; system reserved for explicit in-process use).

## 5. Session → actor resolution path

One boundary in `ActorResolver.resolve()` (`vaulltcore-auth/src/actor.ts`):

1. Prefer `Authorization: Bearer …` → machine credential (`<credentialId>.<body>` lookup → constant-time fingerprint verify → status checks) OR legacy API key (`vc_live_…`).
2. Else session cookie → Better Auth `getSession`.
3. Durable user identity provisioned idempotently if absent.
4. Session fingerprint registered in the revocation ledger (first sighting).
5. Membership loaded from `vaulltcore-identity`; optional requested-org hint validated against memberships.
6. `identity.resolvePrincipal` builds the sourced scope (`projectScope`, admin).
7. Actor carries `attribution` of *fingerprints only* (session fingerprint SHA-256, plus `userId`); **never** secrets/tokens/cookies.

`authorize(actor, permission)` is the single capability gate used by domain services and routes; no ad-hoc string role checks for Phase 2G routes.

## 6. Organization/membership model

- Users may belong to many organizations; per-request org context is explicit via `x-vc-org` hint or defaulted to first membership — always validated server-side. Client-supplied org IDs are never trusted.
- Removing a member, downgrading a role, or disabling a user takes effect **at the next request** (membership/role re-looked on every resolution). This is the documented invalidation semantics: per-request lookup, no embedded-claims authorization.
- Role model: maps existing Phase 1E set (`owner/admin/developer/operator/viewer`) to permissions; Phase 2G HTTP API aliases `member|viewer` to domain `developer|viewer`.

## 7. Permission model

Central permission catalog (`vaulltcore-auth/src/permissions.ts`): `org.manage`, `member.read/manage`, `connection.manage`, `credential.manage`, `service_identity.manage`, `trigger.manage`, `automation.dispatch/manage`, `run.read/manage/cancel`, `reliability.manage`, `usage.read`, `billing.read/manage`, `reconcile.admin`, `session.manage`. Enforced by throwing `AuthorizationError` (HTTP 403). Domain services (e.g. `ServiceIdentityService`) enforce at the domain boundary — never only HTTP middleware.

## 8. Service identity design

`ServiceIdentityService` (`vaulltcore-auth/src/service-identity.ts`):
- Create/disable/enable/revoke; `revoke` is terminal (re-enable → 409), disable is reversible.
- Permissions are an explicit bounded subset; creators must already hold every granted permission (no escalation).
- Machine credentials `<credentialId>.<body>`; only prefix + fingerprint persisted; secret returned exactly once at issuance; later retrieval of plaintext impossible.
- `authenticateMachineCredential` resolves to a service actor with the granted permissions only — never creator-elevated.

## 9. Credential storage and revocation semantics

- Legacy API keys handled via existing `SqlIdentityStore` (hashed `hashSecret`, constant-time compare, '.' separator) — no second system.
- Machine credentials and sessions use the same `hashSecret/verifySecret/parseSecret` helpers (SHA-256; constant-time).
- Revocation checks happen at validation time (registry consulted *before* trusting a session). Session registry rows store fingerprint + expiry; revoke-all-for-user is deterministic; fire-and-forget revocation paths (`void … .catch`) marked as best-effort.

## 10. Request security pipeline

Per protected route: **auth resolve → actor → tenant/org context → authorization → domain → audit → sanitized response.** Phase 2G routes dispatch in `phase2g-routes.ts`, matched before generic routes in `server.ts`. Errors map deterministically: 401 (unauthenticated/session/user-disabled/credential) / 403 (authorization) / 404 (not found or cross-tenant isolation) / 409 (deterministic conflict) / 422 (semantic validation). No stack traces, no secrets.

## 11. Public trust-boundary exceptions

- `/health` (existing).
- `/auth/*` → Better Auth bridge (registration, sign-in, sign-out, OAuth flows) when an adapter is wired.
- Existing webhook route family remains under its own signature-verified trust model; OAuth callback routes remain unauthenticated at the edge (tenant resolved from durable state), unchanged from Phase 2D.

## 12. Migrations

- Migration name unique-by-name discipline preserved. New migration: `b2b_auth_core` with tables `user_identity`, `service_identities` (unique per org+name), `machine_credentials`, `session_registry`.
- Better Auth tables created by Better Auth's own Kysely migrations (managed by `BetterAuthAdapter.migrate()`).
- `vaulltcore-identity` schema extended additively with `getMember` (read-only accessor); no schema change to the identity package.

## 13. API routes

Public `/auth/*` (bridge). Protected `/identity/*`:

| Method | Path | Permission |
|---|---|---|
| GET | `/identity/me` | any authenticated actor |
| GET | `/identity/permissions` | self |
| GET | `/identity/orgs/:org/members` | `member.read` |
| POST | `/identity/orgs/:org/members` | `member.manage` |
| PATCH | `/identity/orgs/:org/members/:userId` | `member.manage` |
| DELETE | same | `member.manage` |
| POST | `/identity/service-identities` | `service_identity.manage` |
| GET | `/identity/service-identities` | `service_identity.manage` |
| POST | `/identity/service-identities/:id/{disable,enable,revoke}` | `service_identity.manage` |
| POST | `/identity/service-identities/:id/credentials` | `service_identity.manage` |
| GET | `/identity/service-identities/:id/credentials` | `service_identity.manage` |
| POST | `/identity/service-identities/:id/credentials/:credId/revoke` | `service_identity.manage` |
| GET | `/identity/sessions` | self-service |
| POST | `/identity/sessions/revoke` | self-service |
| POST | `/identity/users/:userId/disable` | `member.manage` |
| POST | `/identity/users/:userId/sessions/revoke-all` | `session.manage` |

## 14. Audit events (additive)

Appended to `AUDIT_EVENT_TYPES` (TEXT persisted), exactly the types emitted: `authentication_failed`, `session_revoked`, `user_identity_disabled`, `member_added/removed/role_changed`, `service_identity_created/disabled/revoked`, `machine_credential_issued/revoked`. Metadata carries ids/fingerprints/statuses only — never secrets (test asserts absence). `SqlAuditStore.append` continues to sanitize metadata before write.

## 15. Tests added

- `vaulltcore-auth/test/b2b-security.test.ts` (22)
- `vaulltcore-control/test/phase2g-routes.test.ts` (8 integration, over a real HTTP server + real Better Auth)

Coverage spans the full matrix: unauthenticated→401; valid session resolves; invalid/revoked session rejected; multi-org boundaries + org hint validation (404); membership add/remove/change/removal; viewer/admin/owner boundaries at domain boundary; service identity issue/auth/scoping/disabled/revoked/expired; no plaintext persistence; duplicate handling (409); privilege escalation prevention; stale privilege tests; public `/auth/*` bridge; CSRF origin rejection (hostile origin → 403); session registry idempotency; deterministic full-suite.

## 16. Verification

- `npm run typecheck` — 0 errors over `tsc --build packages/*`.
- `npm test` — 467 passed / 25 skipped / 0 failures (vitest).
- PGlite Tier A and Tier B/C environment-gated suites are unchanged (25 skips shown above; honest skips when PG/Docker/live token envs are absent).

## 17. Skipped tests

- PG server conformance (10), Docker provider (7), PGlite server (1), live provider conformance (7): all environment-gated, reported as skips.

## 18. Known limitations

- Email/password + sessions/OAuth only; no enterprise IdP (SAML/SCIM) yet.
- Rate-limiting/risk controls delegated to deployment.
- CSRF: rely on Better Auth trusted-origin enforcement for the `/auth/*` bridge; the Vaulltcore `/identity/*` pipeline is bearer/cookie-independent of origin but cookie-less machine flows are primary.
- Role remove/downgrade/disable takes effect on next request, not push-invalidation; matches Phase 1E consistency model honestly.
- Better Auth stores its tables through Kysely against your chosen database; `node:sqlite` is the test driver; production should use a production SQL driver.
- API tokens bear no per-endpoint `Scope` model beyond route permission mapping; explicit `service_identity` bounds are available but the legacy API key path resolves permissions from role as before (backward compatible).

## 19. Phase 1–2F invariants preserved

Confirmed by the full suite (467/0 failures): runner untouched (no imports of auth/business), no second agent runtime, no provider SDK in provider-neutral cores, SecretProvider/CredentialResolver boundaries intact, no plaintext secrets, strict cross-tenant isolation, webhook ingress unchanged, admission never bypassed, at-least-once execution, exactly-once claims only at durable identity boundaries, accounting unchanged, reconciliation non-executing, terminal work not resurrected. Additive-only modifications: identity `getMember` read accessor, audit type union append, control-plane `phase2g` layer, `package.json` dependency, plus new package + routes + tests + docs.
