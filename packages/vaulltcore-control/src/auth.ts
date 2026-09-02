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
  readonly projectId: string
  /** Whether the principal may monitor other tenants (deny by default). */
  readonly admin?: boolean
}

export interface ControlAuthenticator {
  authenticate(request: IncomingMessage): Promise<AuthnPrincipal | null>
}

/** Test/authenticator-in-a-box: trusts `x-tenant` / `x-org` / `x-project`
 * test headers. Replace in production (JWT, mTLS, internal SSO, ...). The
 * request BODY is never consulted for identity. */
export class HeaderAuthenticator implements ControlAuthenticator {
  async authenticate(request: IncomingMessage): Promise<AuthnPrincipal | null> {
    const tenantId = request.headers["x-vc-tenant"]
    const orgId = request.headers["x-vc-org"]
    const projectId = request.headers["x-vc-project"]
    if (typeof tenantId !== "string" || typeof orgId !== "string" || tenantId === "" || orgId === "") return null
    return {
      tenantId,
      orgId,
      projectId: typeof projectId === "string" && projectId !== "" ? projectId : "*",
    }
  }
}
