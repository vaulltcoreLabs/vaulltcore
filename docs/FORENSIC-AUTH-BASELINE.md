# Forensic Auth Baseline — Enterprise Identity & Access Hardening

**Date:** 2026-09-05
**Scope:** Phase 0 of the enterprise auth hardening task. Read-only audit of the
currently installed Better Auth version, the existing Vaulltcore auth architecture, and
what the product actually wires today. The repository is the source of truth; nothing
below is assumed from older docs.

---

## 1. Exact dependency versions (verified from node_modules + lockfile)

| Package | Installed | Lockfile |
|---|---|---|---|
| `better-auth` | 1.7.1 | ^1.7.1 |
| `@better-auth/core` | 1.7.1 | 1.7.1 |
| `@better-auth/kysely-adapter` | 1.7.1 | 1..7.1 |
| `@better-auth/utils` | 0.4.2 | 0.4.2 |
| `better-call` | 1.4.0 | 1..4.0 |
| `zod` (peer) | — | present |
| `pg` | 8.23.x | — |
| `typescript` | 5.7.x | — |
| `vitest` | 2.1.x | — |
| `resend` | **not installed** | — |

npm registry `latest` for better-auth is 1.7.2 (same plugin surface,
verified by tarball probe: same plugin set, no `sso`/`passkey` subpath export).

**Version decision (documented per task rule 2):**
- STAY on `better-auth@1.7.1`. The installed minor is the current registry minor
  (1.7.x) and 1.7.2 changes nothing in the auth plugin surface we consume.

