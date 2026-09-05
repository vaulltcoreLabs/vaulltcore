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

import { betterAuth, socialProviders } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { emailOTP } from "better-auth/plugins/email-otp"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { magicLink } from "better-auth/plugins/magic-link"
import { twoFactor } from "better-auth/plugins/two-factor"
import { renderTemplate } from "@vaulltcore/email"

type BetterAuthInstance = ReturnType<typeof betterAuth>

/** The enterprise email service seam (Phase 3/4). The adapter stays
 *  backward-compatible: no email service ⇒ no email-driven plugin is
 *  configured and email/password session auth keeps working with the secure
 *  default posture. */
export interface AuthEmailBridge {
  kind: "email-verification" | "password-reset" | "magic-link" | "email-otp" | "two-factor-otp" | "security-notification"
  toEmail: string
  subject: string
  html: string
  text: string
}

export interface EmailServiceLike {
  readonly providerId: string
  send(email: Readonly<AuthEmailBridge>): Promise<{ messageId: string }>
}

/**
 * Bridge the neutral, deterministic, branded email template layer (phase 3)
 * to the Better Auth email hooks. Every link is validated same-origin against
 * the canonical public origin; user-controlled fields are escaped; the OTP is
 * never logged/audited — only placed inside the generated one-time email body.
 */
export interface RenderAuthEmailInput {
  publicURL: string
  emailKind: "email-verification" | "password-reset" | "magic-link" | "email-otp"
  href?: string
  otp?: string
  purpose?: "sign-in" | "email-verification" | "forget-password"
  minutes?: number
}

export function renderAuthEmail(input: Readonly<RenderAuthEmailInput>): {
  subject: string
  html: string
  text: string
} {
  if (input.emailKind === "email-otp") {
    const email = renderTemplate({
      kind: "email-otp",
      origin: input.publicURL,
      toEmail: "",
      otp: input.otp ?? "",
      minutes: input.minutes ?? 5,
      purpose: input.purpose ?? "sign-in",
    })
    return { subject: email.subject, html: email.html, text: email.text }
  }
  const email = renderTemplate({
    kind: input.emailKind,
    origin: input.publicURL,
    toEmail: "",
    href: input.href ?? "/",
    action: input.emailKind === "email-verification" ? "Verify your email" : input.emailKind === "password-reset" ? "Reset your password" : "Sign in to Vaulltcore",
    cta: input.emailKind === "email-verification" ? "Verify email" : input.emailKind === "password-reset" ? "Reset password" : "Sign in",
    hint: "This link is single-use and expires soon. If you did not request this email, ignore it.",
  })
  return { subject: email.subject, html: email.html, text: email.text }
}

export interface TrustedOriginResolve {
  (request?: Request): Promise<(string | undefined | null)[]> | (string | undefined | null)[]
}

