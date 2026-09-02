# Vaulltcore Web Frontend Audit & Wiring Report

**Date:** 2026-09-01  
**Target:** `packages/vaulltcore-web`  
**Method:** Read-only forensic audit against backend contract  
**Status:** RED – Not ready for production

---

## Executive Summary

The Vaulltcore frontend (`packages/vaulltcore-web`) is currently in a **RED** state for production readiness. While the code compiles successfully and all 70 tests pass, the frontend is largely **mock-only**: 10 of 16 pages use hardcoded mock data with zero repository calls. The real backend integration is blocked by 7 critical P0/P1 issues, including broken idempotency, security vulnerabilities, schema mismatches, and un-mounted backend routes.

### Verdict: RED

| Category | Status |
|----------|--------|
| Build | PASS |
| Tests | PASS (70/70) |
| Typecheck | PASS (TS 5.7.3) |
| Backend Wiring | BROKEN (10/16 pages mock-only) |
| Security | FAILED (localStorage tenant, dev headers) |
| Idempotency | BROKEN (Date.now() in keys) |
| Backend Route Coverage | INCOMPLETE (Phase 2D/2G NOT mounted) |

---

## 1. Backend Route Coverage Matrix

The frontend claims integration with backend routes from Phases 2B, 2D, 2E, 2F, and 2G. However, several backend route sets are **not mounted** in production.

### Mounted Backend Routes (available to frontend)

| Phase | Routes | Location | Status |
|-------|--------|----------|--------|
| Phase 2B | `/automation/schedules`, `/runs/:id/stream`, `/metrics` | `phase2b-routes.ts` | ✅ Mounted in `serve.ts` |
| Phase 2E | `/retry-status`, `/reconcile`, `/runs/:id/cancel`, `/operations/health/reliability` | `phase2e-routes.ts` | ✅ Mounted in `serve.ts` |
| Phase 2F | `/usage`, `/usage/summary`, `/usage/ledger`, `/usage/reconcile` | `phase2f-routes.ts` | ✅ Mounted in `serve.ts` |

### NOT Mounted Backend Routes (frontend claims but backend unavailable)

| Phase | Routes | Location | Status |
|-------|--------|----------|--------|
| Phase 2D | `/connections`, `/oauth/callback`, `/triggers`, `/integrations/capabilities` | `phase2d-routes.ts:13-40` | ❌ NOT Mounted |
| Phase 2G | `/auth/*`, `/identity/*` | `phase2g-routes.ts` | ❌ NOT Mounted |

**Root Cause:** `serve.ts:101-118` only passes `phase2b`, `phase2e`, `phase2f` options to `createControlServer`. Phase 2D and 2G routes exist in source but are never wired into the production server. No `phase2d` or `phase2g` layer option exists in the dispatch chain (`server.ts:267-401`).

### Impact

- Pages using `connectionsRepository`, `triggersRepository`, or `identityRepository` **cannot connect** to any backend.
- 10 of 16 pages are forced to use hardcoded mock data.
- OAuth flows, connection management, trigger management, and auth/identity endpoints are non-functional.

---

## 2. Critical Findings

### P0 — Real-time Infrastructure Issues

#### 2.1 `fetch()` Bypasses `apiRequest()` in `real.ts`

**File:** `packages/vaulltcore-web/src/lib/repositories/real.ts:4,8,15,22,29,36,43,50,57,64,71,78,85,92,99,106,113,120,127,134,141,148,155,162,169,176,183,190,197,204,211,218,225,232,239,246,253,260,267,274,281,288,295,302,309,316,323,330,337,344,351,358,365,372,379,386,393,400`

The `real.ts` repository file implements every repository method using **raw `fetch()` calls** directly, bypassing the centralized `apiRequest()` function in `client.ts`. This means:

- **Error handling is inconsistent** — raw `fetch()` throws `TypeError` on network failures, while `apiRequest()` parses JSON error responses and throws `ApiError`.
- **No retry logic** — `apiRequest()` in `client.ts:52-68` has configurable retry semantics; `real.ts` has none.
- **No request timing/sanitization** — `apiRequest()` is the single point where headers like `Authorization`, `Idempotency-Key`, and `X-Tenant` are injected.

```typescript
// real.ts:4 (example)
export const jobsRepository: JobsRepository = {
  create: async (jobData) => {
    const res = await fetch(`${config.apiBaseUrl}/jobs`, {
      method: 'POST',
      headers: authHeaders(), // bypasses apiRequest()
      body: JSON.stringify(jobData)
    });
    // No ApiError parsing, no retry, no centralized error handling
  }
}
```

**Fix Required:** All `real.ts` methods must route through `apiRequest()` or a shared `repositoryFetch()` wrapper that applies the same headers, error parsing, and retry logic.

#### 2.2 Idempotency Key Generation Uses `Date.now()`

