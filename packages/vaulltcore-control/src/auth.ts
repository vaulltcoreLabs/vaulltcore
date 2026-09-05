/**
 * Replaceable authentication boundary for the control plane (Phase 1C).
 *
 * Route handlers receive an authenticated principal obtained from the
 * configured authenticator. The tenant identity NEVER comes from the request
 * body — a forged `tenantId` field cannot select another tenant's job.
 */

import type { IncomingMessage } from "node:http"

export interface AuthnPrincipal {
  readonly tenantId: string
  readonly orgId: string
  /** Project scope. `null` = NO project access (never wildcard-from-absence). */
  readonly projectId: string | null
  /** Whether the principal may monitor other tenants (deny by default). */
  readonly admin?: boolean
}

export interface ControlAuthenticator {
  authenticate(request: IncomingMessage): Promise<AuthnPrincipal | null>
}

/**
 * Test/authenticator-in-a-box: trusts `x-vc-tenant` / `x-vc-org` /
 * `x-vc-project` headers verbatim. The request BODY is never consulted for
 * identity.
 *
 * FAIL-CLOSED: this authenticator must never be constructible in any
 * environment that has not explicitly opted into header trusts. Test suites set
 * `NODE_ENV=test`; production/CI embedders must set
 * `VAULLTCORE_ALLOW_HEADER_AUTH=true` to use it and SHOULD only do so behind
 * a trusted network boundary. `ControlPlane` never selects it implicitly —
 * see {@link DenyAuthenticator}. */
export class HeaderAuthenticator implements ControlAuthenticator {
  readonly allowHeaderAuth: boolean
  constructor(options: { allowHeaderAuth?: boolean } = {}) {
    const envAllowed = process.env.NODE_ENV === "test" || process.env.VAULLTCORE_ALLOW_HEADER_AUTH === "true"
    this.allowHeaderAuth = options.allowHeaderAuth ?? envAllowed
  }

  async authenticate(request: IncomingMessage): Promise<AuthnPrincipal | null> {
    if (!this.allowHeaderAuth) return null
    const tenantId = request.headers["x-vc-tenant"]
    const orgId = request.headers["x-vc-org"]
    const projectId = request.headers["x-vc-project"]
    if (typeof tenantId !== "string" || typeof orgId !== "string" || tenantId === "" || orgId === "") return null
    return {
      tenantId,
      orgId,
      // The EXPLICIT dev/test header trust box maintains its historical contract:
      // an omitted project header means org-wide wildcard. This is a trusted
      // boundary only;`serve.ts` never uses it for session actors (grantless
      // sessions map to null → every business route denies).
      projectId: typeof projectId === "string" && projectId !== "" ? projectId : "*",
    }
  }
}

/**
 * Authenticator that ALWAYS denies. The `ControlPlane` default — a plane
 * constructed without an explicit authenticator must fail closed, never trust
 * self-asserted tenant headers. A state-changing config error (missing
 * authenticator) then surfaces as a 401 on every route instead of a
 * cross-tenant hole. */
export class DenyAuthenticator implements ControlAuthenticator {
  async authenticate(_request: IncomingMessage): Promise<AuthnPrincipal | null> {
    return null
  }
}
