/**
 * Better Auth adapter (Phase 2G). The ONLY place Better Auth is referenced —
 * the rest of the product depends on Vaulltcore identity contracts.
 *
 * Better Auth owns: user authentication, session issuance/validation, and
 * OAuth/social/enterprise login primitives. It has NO say over Vaulltcore
 * authorization — a valid session never implies permission by itself.
 *
 * Security posture (configured, not defaulted):
 * - `secret` and `baseURL` are REQUIRED (fail fast, no insecure defaults).
 * - CSRF: state-changing /auth/* POSTs are protected by Better Auth's
 *   own origin checking; browsers send Origin on form/fetch POSTs.
 * - Session cookies: httpOnly + sameSite=lax by framework defaults; secure
 *   transport is a deployment concern (`useSecureCookies` option).
 */

import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"

type BetterAuthInstance = ReturnType<typeof betterAuth>

export interface BetterAuthAdapterOptions {
  /** Database the Better Auth tables live in (e.g. node:sqlite DatabaseSync,
   *  or any driver Better Auth supports). BA-owned tables; Vaulltcore identity
   *  tables live in the SqlStoreBase seam. */
  database: unknown
  secret: string
  baseURL: string
  /** Email+password enabled by default; additional BA plugins/providers are
   *  passed via `configure`. */
  configure?: (options: Record<string, unknown>) => Record<string, unknown>
}

export interface SessionInfo {
  readonly userId: string
  readonly sessionId: string
  /** Raw session token — used only to compute a fingerprint; never stored/logged. */
  readonly token: string
  readonly expiresAt: number
}

export interface BridgedResponse {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

export interface BridgedRequest {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly body?: string
}

export class BetterAuthAdapter {
  private readonly auth: BetterAuthInstance
  private readonly baseURL: string

  constructor(options: BetterAuthAdapterOptions) {
    if (!options.secret || options.secret.length < 32) {
      throw new Error("Better Auth requires a >=32-char secret (no insecure default)")
    }
    if (!options.baseURL) throw new Error("Better Auth requires an explicit baseURL")
    const base: Record<string, unknown> = {
      database: options.database,
      secret: options.secret,
      baseURL: options.baseURL,
      emailAndPassword: { enabled: true, minPasswordLength: 8 },
      // Hardcoded security posture: Better Auth defaults `skipOriginCheck`
      // when NODE_ENV=test — an insecure dev default. We force the origin
      // check ON regardless of environment; test configuration must not
      // silently leak into any path.
      advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    }
    this.baseURL = options.baseURL
    this.auth = betterAuth(options.configure ? options.configure(base) : base)
  }

  /** Run Better Auth's own schema migrations (BA-owned tables). */
  async migrate(): Promise<void> {
    const { runMigrations } = await getMigrations(this.auth.options)
    await runMigrations()
  }

  /**
   * Bridge a node HTTP request to the Better Auth handler. Used by the
   * control plane to expose the public `/auth/*` endpoints (sign-up, sign-in,
   * sign-out, OAuth flows). Response headers include raw Set-Cookie values.
   */
  async handleRequest(request: BridgedRequest): Promise<BridgedResponse> {
    const url = new URL(request.path, this.baseURL.replace(/\/$/, ""))
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue
      headers.set(key, Array.isArray(value) ? value.join(",") : value)
    }
    const webRequest = new Request(url, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
    })
    const response = await this.auth.handler(webRequest)
    const out: Record<string, string | string[] | undefined> = {}
    response.headers.forEach((value, key) => {
      out[key] = value
    })
    // Headers.forEach collapses multiple Set-Cookie values; recover them raw.
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : undefined
    if (cookies && cookies.length > 0) out["set-cookie"] = cookies
    return { status: response.status, headers: out, body: await response.text() }
  }

  /**
   * Server-side session validation. Returns null for invalid/expired/revoked
   * sessions. The returned token is used ONLY to compute a fingerprint.
   */
  async validateSession(cookieHeader: string | null | undefined): Promise<SessionInfo | null> {
    if (!cookieHeader) return null
    const headers = new Headers({ cookie: cookieHeader })
    const session = await this.auth.api.getSession({ headers })
    if (!session) return null
    return {
      userId: session.user.id,
      sessionId: session.session.id,
      token: session.session.token,
      expiresAt: new Date(session.session.expiresAt).getTime(),
    }
  }

  /**
   * Best-effort Better Auth-side revocation of the CURRENT session (sign-out
   * semantics). Vaulltcore-level revocation (session_registry) is the
   * authoritative deny anyway; this keeps Better Auth's own store tidy.
   */
  async revokeBetterAuthSession(cookieHeader: string): Promise<void> {
    const result = await this.handleRequest({
      method: "POST",
      path: "/api/auth/sign-out",
      headers: {
        cookie: cookieHeader,
        origin: this.baseURL,
      },
    })
    if (result.status >= 400) {
      // Better Auth session may already be gone; Vaulltcore registry still
      // governs. Deliberately a no-op best-effort cleanup.
    }
  }
}
