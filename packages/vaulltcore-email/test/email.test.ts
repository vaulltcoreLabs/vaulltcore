/**
 * Email service unit tests (enterprise auth hardening).
 * - Templates: deterministic, origin-constrained, HTML-escaped, plain-text fallback.
 * - Resend provider: narrow HttpTransport seam, fails loudly on non-2xx,
 *   never leaks the API key into errors/responses.
 * - Dev sink: explicit-only (throws unless enabled+allowInProduction) and it is
 *   NEVER wired in production (production composition wires Resend only).
 * - No silent fallback exists from production Resend to a fake provider.
 */

import { describe, expect, it } from "vitest"
import {
  DefaultEmailService,
  DevelopmentEmailProvider,
  ResendEmailProvider,
  renderTemplate,
  assertSameOriginLink,
  type AuthEmail,
  type HttpTransport,
} from "../src/index"

const ORIGIN = "https://app.vaulltcore.example"

describe("templates", () => {
  it("renders deterministic branded link email with plain-text fallback (same-origin link)", () => {
    const email = renderTemplate({
      origin: ORIGIN,
      toEmail: "alice@example.com",
      kind: "magic-link",
      href: "/api/auth/magic-link/verify?token=abc",
      action: "Sign in to Vaulltcore",
      cta: "Sign in",
      hint: "This link expires in 10 minutes and works only once.",
    })
    expect(email.html).toContain(ORIGIN + "/api/auth/magic-link/verify?token=abc")
    expect(email.html).toContain("Sign in")
    expect(email.text).toContain(ORIGIN + "/api/auth/magic-link/verify?token=abc")
    expect(email.text).toContain("expires in 10 minutes")
    // No raw secret ever in the template beyond the single-use link itself.
    expect(email.html).not.toContain("password")
  })

  it("escapes user-controlled fields (no HTML injection)", () => {
    const email = renderTemplate({
      origin: ORIGIN,
      toEmail: "bob@example.com",
      kind: "email-verification",
      href: "/verify-email?token=t",
      action: "Verify <script>alert(1)</script>",
      cta: "Verify",
      hint: "hint",
    })
    expect(email.html).not.toContain("<script>")
    expect(email.html).toContain("&lt;script&gt;")
  })

  it("rejects links that are not same-origin with the canonical origin", () => {
    expect((() => renderTemplate({
      origin: ORIGIN,
      toEmail: "c@example.com",
      kind: "password-reset",
      href: "https://evil.example/steal",
      action: "Reset",
      cta: "Reset",
      hint: "hint",
    }))).toThrow(/origin does not match/)
    expect((() => renderTemplate({
      origin: ORIGIN,
      toEmail: "c@example.com",
      kind: "password-reset",
      href: "//evil.example/x",
      action: "Reset",
      cta: "Reset",
      hint: "hint",
    }))).toThrow()
  })

  it("renders OTP template with minutesand purpose", () => {
    const email = renderTemplate({
      origin: ORIGIN,
      toEmail: "d@example.com",
      kind: "email-otp",
      otp: "123456",
      minutes: 5,
      purpose: "sign-in",
    })
    expect(email.text).toContain("123456")
    expect(email.text).toContain("5 minutes")
    expect(email.subject).toContain("Sign in code")
  })
})

describe("ResendEmailProvider", () => {
  function recordingTransport(): { transport: HttpTransport; calls: Array<{ url: string; headers: Record<string, string>; body: string }> } {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const transport: HttpTransport = {
      async post(url, headers, body) {
        calls.push({ url, headers: { ...headers }, body })
        return { status: 200, body: JSON.stringify({ id: "res-123" }) }
      },
    }
    return { transport, calls }
  }

  const email: AuthEmail = {
    to: "alice@example.com",
    kind: "email-verification",
    subject: "[Vaulltcore] Verify your email",
    html: "<b>verify</b>",
    text: "verify",
  }

  it("posts to Resend with the server-only key (never echoed back)", async () => {
    const { transport, calls } = recordingTransport()
    const provider = new ResendEmailProvider({ apiKey: "sk_res_123456789", from: "auth@vaulltcore.example", transport })
    const result = await provider.send(email)
    expect(result.messageId).toBe("res-123")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.authorization).toBe("Bearer sk_res_123456789")
    expect(JSON.parse(calls[0]!.body) as Record<string, unknown>).toMatchObject({
      from: '"Vaulltcore" <auth@vaulltcore.example>',
      to: ["alice@example.com"],
      subject: email.subject,
      html: email.html,
      text: email.text,
    })
    // API key is not part of the payload or the result.
    expect(JSON.stringify(calls[0]!.body)).not.toContain("sk_res")
    expect(JSON.stringify(result)).not.toContain("sk_res")
  })

  it("requires a real server-only key and from address (no insecure default)", () => {
    expect((() => new ResendEmailProvider({ apiKey: "", from: "auth@x.example" }))).toThrow(/RESEND_API_KEY/)
    expect((() => new ResendEmailProvider({ apiKey: "12345678901234", from: "not-an-email" }))).toThrow(/RESEND_FROM_EMAIL/)
  })

  it("fails loudly on provider non-2xx (no silent fallback)", async () => {
    const transport: HttpTransport = { async post() { return { status: 401, body: '{"error":"unauthorized"}' } } }
    const provider = new ResendEmailProvider({ apiKey: "sk_res_123456789", from: "auth@vaulltcore.example", transport })
    await expect(provider.send(email)).rejects.toThrow(/HTTP 401/)
  })
})

describe("DevelopmentEmailProvider", () => {
  it("is disabled by default and cannot be enabled for production (tripwire)", () => {
    expect((() => new DevelopmentEmailProvider())).toThrow(/disabled by default/)
    expect((() => new DevelopmentEmailProvider({ enabled: true }))).toThrow(/never run in production/)
  })

  it("records rendered emails in dev/test only when explicitly allowed", async () => {
    const dev = new DevelopmentEmailProvider({ enabled: true, allowInProduction: true })
    expect(dev.id).toBe("development")
    const rendered = renderTemplate({
      origin: ORIGIN,
      toEmail: "dev@example.com",
      kind: "email-otp",
      otp: "999999",
      minutes: 10,
      purpose: "sign-in",
    })
    const svc = new DefaultEmailService(dev)
    await svc.send(rendered)
    const last = dev.last("email-otp", "dev@example.com")
    expect(last?.html).toContain("999999")
  })
})

describe("origin guard", () => {
  it("assertSameOriginLink accepts only the configured canonical origin", () => {
    expect((() => assertSameOriginLink("https://app.vaulltcore.example/x", ORIGIN))).not.toThrow()
    expect((() => assertSameOriginLink("https://evil.example/x", ORIGIN))).toThrow()
    expect((() => assertSameOriginLink("http://app.vaulltcore.example/x", ORIGIN))).toThrow()
  })
})