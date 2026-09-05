/**
 * Concrete email providers.
 *
 * {@link ResendEmailProvider} is the production transport. It talks to
 * Resend's HTTP API over a narrow, injectable {@link HttpTransport} seam
 * (fetch-shaped) — no vendor SDK becomes a core dependency, matching the
 * pattern used elsewhere in Vaulltcore (SSRF-guarded HTTP seams only).
 *
 * {@link DevelopmentEmailProvider} is a DEV-ONLY sink: it logs body and
 * metadata to stdout (no secrets; the email is deterministic templates only
 * carrying single-use links/codes) and records the rendered output for tests.
 * It must NEVER be wired in production: construction fails if
 * `allowInProduction` is not explicitly true, and production composition
 * (`serve.ts`) wires Resend, never this sink.
 There is deliberately NO
 * silent fallback from production Resend to a fake provider.

 * The Resend API key is server-only and never appears in logs/errors/responses.

 */

import type { AuthEmail, EmailProvider } from "./contracts"

export interface HttpTransport {
  post(url: string, headers: Readonly<Record<string, string>>, body: string): Promise<{ status: number; body: string }>
}

/** Node fetch-shaped seam (injectable for tests/replay; no SDK dependency). */
export const nodeHttpTransport: HttpTransport = {
  async post(url, headers, body) {
    const res = await fetch(url, { method: "POST", headers, body })
    return { status: res.status, body: await res.text() }
  },
}

export interface ResendEmailProviderOptions {
  /** Server-only Resend API key. Never logged, returned, or sent to the browser. */
  readonly apiKey: string
  readonly from: string
  /** Optional explicit from-name to be embedded by Resend's "from" encoding. */
  readonly fromName?: string
  /** Injectable transport (defaults to Node fetch). */
  readonly transport?: HttpTransport
  readonly appName?: string
}

/** Production Resend transport. Fails loudly on any non-2xx (no silent fallback). */
export class ResendEmailProvider implements EmailProvider {
  readonly id = "resend"
  private readonly apiKey: string
  private readonly from: string
  private readonly fromName: string
  private readonly transport: HttpTransport
  constructor(options: ResendEmailProviderOptions) {
    if (!options.apiKey || options.apiKey.length < 8) throw new Error("ResendEmailProvider requires a server-only RESEND_API_KEY (no insecure default)")
    if (!options.from || !options.from.includes("@")) throw new Error("ResendEmailProvider requires a valid RESEND_FROM_EMAIL")
    this.apiKey = options.apiKey
    this.from = options.from
    this.fromName = options.fromName ?? "Vaulltcore"
    this.transport = options.transport ?? nodeHttpTransport
  }

  async send(email: Readonly<AuthEmail>): Promise<{ messageId: string }> {
    const fromName = (this.fromName ?? "Vaulltcore").replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 64)
    const payload = {
      from: `"${fromName}" <${this.from}>`,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }
    const res = await this.transport.post(
      "https://api.resend.com/emails",
      { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      JSON.stringify(payload),
    )
    if (res.status < 200 || res.status >= 300) {
      // Never place the API key or raw payload in the error. The body may echo
      // provider-side messages; sanitized to status text only.
      throw new Error(`Resend email delivery failed (HTTP ${res.status}))`)
    }
    let messageId = `resend-${res.status}`
    try {
      const parsed = JSON.parse(res.body) as { id?: string }
      if (typeof parsed?.id === "string" && parsed.id) messageId = parsed.id
    } catch {
      // Non-JSON success body; deterministic fallback reference. Response body
      // is not echoed anywhere (may contain provider internals).
    }
    return { messageId }
  }
}

export interface DevelopmentEmailProviderOptions {
  readonly enabled: boolean
  /** Dev/test-only sink. Fails unless explicitly enabled in non-production mindset. */
  readonly allowInProduction?: boolean
  readonly appName?: string
}

/**
 * DEV-ONLY email sink. Logs deterministic metadata and records rendered output
 * for tests/loops. Never wire in production: construction throws unless
 * `allowInProduction === true` (a deployment misconfiguration tripwire..
 */
export class DevelopmentEmailProvider implements EmailProvider {
  readonly id = "development"
  readonly sent: AuthEmail[] = []
  private readonly appName: string
  constructor(options: Partial<DevelopmentEmailProviderOptions> = {}) {
    if (!options.enabled) throw new Error("DevelopmentEmailProvider is disabled by default; enable explicitly for dev/test")
    if (options.allowInProduction !== true) {
      throw new Error("DevelopmentEmailProvider must never run in production; pass allowInProduction:true only in dev/test configurations")
    }
    this.appName = options.appName ?? "Vaulltcore"
  }

  async send(email: Readonly<AuthEmail>): Promise<{ messageId: string }> {
    this.sent.push({ ...email })
    // Surface content for local dev and test verification;no secrets (single-use
    // links/codes are intended recipients).
    console.log(`[dev-email:${email.kind}] to=${email.to} subject=${email.subject}`)
    return { messageId: `dev-${this.sent.length}` }
  }

  /** Latest rendered email for a recipient+kind (test/loop assistance). */
  last(kind: AuthEmail["kind"], to?: string): AuthEmail | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const e = this.sent[i]!
      if (e.kind === kind && (!to || e.to === to)) return e
    }
    return undefined
  }
}