export interface BetterAuthAdapterOptions {
  /** Database the Better Auth tables live in (e.g. node:sqlite DatabaseSync,
   *  or any driver Better Auth supports). BA-owned tables; Vaulltcore identity
   *  tables live in the SqlStoreBase seam. */
  database: unknown
  secret: string
  baseURL: string
  /** Canonical public origin used to render safe email links. Defaults to
   *  `baseURL`; must match the deployed frontend origin for email callbacks. */
  publicURL?: string
  /** Email delivery abstraction (Phase 3/4). When provided, you get:
   *  email verification (sendVerificationEmail), password reset
   *  (sendResetPassword), magic link (Phase 6: single-use, expiry,
   *   atomic consume, same-origin callback only), email OTP (Phase 7:
   *   bounded attempts via allowedAttempts, hashed-at-rest via storeOTP,
   *   sendVerificationOTP for verification/sign-in/forget-password flows),
   *   and 2FA email-OTP second factor (Phase 8) —
   *   ALL rendered through the neutral EmailService abstraction with
   *   origin-constrained, escaped, deterministic templates. */
  emailService?: EmailServiceLike
  /** Exactly the trusted origins Better Auth validates callback/redirect URLs
   *  against. Never a wildcard-wily credential origin. Defaults to
   *  `[publicURL]` when unset (explicit env-driven origins in production). */
  trustedOrigins?: string[]
  /** Observable rate limits for sensitive auth paths (Phase 27). Keys are
   *  Better Auth path prefixes, e.g. "/sign-in", "/email-otp/send",
   *  "/two-factor/", "/magic-link/". CustomRules override the default budget
   *  for auth-critical endpoints only; other paths keep the global default. */
  rateLimit?: {
    windowSec?: number
    max?: number
    enabled?: boolean
    customRules?: Record<string, { window: number; max: number } | false>
  }
  /** Environment-driven Google OAuth (Phase 18 social). Secrets are
   *  server-only; redirectURI is ALWAYS derived from the canonical baseURL
   *  (never an untrusted Host header). PKCE/nonce are Better Auth defaults. */
  google?: { clientId: string; clientSecret: string }
  /** Environment-driven GitHub OAuth (Phase 18). */
  github?: { clientId: string; clientSecret: string }
  /** BYOS OIDC/OAuth2 enterprise IdP (Phases 12-13, via generic-oauth
   *  with OIDC discovery). Discovery + issuer + requireIdTokenVerification
   *  enable safe verified profile identity; PKCE on by default; nonce
   *  replay protection on for discovery providers. Secrets server-only. */
  genericOidc?: Array<{
    providerId: string
    name?: string
    discoveryUrl: string
    clientId: string
    clientSecret?: string
    scopes?: string[]
    requireEmailVerification?: boolean
  }>
  /** Better Auth's own global rate-limit storage (defaults to its DB-backed
   *  storage when `database` is provided). */
  rateLimitStorage?: "memory" | "database" | "secondary-storage"
  /** Force Secure cookies (production HTTPS posture; default: secure when
   *  the deployment URL is https). */
  useSecureCookies?: boolean
  /** Session lifetime (seconds); default 7 days. */
  sessionMaxAge?: number
  /** Session refresh interval (seconds); default 1 day. */
  sessionUpdateAge?: number
  /** Require verified email before a session is issued for password sign-in
   *  (Phase 5). Email OTP override path is configured when emailService
   *  is present: signUp sends a verification OTP and sign-in gates on it. */
  requireEmailVerification?: boolean
  /** Enforce 2FA (Phase 8/15 baseline) — see org policy layer for
   *  organization-scoped MFA enforcement; this is the user-level default. */
  twoFactor?: {
    twoFactorCookieMaxAge?: number
    trustDeviceMaxAge?: number
    enforceForEmailPassword?: boolean
    allowedPasswordlessMethods?: Array<"magic-link" | "email-otp" | "oauth" | "passkey">
    issuer?: string
    backupCodeAmount?: number
  }
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
  private readonly publicURL: string

