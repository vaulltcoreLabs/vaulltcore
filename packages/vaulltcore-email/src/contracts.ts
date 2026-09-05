/**
 * Vaulltcore email delivery abstraction (enterprise auth hardening).
 *
 * Authority separation: Better Auth decides WHEN an authentication email is
 * sent (verification, reset, magic link, OTP); the EmailService decides HOW
 * it is transported. Business logic depends on this neutral interface, never
 * on a vendor SDK — the control plane depends on the abstraction, production
 * wires {@link ResendEmailProvider}, dev/test wire a recorder or the explicit
 * dev-only log sink.
 *
 * Security contract:
 * - Resend API key is server-only (never in frontend env vars, never logged).
 * - `AUTH_PUBLIC_URL` (or an explicit callback override) is the ONLY origin
 *   used to build links — never a Host header, never a client-supplied URL.

 * - Templates escape user-controlled fields (no HTML injection) and include a
 *   plain-text fallback for every flow.
 * - There is NO silent fallback from production Resend to a fake provider. A
 *   production-configured instance that cannot reach Resend FAILS LOUDLY. The dev
 *   log sink is available ONLY when explicitly requested (dev mode toggles it).
 * - Emails never contain auth secrets; they contain single-use, expiring
 *   links/codes that Better Auth mints (the email body carries the link/code
 *   only to its intended recipient).
 */

export type AuthEmailKind =
  | "email-verification"
  | "password-reset"
  | "magic-link"
  | "email-otp"
  | "two-factor-otp"
  | "organization-invitation"
  | "security-notification"

export interface AuthEmail {
  readonly to: string
  readonly kind: AuthEmailKind
  /** Human-readable subject (template-driven, no interpolation of raw user input). */
  readonly subject: string
  /** HTML body. User-controlled fields are escaped by the template layer. */
  readonly html: string
  /** Plain-text fallback body. */
  readonly text: string
  /** Optional stable idempotency reference the transport may echo (message id. */
  readonly reference?: string
}

/** Injection point for a concrete transport (Resend, dev sink, SMTP,…). */
export interface EmailProvider {
  readonly id: string
  send(email: Readonly<AuthEmail>): Promise<{ messageId: string }>
}

/** Neutral service surfaces build+send an {@link AuthEmail} through a provider. */
export interface EmailService {
  readonly providerId: string
  send(email: Readonly<AuthEmail>): Promise<{ messageId: string }>
}