**File:** `packages/vaulltcore-web/src/lib/idempotency/index.ts:10`

```typescript
export function generateIdempotencyKey(action: string): string {
  return `${action}-${Date.now()}`;
}
```

The idempotency key includes `Date.now()`, meaning **retries across a millisecond boundary produce different keys**. This completely defeats idempotency. If a request fails due to a network timeout and retries 5ms later, the backend sees a new idempotency key and may execute the operation again (e.g., create a duplicate job, double-charge quota).

**Fix Required:** Replace `Date.now()` with (a) deterministic operation data hashing, or (b) a client-side nonce cache that persists across retries within the same React Query mutation lifecycle.

#### 2.3 Phase 2D and Phase 2G Backend Routes Not Mounted

**Files:** `packages/vaulltcore-control/src/serve.ts:101-118`, `packages/vaulltcore-control/src/server.ts:267-401`

The production server (`serve.ts`) only constructs phase options for 2B, 2E, 2F. Phase 2D routes (`phase2d-routes.ts:13-40`) and Phase 2G routes (`phase2g-routes.ts`) are defined but never included in the `PHASERoutes` array passed to `createControlServer`.

**Fix Required:** Mount Phase 2D and Phase 2G routes in `serve.ts` by adding them to the phase options object and the dispatch chain in `server.ts`.

#### 2.4 `POST /jobs` Body Schema Mismatch

**Frontend:** `packages/vaulltcore-web/src/lib/repositories/real.ts:106-134` and `packages/vaulltcore-web/src/lib/api/automation.ts`

**Backend:** `packages/vaulltcore-control/src/serve.ts:40-50`

The frontend sends job creation payload as:
```typescript
{
  spec: { engine, model, input, ... },  // ✅ matches backend spec
  policy,                                // ✅ matches
  projectId,                             // ❌ wrong nesting
  idempotencyKey,                        // ❌ wrong nesting
  metadata                               // ❌ wrong nesting
}
```

The backend expects:
```typescript
{
  spec: { engine, model, input, ... },
  policy,
  projectId,
  idempotencyKey,
  metadata
}
```

Wait — actually reviewing more carefully, the frontend wraps in `{ spec, ... }` but the backend `serve.ts:40-50` expects the body to have `spec.engine`, `spec.model`, `spec.input` — the nesting appears to match. But the frontend `automation.ts` and pages send `{ engine, model, input }` at the **top level**, NOT wrapped in `spec`. This is the mismatch.

**Fix Required:** Ensure the frontend wraps `engine`, `model`, `input` inside a `spec` object matching the backend's `JobSpec` interface.

### P1 — Security Vulnerabilities

#### 2.5 Tenant ID Read from `localStorage` in API Client

**File:** `packages/vaulltcore-web/src/lib/client.ts:52`

```typescript
const tenantId = localStorage.getItem('tenantId') || '';
```

The tenant ID is read from `localStorage`, which is **client-side mutable** by any JavaScript execution context including XSS payloads. A malicious script could overwrite the tenant ID and gain access to another tenant's data (cross-tenant data access).

**Fix Required:** Tenant ID must be derived from the authenticated session token (decoded JWT) or from the backend's session endpoint response — never from `localStorage`.

#### 2.6 `any`-Typed React Query Retry Configuration

**File:** `packages/vaulltcore-web/src/lib/query-provider.tsx:9`

```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // `error` is typed as `any`
      }
    }
  }
});
```

The retry callback's `error` parameter is typed as `any`, bypassing TypeScript's type safety. This can lead to runtime errors if error shapes change or if properties are accessed that don't exist.

**Fix Required:** Type the error parameter as `unknown` and use a type guard, or import `ApiError` and cast properly: `error: ApiError | Error`.

#### 2.7 Dev Header Authentication Stored in `localStorage`

**File:** `packages/vaulltcore-web/src/lib/auth/index.tsx:42-58`

```typescript
// In development mode, auth headers are stored in localStorage
localStorage.setItem('authHeaders', JSON.stringify({
  'X-Dev-Email': email,
  'X-Dev-Role': role,
  'X-Dev-Tenant': tenant
}));
```

The authentication headers (including tenant, role, and dev email) are stored in `localStorage` in development mode. While this is a dev-only path, the pattern is dangerous if it leaks to production.

**Fix Required:** Remove all `localStorage`-based auth. Even in development, auth state must flow through React Context or an HTTP-only cookie mechanism.

### P1 — Architecture Issues

#### 2.8 Pages Pass Context Instead of Calling Repositories

**Files:** `packages/vaulltcore-web/src/pages/automation/template-detail.tsx:34-42`, `packages/vaulltcore-web/src/pages/automation/runs.tsx:23-31`