- Plugin surface actually shipped by 1.7.1/1.7.2 (verified from
  `node_modules/better-auth/package.json` `exports` + `dist/plugins/`):
  - `two-factor` (TOTP + backup codes + email OTP second factor)
  - `magic-link`
  - `email-otp` (sign-in, email verification, password reset via OTP)
  - `generic-oauth` (OIDC-capable: discovery, PKCE, id_token nonce, JWKS)
  - `organization` (org/member/invitation/role in Better Auth's OWN store)
  - `admin`, `access` (role/access-control), `bearer`, `jwt`, `one-time-token`,
    `multi-session`, `oauth-proxy`, `siwe`, `phone-number`, `custom-session`,
    `anonymous`, `captcha`, `device-authorization`, `email-verification` (core),
    `username`, `open-api`, `additional-fields`, `last-login-method`, `oauth-popup`,
    `one-tap`, `haveibeenpwned`, `test-utils`
- **NOT shipped** by the installed version (explicitly verified; do NOT fake):
  - `sso` plugin (org SSO / OIDC / SAML / domain verification — no `sso` export)
  - `passkey` / `webauthn` plugin (no `passkey` subpath export)
  - SAML support (the `validateUserInfo` type references `sso-oidc`/`sso-saml`
    methods, but the plugin that implements them is absent)
- `email-verification` is **core** (BetterAuthOptions.emailVerification), not a subpath plugin.

---

## 2. What Better Auth 1.7.1 offers (verified from installed type surface)

Core options (`node_modules/@better-auth/core/dist/types/init-options.d.mts`):
- `baseURL` (string or dynamic `{ allowedHosts, fallback, protocol }`), `secret` /
  versioned `secrets`, `database`, `secondaryStorage`, `appName`, `cookiePrefix`
- `useSecureCookies`, `advanced.disableCSRFCheck`, `advanced.disableOriginCheck`,
  `advanced.trustedProxyHeaders`, `advanced.trustedProxies`,
  `advanced.backgroundTasks`, `advanced.ipv6Subnet`, `advanced.skipTrailingSlashes`
- `trustedOrigins` — explicit allowlist; callback/redirect URL validation is
  backed by it (advanced.disableUrlValidation would disable it — we keep disabled logic ON)
- `rateLimit` — built-in token-bucket rate limiting (configurable window/max)
- `emailAndPassword` — `enabled, disableSignUp, minPasswordLength,
  maxPasswordLength, requireEmailVerification, sendResetPassword,
  resetPasswordTokenExpiresIn` (deleteTokenExpiresIn doc key lives in sendResetPassword data)
- `emailVerification` — `sendVerificationEmail, sendOnSignUp, sendOnSignIn,
  autoSignInAfterVerification, expiresIn, beforeEmailVerification, afterEmailVerification`
- `session` — `expiresIn` (7d default), `updateAge` (1d default),
  `disableSessionRefresh, deferSessionRefresh, storeSessionInDatabase`
- `user.validateUserInfo` — per-method identity gate: source.method ∈
  `{ oauth, sso-oidc, sso-saml, email-password, magic-link, email-otp,
    anonymous, siwe, phone-number, admin }`; source carries `action`
  (`create-user | link-account | sign-in`) + raw provider profile/claims. THE
  supported seam for domain/SSO-style trust policy on the INSTALLED version (no sso plugin).
- `socialProviders` — core OAuth provider registry; `accountLinking` —
  `enabled, disableImplicitLinking, requireLocalEmailVerified (default true),
  trustedProviders (static or per-request fn), allowDifferentEmails,
  allowUnlinkingAll, updateUserInfoOnLink`
- `databaseHooks` (before/after create/update/delete for user/session/account),
  `onAPIError`, `logger`, `plugins`

Plugins (verified type + impl):
- **two-factor** — `enableTwoFactor` (TOTP uri + backup codes issued once;
  otp via server SMTP config also possible), `disableTwoFactor`, `verifyTOTP`,
  `generateBackupCodes`, `verifyBackupCode`, TOTP + email-OTP second factor;
  challenge cookie `two_factor` maxAge 600s; signed cookie via core secret;
  account lockout (max 10, 15min), trusted-device cookie 30d configurable;
  **after-hook matcher is `/sign-in/email | /sign-in/username | /sign-in/phone-number`
  ONLY** — the 2FA challenge intercepts password/username/phone sign-in and
  **NOT** magic-link nor email-otp sign-in (verified in plugin impl).
  The email-OTP plugin creates sessions directly with NO 2FA challenge hook.

  **Enterprise consequence (must be engineered in, verified):	MFA-policy enforced
  for an org cannot rely on boilerplate: magic-link, email-otp, OAuth,
  and passkey(absent here anyway) flows do not emit the 2FA challenge by default.

- **magic-link** — `signInMagicLink` (POST /sign-in/magic-link) + `magicLinkVerify`
  (GET /magic-link/verify?token=…; callbackURL[]); single-use token (atomically
  consumed; custom `allowedAttempts` ignored>1 with warning); expiry default 5min;
  `disableSignUp`; `sendMagicLink({email,url,token})` seam; `storeToken`
  `plain|hashed|custom`; built-in rateLimit defaults 60s/5.
  Verification creates the session DIRECTLY (no email-verification gate, no 2FA hook,
  verified in impl. It DOES verify `emailVerified` via `revokeUnprovenAccountAccess`
  when the local user exists but is unverified (i.e. magic link does NOT auto-verify
  an existing unverified local account; it promotes the account row only after consuming
  the token — effectively email possession proof — and then issues session).
- **email-otp** — 4 flow kinds: `sign-in | email-verification | forget-password | change-email`;
  OTP digits 6 default, expiry 300s default, allowedAttempts 3 default,
  `storeOTP` plain|hashed|encrypted|custom; rate limit defaults 60s/3;
  `atomicVerifyOTP` consumes first (race-safe single use), re-creates on wrong
  code with incrementing attempts, TOO_MANY_ATTEMPTS after bound; **sign-in creates
  the session directly** — NO 2FA challenge, NO requireEmailVerification gate on the
  password path (OTP sign-in treats OTP proof as email verification itself);
  enumeration: send OTP returns generic success; verify distinguishes INVALID_OTP only.

- **generic-oauth** — `GenericOAuthConfig[]`: `providerId, clientId, clientSecret?,
  `discoveryUrl?, authorizationUrl?, tokenUrl?, userInfoUrl?, endSessionEndpoint?,
  `scopes?, redirectURI?, pkce (default true), tokenEndpointAuth,
  requireIdTokenVerification, disableIdTokenNonceBinding, authentication (basic/post),
  mapProfileToUser, accountSubject, accountIssuer, disableSignUp,
  requireEmailVerification?, refreshTokenParams…`; generic provider registers through
  the standard `signIn.social` + shared callback (callback/:id) endpoints — no
  custom route needed. Built-in helpers: auth0, okta, keycloak, microsoftEntraId,
  gumroad, hubspot, line, patreon, slack, yandex (same config shape).
- **organization** — first-class org/member/invitation/team CRUD with its OWN tables in
  Better Auth's database, roles via access plugin, invitations with
  created/accept/cancel/reject/list flows. NOTE: Vaulltcore already has a durable
  identity/org/membership/RBAC model (`@vaulltcore/identity` store) that is the platform's
  authorization authority. The Better Auth org plugin operates on a SEPARATE store and
  would require a reconciliation/mapping layer onto Vaulltcore orgs (see risk below).

---

## 3. Existing Vaulltcore auth architecture (verified in source)

### 3.1 Authority separation (Phase 2G, already correct)

- `@vaulltcore/auth` (packages/vaulltcore-auth) — the ONLY package referencing better-auth
  (`better-auth-adapter.ts`). Better Auth owns users/sessions/OAuth primitives;
  Vaulltcore identity (`@vaulltcore/identity`) owns tenant/org/project/membership/roles/
  API keys; `@vaulltcore/auth` bridges them through `ActorResolver`.
- `BetterAuthAdapter` — requires `secret >=32 chars` + explicit `baseURL`; hardcodes
  `advanced: { disableOriginCheck:false, disableCSRFCheck:false }` (NODE_ENV-independent);
  email+password enabled (minPasswordLength 8); `handleRequest()` bridges
  `/api/auth/*`; `validateSession(cookie)` server-side via `auth.api.getSession`; 
  `migrate()` runs Better Auth's own Kysely migrations; `revokeBetterAuthSession`.
  NO plugins, NO email verification / reset wiring, NO trustedOrigins, NO
  rateLimit config, NO session-token storage customization (registry fingerprint is
  stored in Vaulltcore store, not raw tokens).
- `ActorResolver.resolve({authorization, cookie, requestedOrgId})` — bearer first
  (machine credentials `vc_*`, then Phase 1E API keys `vc_live_`), then cookie session:
  `validateSession` → session fingerprint → `authStore.getSession(fingerprint)` (revoked
  check) → provision user identity idempotently → membership re-read server-side →
  role-derived permissions → Actor with attribution `{ userId, sessionFingerprint }`.
  Denials audited `authentication_failed` with code-only metadata.

- `SqlB2bAuthStore` — Vaulltcore-owned tables (user_identities, service_identities,
  machine_credentials, session_registry; fingerprint-only, fenced transitions...
  Session registry is NOT the session authority — Better Auth remains it. Registry
  provides cross-process revocation + audit.
- `ServiceIdentityService` — machine principal/credential lifecycle (fenced, bounded permissions,
  credential secret shown once, sha256 fingerprint stored).
- role→permission mapping is central (`contracts.ts PERMISSIONS/ROLE_PERMISSIONS`) and
  `authorize()` is the only permission decision point for domain ops.


### 3.2 Control plane wiring (verified in source

- `packages/vaulltcore-control/src/serve.ts` — production composition root. Auth layer
  wired ONLY when `AUTH_BETTER_AUTH_SECRET` (≥32) present: `BetterAuthAdapter`
  constructed with `database` = raw node:sqlite or pg Pool, `secret`, `baseURL` from
  `AUTH_BASE_URL ?? http://localhost:3000`. No plugins, no email/verification wiring.
 No
  email provider. NO Resend anywhere in repo. No .env.example exists.
- `server.ts dispatch` — public trust-boundary exceptions: `/health`, `/auth/*` →
  bridged to Better Auth (all OTHER paths through authenticated pipeline),
  `/oauth/callback` (Phase 2D state-nonce based), authenticated pipeline uses
  `ControlAuthenticator` (default HeaderAuthenticator is TEST/DEV ONLY;serve passes
  `resolveActor` over `ActorResolver` when phase2g wired, else `apiKeyAuthenticator`).
- `phase2g-routes.ts` — `/identity/me|permissions|orgs|orgs/:orgId/members|
  service-identities|sessions|users/:userId/disable|revoke-sessions` fully actor-
  resolved, sanitized projections, audit on sensitive ops (member added/removed/role
  changed, session revoked, user disabled...). No org-invitation, no security-policy
  surface, no email flows yet.
- Frontend (`packages/vaulltcore-web`) — real `AuthProvider` validates against
  `/identity/me` (no client-side trusted identity), API key written to sessionStorage
  then verified (tab-scoped; not localStorage), dev header auth only under
  `VITE_DEV_HEADER_AUTH === "true"` flag. Auth page supports API-key + dev-header
  ONLY — no email/password/SSO forms, no 2FA UI, no SSO admin UI. The
  `mock.ts` repository is used for dev preview only — never for production auth path
  (`signIn` programmatic is dev-header-only path; `ApiError`-deep production real path).`

### 3.3 Data model

- Vaulltcore-owned (`@vaulltcore/identity`): tenants, organizations, projects,
  org_members (PK tenant+org+principal, role), project_grants, principals,
  api_keys (key_prefix+secret_hash fingerprint, scope, rotation) via migration-name-
  deduped migrations (`identity_core` v2, `api_key_lifecycle` v12).
- Vaulltcore-owned (`@vaulltcore/auth`): user_identities, service_identities,
  machine_credentials, session_registry (fingerprint PK, better_auth_session_id,
  revoked_at) via `b2b_identity_core` v1.
- Better Auth-owned (adapter.migrate()): user, session, account, verification
  (+ plugin tables when plugins added) — created by Better Auth's own Kysely
  migration runner over the same database connection the Vaulltcore stores use.


## 4. Baseline proof (tests already green)

- `packages/vaulltcore-auth/test/b2b-security.test.ts` (Phase 2G, real Better Auth
  over node:sqlite, no mocks: sign-up→session→actor, CSRF hostile-Origin
  rejection, weak-secret rejection, org hint validation, revocation, member removal,
  role downgrade, disabled user, fingerprint-only attribution..., service identities,
  machine credentials, session registry.
- `packages/vaulltcore-control/test/phase2g-routes.test.ts` — `/identity/*` control-plane
  surface (401/403/404/409/422, no-leak cross tenant, secret issuance once)..
- Baseline suite status (from phase3a-1 doc): 467 passed / 25 env-gated skips.


## 5. Gap analysis (this task's surface vs current state)

| Required surface | Current state | Where it must live |
|---|---|---|---|
| Email/password, session mgmt, sign-out | Core email+password enabled; sign-out bridged | Better Auth core |
| Email verification | Core `emailVerification` unconfigured (no `sendVerificationEmail`) | Better Auth core + EmailService |
| Password reset | Core `emailAndPassword.sendResetPassword` unconfigured | Better Auth core + EmailService |
| Magic link | Plugin available, unwired | Better Auth `magicLink` plugin + EmailService |
| Email OTP | Plugin available, unwired | Better Auth `emailOTP` plugin + EmailService |
| 2FA (TOTP + backup codes) | Plugin available, unwired | Better Auth `twoFactor` plugin |
| 2FA per-auth-method gating | two-factor after-hook covers only email/username/phone sign-in; magic-link/email-otp/OAuth create sessions directly | **Vaulltcore policy layer** (org auth policy checked at session→actor + flow interception) |
| Passkeys / WebAuthn | **Not shipped in 1.7.1/1.7.2** — do not fake | BLOCKED (upgrade path: better-auth has no public passkey plugin in this version) |
| Better Auth organization plugin | Available, but Vaulltcore already owns org/membership/RBAC | Decide: use BA org plugin as invitation/org-enrollment UX, map into Vaulltcore membership; NEVER second authorization authority |
| Social OAuth (Google/GitHub) | Core `socialProviders` unwired | Better Auth core, env-driven |
| Generic OAuth / OIDC | `genericOAuth` plugin available, unwired | Better Auth generic-oauth plugin, org-admin configured via Vaulltcore policy store |
| SAML | **Not shipped** — do not fake | BLOCKED (better-auth lacks SAML in this minor) |
| BYOS SSO / domain verification / org provisioning | No SSO plugin; `user.validateUserInfo` seam exists (method sso-* refs but no plugin implements them) | Vaulltcore policy layer + generic-oauth + validateUserInfo gate |
| Invitations | Vaulltcore has member mgmt but no invitation flow; BA org plugin has invitations | Adapter over Vaulltcore stores (no cross-store reconciliation) |
| Session revocation / device mgmt | Vaulltcore session_registry list/revoke current/other; BA stores sessions | Existing + BA `multi-session` (optional) |
| API keys | Already enterprise-grade (hash, revoke, scope, tenant-bound, once-display, no localStorage | Keep;test separation |
| Auth rate limiting | Better Auth `rateLimit` unconfigured; plugin rate limits default exist | Better Auth rateLimit + Vaulltcore policy enforcement |
| Security audit events | Existing audit catalog has `authentication_failed`, session_revoked,, plus Phase 2G member/credential events; missing auth-success/password-reset/magic-link/otp/2fa/oauth/sso/invitation events | Extend `AUDIT_EVENT_TYPES` (additive, TEXT,huge no schema change) |
| Resend email | **Not installed** | New EmailService abstraction + optional Resend provider |
| Frontend auth UX | API-key/dev-header only; no forms/2FA/SSO/settings | Extend pages+auth provider (real BA client via server-bridged endpoints) |
| .env.example | Missing | Create |

---

## 6. Security rules that must hold (existing invariants — verified present in source)

1. Tenant/org/project/role NEVER from request body/headers — validated server-side per request.
2. Session registry stores fingerprints only (never tokens). API keys store hash + prefix
   (never plaintext). Machine credential secrets shown once.
3. `authorize()` is the only permission decision; role→permission mapping is central.
4. Cross-tenant reads → 404/no-leak (sameOrg guard before disclosure).
5. Better Auth is the only human session authority; Vaulltcore registry adds revocation;
   there is exactly ONE auth pipeline (`ActorResolver`).
6. CSRF/origin checks are forced ON (disableOriginCheck/disableCSRFCheck false)
   regardless of NODE_ENV.
7. No secrets in audit metadata, logs, responses, session list (fingerprints only).
8. Better Auth adapter requires explicit baseURL + ≥32-char secret (fail fast,
   no insecure defaults).
9. API keys and human sessions are independent (`ApiKeyAuthenticator` / actor Bearer path;
   machine clients need no cookies).
10. A valid session never implies permission; org membership is re-read at every request.