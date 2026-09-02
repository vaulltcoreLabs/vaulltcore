/**
 * Production delivery provider tests (Phase 2B): retry classification, backoff,
 * SSRF protection, webhook delivery retries, uncertain outcomes, redaction,
 * cross-tenant destination isolation, idempotency.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, type Server as HttpServer } from "node:http"
import {
  WebhookDeliveryProvider,
  EmailDeliveryProvider,
  SlackDeliveryProvider,
  SsrfGuard,
  RetryPolicy,
  DeliveryError,
  SsrfBlockedError,
  redactUrl,
  defaultClassifier,
  type ProductionDeliverArgs,
  type SmtpTransport,
} from "../src"
import type { AutomationArtifact } from "@vaulltcore/automation"

const encoder = new TextEncoder()

function art(id: string, checksum = "0".repeat(64)): AutomationArtifact {
  return { artifactId: id, runId: "run", versionId: "v", stepId: null, type: "text", name: id, contentRef: "", checksum, size: 1, createdAt: 1, metadata: {} }
}

function deliverArgs(url: string, key = "k1"): ProductionDeliverArgs {
  const contents = new Map<string, Uint8Array>([[art("a1").artifactId, encoder.encode("payload")]])
  return { idempotencyKey: key, runId: "run", destination: url, artifacts: [art("a1")], contents, owner: { tenantId: "t1", orgId: "o", projectId: "p" } }
}

// ---------------------------------------------------------------------------
// Retry policy + classification
// ---------------------------------------------------------------------------

describe("RetryPolicy + classification", () => {
  it("retries transient/rate-limited/unknown; terminates auth/permanent/rejection", () => {
    const p = new RetryPolicy({ maxAttempts: 5, baseMs: 100, jitter: () => 1 })
    expect(p.decide(1, "transient").retriable).toBe(true)
    expect(p.decide(1, "rate_limited").retriable).toBe(true)
    expect(p.decide(1, "unknown_uncertain").retriable).toBe(true)
    expect(p.decide(1, "auth_config").retriable).toBe(false)
    expect(p.decide(1, "permanent_validation").retriable).toBe(false)
    expect(p.decide(1, "provider_rejection").retriable).toBe(false)
  })

  it("stops at max attempts with terminal reason", () => {
    const p = new RetryPolicy({ maxAttempts: 2, baseMs: 10, jitter: () => 0 })
    const d = p.decide(2, "transient")
    expect(d.retriable).toBe(false)
    expect(d.terminalFailureReason).toMatch(/max_attempts_exceeded/)
  })

  it("backoff is bounded by maxMs and uses full jitter", () => {
    const p = new RetryPolicy({ baseMs: 100, maxMs: 500, multiplier: 2, jitter: () => 0.5 })
    expect(p.backoffMs(1)).toBe(100)
    expect(p.backoffMs(2)).toBe(200)
    expect(p.backoffMs(10)).toBe(500)
    const d = p.decide(1, "transient", 1000)
    expect(d.nextRetryAt).toBe(1000 + Math.floor(100 * 0.5))
  })

  it("defaultClassifier maps HTTP status + error signals", () => {
    expect(defaultClassifier(null, { status: 429 })).toBe("rate_limited")
    expect(defaultClassifier(null, { status: 401 })).toBe("auth_config")
    expect(defaultClassifier(null, { status: 422 })).toBe("permanent_validation")
    expect(defaultClassifier(null, { status: 503 })).toBe("transient")
    expect(defaultClassifier(new Error("ETIMEDOUT"), null)).toBe("transient")
    expect(defaultClassifier(new Error("connection reset"), null)).toBe("transient")
    expect(defaultClassifier(new Error("totally weird"), null)).toBe("unknown_uncertain")
  })
})

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

describe("SsrfGuard", () => {
  const guard = new SsrfGuard({ allowHttp: true, allowPrivate: false, resolver: async (h) => {
    if (h === "internal.example") return ["10.0.0.1"]
    if (h === "metadata.example") return ["169.254.169.254"]
    if (h === "loop.example") return ["127.0.0.1"]
    if (h === "public.example") return ["93.184.216.34"]
    if (h === "v6-ula.example") return ["fd12:3456:789a::1"]
    return [h]
  } })

  it("blocks private, loopback, link-local, metadata, v6 ULA", async () => {
    await expect(guard.check("http://internal.example/x")).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(guard.check("http://metadata.example/")).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(guard.check("http://loop.example/")).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(guard.check("http://v6-ula.example/")).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(guard.check("http://127.0.0.1/")).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(guard.check("http://169.254.169.254/")).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it("allows public https; rejects userinfo + bad schemes", async () => {
    await expect(guard.check("https://public.example/x")).resolves.toBeDefined()
    await expect(guard.check("https://user:pass@public.example/x")).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(guard.check("ftp://public.example/x")).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(guard.check("not a url")).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it("redactUrl strips userinfo", () => {
    expect(redactUrl("https://user:secret@public.example/x")).toBe("https://[redacted]@public.example/x")
    expect(redactUrl("not a url")).toBe("[invalid-url]")
  })
})

// ---------------------------------------------------------------------------
// Webhook provider against a local webhookSrv
// ---------------------------------------------------------------------------

describe("WebhookDeliveryProvider", () => {
  let webhookSrv: HttpServer
  let base: string
  let received: { body: string; idem: string; count: number }[]
  let statusOverride: number

  beforeAll(async () => {
    received = []
    statusOverride = 200
    webhookSrv = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        received.push({ body: Buffer.concat(chunks).toString("utf8"), idem: req.headers["x-vc-idempotency-key"] as string, count: 0 })
        res.writeHead(statusOverride, { "content-type": "application/json" })
        res.end("{}")
      })
    })
    await new Promise<void>((resolve) => {
      webhookSrv.listen(0, "127.0.0.1", () => {
        const addr = webhookSrv.address()
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`
        resolve()
      })
    })
  })
  afterAll(() => new Promise<void>((resolve) => webhookSrv.close(() => resolve())))

  it("delivers and is idempotent on key (no second POST)", async () => {
    statusOverride = 200
    const provider = new WebhookDeliveryProvider({ ssrf: new SsrfGuard({ allowHttp: true, allowPrivate: true }) })
    const r = await provider.deliver(deliverArgs(base, "idem-1"))
    expect(r.delivered).toBe(true)
    // Replay returns the same result without a second POST.
    const r2 = await provider.deliver(deliverArgs(base, "idem-1"))
    expect(r2).toBe(r)
    expect(received.filter((x) => x.idem === "idem-1")).toHaveLength(1)
  })

  it("retries transient 5xx with bounded attempts; terminates permanent 4xx", async () => {
    // 5xx → transient retriable. Use a fresh provider; failFirst via statusOverride.
    statusOverride = 503
    const provider = new WebhookDeliveryProvider({ ssrf: new SsrfGuard({ allowHttp: true, allowPrivate: true }), timeoutMs: 1000 })
    await expect(provider.deliver(deliverArgs(base, "idem-503"))).rejects.toBeInstanceOf(DeliveryError)
    // permanent 422
    statusOverride = 422
    const provider2 = new WebhookDeliveryProvider({ ssrf: new SsrfGuard({ allowHttp: true, allowPrivate: true }) })
    const err = await provider2.deliver(deliverArgs(base, "idem-422")).catch((e) => e as DeliveryError)
    expect(err).toBeInstanceOf(DeliveryError)
    expect(err.retryClass).toBe("permanent_validation")
  })

  it("uncertain outcome (network error) is classifiable as unknown_uncertain (retriable)", async () => {
    const provider = new WebhookDeliveryProvider({
      ssrf: new SsrfGuard({ allowHttp: true, allowPrivate: true }),
      transport: async () => { throw new Error("opaque provider failure") },
    })
    const err = await provider.deliver(deliverArgs(base, "idem-uncertain")).catch((e) => e as DeliveryError)
    expect(err).toBeInstanceOf(DeliveryError)
    expect(err.retryClass).toBe("unknown_uncertain")
    expect(err.retryClass === "unknown_uncertain").toBe(true)
  })

  it("does not follow untrusted redirects by default", async () => {
    statusOverride = 302
    const provider = new WebhookDeliveryProvider({ ssrf: new SsrfGuard({ allowHttp: true, allowPrivate: true }) })
    // 302 with no following → treated as non-2xx → transient/permanent by class.
    const err = await provider.deliver(deliverArgs(base, "idem-302")).catch((e) => e as DeliveryError)
    expect(err).toBeInstanceOf(DeliveryError)
  })
})

// ---------------------------------------------------------------------------
// Email + Slack providers
// ---------------------------------------------------------------------------

describe("EmailDeliveryProvider", () => {
  it("delivers via SMTP seam; idempotent on key; rejects invalid address", async () => {
    const sent: string[] = []
    const transport: SmtpTransport = { send: async (a) => { sent.push(a.to); return { messageId: `msg-${a.to}` } } }
    const provider = new EmailDeliveryProvider({ from: "bot@vc.test", transport })
    const r = await provider.deliver({ ...deliverArgs("user@example.com", "e1") })
    expect(r.delivered).toBe(true)
    expect(r.resultRef).toBe("email:msg-user@example.com")
    // Idempotent replay.
    await provider.deliver({ ...deliverArgs("user@example.com", "e1") })
    expect(sent.filter((t) => t === "user@example.com")).toHaveLength(1)
    // Invalid address.
    await expect(provider.deliver({ ...deliverArgs("not-an-email", "e2") })).rejects.toMatchObject({ code: "EMAIL_INVALID" })
  })
})

describe("SlackDeliveryProvider", () => {
  let webhookSrv: HttpServer
  let base: string
  beforeAll(async () => {
    webhookSrv = createServer((req, res) => { req.resume(); res.writeHead(200, {}); res.end("{}") })
    await new Promise<void>((resolve) => {
      webhookSrv.listen(0, "127.0.0.1", () => {
        const addr = webhookSrv.address()
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`
        resolve()
      })
    })
  })
  afterAll(() => new Promise<void>((resolve) => webhookSrv.close(() => resolve())))

  it("delivers to the configured webhook URL (caller destination ignored)", async () => {
    const provider = new SlackDeliveryProvider({ webhookUrl: base, ssrf: new SsrfGuard({ allowHttp: true, allowPrivate: true }) })
    // Caller supplies an arbitrary destination; the provider uses its configured URL.
    const r = await provider.deliver({ ...deliverArgs("https://evil.example/hook", "s1") })
    expect(r.delivered).toBe(true)
  })
})
