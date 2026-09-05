/**
 * Deterministic, branded email templates. Every template:
 * - escapes user-controlled fields (no HTML injection, no log-injection)
 * - uses the configured canonical origin for all links(never a Host header/caller URL)
 * - includes a plain-text fallback
 * - never embeds secrets (only single-use expiring links/codes minted by Better Auth)
 */

import type { AuthEmail, AuthEmailKind } from "./contracts"
import { assertSameOriginLink, escapeHtml } from "./escape"

export interface TemplateContext {
  /** Canonical public origin, e.g. "https://app.example.com". All links derive from it. */
  readonly origin: string
  /** Brand suffix, e.g. "Vaulltcore". */
  readonly appName?: string
  readonly toEmail: string
}

export interface LinkTemplateDetails extends TemplateContext {
  readonly kind: Exclude<AuthEmailKind, "email-otp">
  /** Relative or same-origin path (e.g. "/verify-email?token=..."). Validated at render time. */
  readonly href: string
  /** One-line explanation of what the user should do. */
  readonly action: string
  /** Short text identifier (button label, subject tag). */
  readonly cta: string
  /** Security hint line (never contains the secret). */
  readonly hint: string
}

export interface OtpTemplateDetails extends TemplateContext {
  readonly kind: "email-otp"
  readonly otp: string
  readonly minutes: number
  readonly purpose: "sign-in" | "email-verification" | "forget-password" | "change-email"
}

export type TemplateEmail = LinkTemplateDetails | OtpTemplateDetails

function brand(appName: string | undefined): string { return appName ?? "Vaulltcore" }

function renderLayout(appName: string, bodyHtml: string): string {
  const app = brand(appName)
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#0b1120;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto">
    <tr><td style="padding:16px 0">
      <span style="font-size:18px;font-weight:700;color:#f8fafc">🔐 ${app}</span>
    </td></tr>
    <tr><td style="background:#ffffff;border-radius:12px;padding:24px;color:#0f172a;line-height:1.5">
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:16px 0;font-size:12px;color:#94a3b8;line-height:1.5">
      This email was sent by ${app} — a B2B AI engineering automation platform.<br />
      If you did not request this email, you can safely ignore it.<br />
      Sensitive links expire and work only once.
    </td></tr>
  </table></body></html>`
}

function linkBody(d: Readonly<LinkTemplateDetails>): { subject: string; html: string; text: string } {
  const app = brand(d.appName)

  const url = new URL(d.href, d.origin).toString()
  assertSameOriginLink(url, d.origin)


  const button = `<a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#ffffff;border-radius:8px;padding:10px 18px;font-weight:600;text-decoration:none">${escapeHtml(d.cta)}</a>`
  const html = renderLayout(app, `
    <p style="margin:0 0 12px;font-size:16px;font-weight:600">${escapeHtml(d.action)}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#475569">Click the button below to continue. This link is single-use and expires soon.</p>
    <p style="margin:0 0 20px;text-align:center">${button}</p>
    <p style="margin:0 0 8px;font-size:12px;color:#64748b">Or copy this link: <code style="word-break:break-all">${escapeHtml(url)}</code></p>
    <p style="margin:0;font-size:12px;color:#94a3b8">${escapeHtml(d.hint)}</p>
  `)
  const text = [
    `${d.action}`,
    ``,
    `To continue, open this link (single-use, expires soon):`,
    `${url} (${d.cta})`,
    ``,
    `${d.hint}`,
  ].join("\n")
  return { subject: `[${app}] ${d.cta}`, html, text }
}

function otpBody(d: Readonly<OtpTemplateDetails>): { subject: string; html: string; text: string } {
  const app = brand(d.appName)
  const purposeLabel = { "sign-in": "sign in", "email-verification": "verify your email", "forget-password": "reset your password", "change-email": "confirm your email change" }[d.purpose] ?? "authenticate"
  const html = renderLayout(app, `
    <p style="margin:0 0 12px;font-size:16px;font-weight:600">Your one-time code for ${purposeLabel}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#475569">Enter this code within the next ${d.minutes} minutes. It can be used only once.</p>
    <p style="margin:0 0 20px;text-align:center;font-size:28px;letter-spacing:6px;font-weight:700;color:#0f172a">${escapeHtml(d.otp)}</p>
    <p style="margin:0;font-size:12px;color:#94a3b8">If you did not request this code, ignore this email and do not share it.</p>
  `)
  const text = [
    `Your one-time code for ${purposeLabel}`,
    ``,
    `${d.otp}`,
    ``,
    `Enter this code within the next ${d.minutes} minutes. It can be used only once.`,
    `If you did not request this code, ignore this email and do not share it.`,
  ].join("\n")
  return { subject: `[${app}] ${purposeLabel.charAt(0).toUpperCase()}${purposeLabel.slice(1)} code`, html, text }
}

/** Build a branded {@link AuthEmail} from deterministic templates. */
export function renderTemplate(email: TemplateEmail): AuthEmail {
  if (email.kind === "email-otp") {
    const rendered = otpBody(email)
    return { to: email.toEmail, kind: email.kind, subject: rendered.subject, html: rendered.html, text: rendered.text }
  }
  const rendered = linkBody(email)
  return { to: email.toEmail, kind: email.kind, subject: rendered.subject, html: rendered.html, text: rendered.text }
}