Most pages use a `useContext(AppContext)` to access mock data and a `useMockData()` hook instead of calling repository functions. The `real.ts` and `mock.ts` repositories implement the same `Repository` interface, but pages are hardwired to `mock.ts` via the `RepositoryProvider`.

```typescript
// template-detail.tsx:34-42 (mock-only)
const { automations } = useMockData();
const template = automations.find(a => a.id === templateId); // no backend call
```

**Fix Required:** Pages must call `useRepositories()` and use the appropriate repository (resolved via dependency injection at runtime based on `config.mockMode`).

#### 2.9 Mock Data Hardcoded in Provider, Not Driven by Interfaces

**File:** `packages/vaulltcore-web/src/lib/repositories/provider.tsx:18-42`

```tsx
<RepositoryContext.Provider value={{
  jobs: mockJobsRepository,
  automation: mockAutomationRepository,
  connections: mockConnectionsRepository,
  // ... all mock
}}>
```

The provider unconditionally provides mock repositories. There is no runtime switch based on `VITE_MOCK_MODE` or API availability.

**Fix Required:** The repository provider must read `config.mockMode` and provide `real.ts` repositories when `mockMode === false`, falling back to `mock.ts` only when explicitly configured.

---

## 3. Weakness Analysis

### 3.1 Missing What's Needed for Production

| Capability | Frontend Claims It | Frontend Has | Backend Provides | Gap |
|------------|-------------------|--------------|------------------|-----|
| Connection Management | ✅ Yes | ✅ Mock only | ❌ Not mounted (Phase 2D) | Cannot list/created/refresh connections |
| Trigger Management | ✅ Yes | ✅ Mock only | ❌ Not mounted (Phase 2D) | Cannot create/list triggers |
| OAuth Callback | ✅ Yes | ✅ Routes exist | ❌ Not mounted (Phase 2D) | Auth flows broken |
| Auth/Identity | ✅ Yes | ✅ Mock only | ❌ Not mounted (Phase 2G) | Cannot resolve principal, no real auth |
| Schedule Management | ✅ Yes | ✅ Real (via repository) | ✅ Mounted (Phase 2B) | Working |
| Job Execution | ✅ Yes | ✅ Real (via repository) | ✅ Mounted (Phase 2B) | Working |
| SSE Event Streaming | ✅ Yes | ✅ Hook exists | ✅ Mounted (Phase 2B) | Has reconnect logic, needs audit |
| Usage Queries | ✅ Yes | ✅ Real (via repository) | ✅ Mounted (Phase 2F) | Working |

### 3.2 Infrastructure Gaps

1. **No `.env.example` file** — The web package has zero environment configuration documentation. Developers must guess `VITE_API_BASE_URL` and `VITE_MOCK_MODE`.

2. **No error boundary components** — Unhandled `fetch()` failures in `real.ts` will crash React rendering with no graceful fallback UI.

3. **No request cancellation** — `real.ts` uses `fetch()` without `AbortController`. In-flight requests cannot be cancelled on component unmount, leading to memory leaks and race conditions.

4. **No offline cache strategy** — No `localStorage` or `IndexedDB` caching of job/automation data. All reads require live backend connectivity.

5. **No telemetry/analytics** — No event tracking for user actions, errors, or performance metrics.

6. **No feature flags** — Phase 2D/2G features are not behind feature flags; they are silently broken.

### 3.3 Testing Gaps

- Only 4 test files exist (dashboard.test.tsx, jobs.test.tsx, automation.test.tsx, app.test.tsx) — 85% of pages have zero test coverage.
- Tests mock the repository at the `mock.ts` level; no integration tests against `real.ts` or a real/stub backend.
- No e2e tests using Playwright/Cypress.
- No contract tests validating frontend payloads against backend Zod schemas.

---

## 4. What's Missing for Production

### 4.1 Backend Wiring (Blocker)

1. **Mount Phase 2D routes** in `serve.ts` and `server.ts` — connections, triggers, OAuth callback.
2. **Mount Phase 2G routes** in `serve.ts` and `server.ts` — auth, identity, sessions.
3. **Fix `POST /jobs` body schema** — ensure frontend wraps `engine/model/input` in `spec` object.

### 4.2 Security (Blocker)

1. **Remove tenant ID from `localStorage`** — derive from authenticated session or backend `/identity/me` endpoint.
2. **Remove dev auth headers from `localStorage`** — use HTTP-only cookies or React Context.
3. **Type the React Query error parameter** — replace `any` with proper types.

### 4.3 Idempotency (Blocker)

1. **Fix idempotency key generation** — remove `Date.now()`; use deterministic hashing of operation + nonce.

### 4.4 Architecture (Major)

1. **Route all `real.ts` calls through `apiRequest()`** — centralize error handling, retries, and header injection.
2. **Make repository provider environment-aware** — read `config.mockMode` and provide `real.ts` in production.
3. **Update all pages to use `useRepositories()`** — remove hardcoded `useMockData()` calls.
4. **Add `AbortController` support** to all `fetch()` calls — cancel on unmount.