  constructor(options: BetterAuthAdapterOptions) {
    if (!options.secret || options.secret.length < 32) {
      throw new Error("Better Auth requires a >=32-char secret (no insecure default)")
    }
    if (!options.baseURL) throw new Error("Better Auth requires an explicit baseURL")
    const publicURL = (options.publicURL ?? options.baseURL).replace(/\/$/, "")
    this.baseURL = options.baseURL
    this.publicURL = publicURL

    const emailService = options.emailService
    const trustedOrigins = options.trustedOrigins?.length
      ? options.trustedOrigins
      : [publicURL]

    const advanced: Record<string, unknown> = {
      // Hardcoded security posture: Better Auth defaults `skipOriginCheck`
      // when NODE_ENV=test — an insecure dev default. We force the origin
      // check ON regardless of environment; test configuration must not
      // silently leak into any path.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    }
    if (options.useSecureCookies !== undefined) advanced.useSecureCookies = options.useSecureCookies

    const base: Record<string, unknown> = {
      database: options.database,
      secret: options.secret,
      baseURL: options.baseURL,
      trustedOrigins,
      plugins: [] as unknown[],
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 8,
        ...(options.requireEmailVerification ? { requireEmailVerification: true } : {}),
        ...(emailService ? {
          sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
            const parsed = new URL(url)
            const href = parsed.pathname + parsed.search
            const rendered = renderAuthEmail({
              publicURL,
              emailKind: "password-reset",
              href,
            })
            await emailService.send({
              kind: "password-reset",
              toEmail: user.email,
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
            })
          },
        } : {}),
      },
      ...(emailService ? {
        emailVerification: {
          sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
            const parsed = new URL(url)
            const href = parsed.pathname + parsed.search
            const rendered = renderAuthEmail({
              publicURL,
              emailKind: "email-verification",
              href,
            })
            await emailService.send({
              kind: "email-verification",
              toEmail: user.email,
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
            })
          },
          ...(options.requireEmailVerification ? { sendOnSignUp: true, autoSignInAfterVerification: true } : {}),
        },
      } : {}),
      ...(options.sessionMaxAge || options.sessionUpdateAge ? {
        session: {
          ...(options.sessionMaxAge ? { expiresIn: options.sessionMaxAge } : {}),
          ...(options.sessionUpdateAge ? { updateAge: options.sessionUpdateAge } : {}),
        },
      } : {}),
      advanced,
    }

    const plugins: unknown[] = []
    if (emailService) {
      // Phase 6 — Magic link: single-use (consumed atomically by 1.7.1),
      // expiry (expiresIn), hashed-at-rest, same-origin callback only.


      plugins.push(magicLink({
        storeToken: "hashed",
        allowedAttempts: 1,
        expiresIn: 10 * 60,
        disableSignUp: true,
        sendMagicLink: async ({ email, url }: { email: string; url: string }) => {
          const parsed = new URL(url)
          const rendered = renderAuthEmail({
            publicURL,
            emailKind: "magic-link",
            href: parsed.pathname + parsed.search,
          })
          await emailService.send({
            kind: "magic-link",
            toEmail: email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          })
        },
      }))
      // Phase 7 — Email OTP: expiry, bounded attempts, replay-safe atomic
      // consume + attempt counter, hashed-at-rest, ratelimited plugin defaults.


      plugins.push(emailOTP({
        expiresIn: 10 * 60,
        allowedAttempts: 3,
        storeOTP: "hashed",
        sendVerificationOnSignUp: true,
        overrideDefaultEmailVerification: options.requireEmailVerification === true,
        sendVerificationOTP: async ({ email, otp, type }: { email: string; otp: string; type: "sign-in" | "email-verification" | "forget-password" | "change-email" }) => {
          const rendered = renderAuthEmail({
            publicURL,
            emailKind: "email-otp",
            otp,
            purpose: type === "change-email" ? "sign-in" : type,
          })
          await emailService.send({
            kind: "email-otp",
            toEmail: email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          })
        },
      }))
      // Phase 8 — 2FA: TOTP + backup codes (encrypted at rest by default)
      // + email-OTP second factor; account lockout + rate limits by the plugin
      // (1.7.1 defaults: window:10, max:3 on /two-factor/ paths)..
      // Trusted-device cookie and two-factor verification cookie bounds set..

      plugins.push(twoFactor({
        issuer: options.twoFactor?.issuer ?? "Vaulltcore",
        ...(options.twoFactor?.twoFactorCookieMaxAge ? { twoFactorCookieMaxAge: options.twoFactor.twoFactorCookieMaxAge } : {}),
        ...(options.twoFactor?.trustDeviceMaxAge ? { trustDeviceMaxAge: options.twoFactor.trustDeviceMaxAge } : {}),
        ...(options.twoFactor?.backupCodeAmount ? {
          backupCodeOptions: { amount: options.twoFactor.backupCodeAmount, storeBackupCodes: "encrypted" },
        } : { backupCodeOptions: { storeBackupCodes: "encrypted" } }),
        otpOptions: {
          digits: 6,
          period: 5 * 60,
          sendOTP: async ({ user, otp }: { user: { email: string }; otp: string }) => {
            const rendered = renderAuthEmail({
              publicURL,
              emailKind: "email-otp",
              otp,
              purpose: "sign-in",
              minutes: 5,
            })
            await emailService.send({
              kind: "two-factor-otp",
              toEmail: user.email,
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
            })
          },
        },
      }))
    }
    if (options.google?.clientId && options.google?.clientSecret) {
      plugins.push(socialProviders.google({
        clientId: options.google.clientId,
        clientSecret: options.google.clientSecret,
        ...(options.requireEmailVerification ? { requireEmailVerification: true } : {}),
      }))
    }
    if (options.github?.clientId && options.github?.clientSecret) {
      plugins.push(socialProviders.github({
        clientId: options.github.clientId,
        clientSecret: options.github.clientSecret,
        ...(options.requireEmailVerification ? { requireEmailVerification: true } : {}),
      }))
    }
    if (options.genericOidc?.length) {
      plugins.push(genericOAuth({
        config: options.genericOidc.map((cfg) => ({
          providerId: cfg.providerId,
          name: cfg.name,
          discoveryUrl: cfg.discoveryUrl,
          clientId: cfg.clientId,
          ...(cfg.clientSecret ? { clientSecret: cfg.clientSecret } : {}),
          ...(cfg.scopes?.length ? { scopes: cfg.scopes } : {}),
          requireIdTokenVerification: true,
          requireEmailVerification: cfg.requireEmailVerification === true,
          disableImplicitSignUp: true,
        })),
      }))
    }
    if (plugins.length > 0) { (base.plugins as unknown[]) = plugins }
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