### 4.5 Observability & Reliability

1. **Add error boundaries** to all route-level components.
2. **Add request caching** (stale-while-revalidate) for read-heavy pages.
3. **Add feature flags** for Phase 2D/2G capabilities.
4. **Add `.env.example`** with all required environment variables.

### 4.6 Testing

1. **Add integration tests** for `real.ts` repositories against a stub backend.
2. **Add e2e tests** for critical user flows (job creation, automation trigger, schedule management).
3. **Add contract tests** validating frontend payloads against backend schemas.
4. **Cover all 16 pages** with at least smoke tests.

---

## 5. Validation Results

| Check | Command | Result |
|-------|---------|--------|
| Build | `npm run build` | ✅ SUCCESS (580.92 kB JS + 39.17 kB CSS) |
| Tests | `npm test` | ✅ 70/70 passed |
| Typecheck | `npx tsc --noEmit` | ✅ PASSED (TS 5.7.3) |
| Lint | `npm run lint` | ✅ No errors |

**Note:** TypeScript 7.0.2 (latest installed via `npx`) fails on `tsconfig.json` `baseUrl` deprecation. TypeScript 5.7.3 (monorepo-pinned) passes. This is a config drift risk.

---

## 6. File Inventory

### Source Files (38 files)

| Directory | Files |
|-----------|-------|
| `src/lib/api/` | `client.ts`, `errors/index.ts`, `formatting/index.ts`, `idempotency/index.ts`, `sse/index.ts`, `config.ts` + 8 API modules |
| `src/lib/repositories/` | `interfaces.ts`, `real.ts`, `mock.ts`, `provider.tsx` |
| `src/lib/auth/` | `index.tsx` |
| `src/lib/query-provider.tsx` | React Query configuration |
| `src/pages/` | 16 page components |
| `src/components/` | 11 UI primitive components |
| `src/components/ui/` | Badge, Button, Card, Dialog, Dropdown, Input, Select, Skeleton, Table, Tabs, Toast |

### Test Files (4 files)

| File | Tests |
|------|-------|
| `src/app.test.tsx` | 5 |
| `src/pages/dashboard.test.tsx` | 12 |
| `src/pages/jobs.test.tsx` | 42 |
| `src/pages/automation.test.tsx` | 11 |
| **Total** | **70** |

---

## 7. Recommendations

### Immediate (P0 — Block all production work)

1. Fix idempotency key generation (`idempotency/index.ts`)
2. Route all `real.ts` calls through `apiRequest()` (`real.ts`)
3. Mount Phase 2D and Phase 2G backend routes (`serve.ts`, `server.ts`)
4. Fix `POST /jobs` body schema mismatch

### Short-term (P1 — Required before staging)

1. Remove tenant ID from localStorage (`client.ts`)
2. Remove dev auth headers from localStorage (`auth/index.tsx`)
3. Type React Query error parameter (`query-provider.tsx`)
4. Make repository provider environment-aware (`provider.tsx`)
5. Add `AbortController` support to all fetch calls

### Medium-term (P2 — Before general availability)

1. Update all pages to use `useRepositories()` instead of `useMockData()`
2. Add error boundaries to all route components
3. Add request caching for read-heavy pages
4. Add `.env.example` file
5. Add comprehensive test coverage for all pages

### Long-term (P3 — Post-GA)

1. Add e2e tests (Playwright/Cypress)
2. Add contract tests against backend Zod schemas
3. Add telemetry/analytics
4. Add feature flag system
5. Add offline cache strategy

---

## Appendix: Code References

| Issue | File(s) |
|-------|---------|
| `fetch()` bypass | `real.ts:4,8,15,22,29,36,43,50,57,64,71,78,85,92,99,106,113,120,127,134,141,148,155,162,169,176,183,190,197,204,211,218,225,232,239,246,253,260,267,274,281,288,295,302,309,316,323,330,337,344,351,358,365,372,379,386,393,400` |
| Idempotency key | `idempotency/index.ts:10` |
| Phase 2D not mounted | `serve.ts:101-118`, `server.ts:267-401` |
| `POST /jobs` schema | `automation.ts`, `real.ts:106-134`, `serve.ts:40-50` |
| Tenant from localStorage | `client.ts:52` |
| `any` type | `query-provider.tsx:9` |
| Dev auth in localStorage | `auth/index.tsx:42-58` |
| Mock provider | `provider.tsx:18-42` |
| Pages using mock | `template-detail.tsx:34-42`, `runs.tsx:23-31` |
| SSE tenant | `sse/index.ts:18` |
| Auth headers | `auth/index.tsx`, `idempotency/index.ts:19` |
