/**
 * Production delivery providers (Phase 2B).
 *
 * Implements three providers behind the neutral {@link ProductionDeliveryProvider}
 * seam:
 * - {@link WebhookDeliveryProvider}: generic HTTP webhook (POST). SSRF-guarded,
 *   no untrusted-redirect following, credential redaction, idempotent on key.
 * - {@link EmailDeliveryProvider}: an email abstraction over an injectable SMTP
 *   seam (no SMTP client is a core dependency; production wires one). Real SMTP
 *   tests are env-gated.
 * - {@link SlackDeliveryProvider}: a practical B2B notification provider over
 *   Slack incoming webhooks (SSRF-guarded, secret redacted in logs).
 *
 * Every provider is idempotent on `idempotencyKey`: a replay returns the
 * original result without re-invoking the external side effect (the provider
 * memoizes settled keys). Execution stays at-least-once; settlement is exactly-
 * once at the delivery identity boundary.
 */

import { request, type RequestOptions } from "node:http"
import { request as requestHttps } from "node:https"
import { createHash } from "node:crypto"
import type { AutomationArtifact } from "@vaulltcore/automation"
import {
  type DeliveryOutcomeClassifier,
  type DeliveryResponse,
  type ProductionDeliverArgs,
  type ProductionDeliverResult,
  type ProductionDeliveryProvider,
  DeliveryError,
  redactUrl,
  sanitizeResponseHeaders,
} from "./contracts"
import { SsrfGuard } from "./ssrf"
import { defaultClassifier } from "./retry"

const encoder = new TextEncoder()

function requestFingerprint(args: { readonly method: string; readonly url: string; readonly body: Uint8Array; readonly artifactChecksums: readonly string[] }): string {
  return createHash("sha256")
    .update(`${args.method}\n${args.url}\n${Array.from(args.body).join(",")}\n${args.artifactChecksums.join(",")}`)
    .digest("hex")
}

function artifactsToPayload(artifacts: readonly AutomationArtifact[], contents: ReadonlyMap<string, Uint8Array>): string {
  // A compact, deterministic JSON envelope carrying artifact name + checksum +
  // base64 content. Providers may use a richer format; this is the default.
  const items = artifacts.map((a) => ({
    artifactId: a.artifactId,
    name: a.name,
    type: a.type,
    checksum: a.checksum,
    content: Buffer.from(contents.get(a.artifactId) ?? new Uint8Array()).toString("base64"),
  }))
  return JSON.stringify({ artifacts: items })
}

function httpResponseFromNode(status: number, headers: Record<string, string | string[] | undefined>, body: Buffer): DeliveryResponse {
  const flat: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue
    flat[k] = Array.isArray(v) ? v.join(", ") : v
  }
  return {
    status,
    statusText: null,
    headers: sanitizeResponseHeaders(flat),
    body: body.toString("utf8").slice(0, 4096),
  }
}

function doHttp(parsed: { protocol: string; hostname: string; port: number | null }, opts: RequestOptions, body: Uint8Array, timeoutMs: number): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const base: RequestOptions = { method: opts.method, hostname: parsed.hostname, port: parsed.port ?? undefined, path: opts.path, headers: opts.headers, timeout: timeoutMs }
    const req = parsed.protocol === "https:" ? requestHttps(base) : request(base)
    req.on("timeout", () => { req.destroy(new Error("timeout")) })
    req.on("error", reject)
    req.on("response", (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    if (body.length > 0) req.write(Buffer.from(body))
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Generic HTTP webhook
// ---------------------------------------------------------------------------

export interface WebhookDeliveryProviderOptions {
  readonly ssrf?: SsrfGuard
  /** Max redirects (default 0 — do NOT follow untrusted redirects by default). */
  readonly maxRedirects?: number
  readonly timeoutMs?: number
  readonly classifier?: DeliveryOutcomeClassifier
  /** Injectable transport (tests). */
  readonly transport?: (parsed: { protocol: string; hostname: string; port: number | null }, opts: RequestOptions, body: Uint8Array, timeoutMs: number) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>
}

export class WebhookDeliveryProvider implements ProductionDeliveryProvider {
  readonly id = "webhook"
  private readonly ssrf: SsrfGuard
  private readonly maxRedirects: number
  private readonly timeoutMs: number
  private readonly classifier: DeliveryOutcomeClassifier
  private readonly transport: NonNullable<WebhookDeliveryProviderOptions["transport"]>
  private readonly settled = new Map<string, ProductionDeliverResult>()
  readonly attemptLog: Array<{ idempotencyKey: string; status: number }> = []

  constructor(options: WebhookDeliveryProviderOptions = {}) {
    this.ssrf = options.ssrf ?? new SsrfGuard({ allowHttp: false, allowPrivate: false })
    this.maxRedirects = options.maxRedirects ?? 0
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.classifier = options.classifier ?? defaultClassifier
    this.transport = options.transport ?? doHttp
  }

  async deliver(args: ProductionDeliverArgs): Promise<ProductionDeliverResult> {
    const existing = this.settled.get(args.idempotencyKey)
    if (existing) return existing
    // The destination IS the webhook URL. SSRF-check it before any request.
    const checked = await this.ssrf.check(args.destination)
    const body = encoder.encode(artifactsToPayload(args.artifacts, args.contents))
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(body.byteLength),
      "x-vc-idempotency-key": args.idempotencyKey,
      ...(args.headers ?? {}),
    }
    const checkedUrl = new URL(checked.url)
    const parsed = { protocol: checkedUrl.protocol, hostname: checkedUrl.hostname, port: Number(checkedUrl.port) || null }
    let res: { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
    let currentUrl = checked.url
    try {
      res = await this.transport(parsed, { method: "POST", path: checkedUrl.pathname + checkedUrl.search, headers }, body, this.timeoutMs)
      let hops = 0
      // Redirect handling: only follow to SSRF-cleared destinations, bounded.
      while (this.maxRedirects > 0 && hops < this.maxRedirects && res.status >= 300 && res.status < 400) {
        const loc = res.headers.location
        const location = Array.isArray(loc) ? loc[0] : loc
        if (!location) break
        const next = await this.ssrf.checkRedirect(location, currentUrl)
        currentUrl = next.url
        const np = new URL(next.url)
        res = await this.transport({ protocol: np.protocol, hostname: np.hostname, port: Number(np.port) || null }, { method: "POST", path: np.pathname + np.search, headers }, body, this.timeoutMs)
        hops++
      }
    } catch (error) {
      // Uncertain outcome: we cannot prove the request failed before side
      // effects. Classify and throw a DeliveryError carrying the retry class.
      const cls = this.classifier(error, null)
      throw new DeliveryError("WEBHOOK_ERROR", `Webhook delivery error: ${error instanceof Error ? error.message : "unknown"} to ${redactUrl(currentUrl)}`, cls, 502)
    }
    const response = httpResponseFromNode(res.status, res.headers, res.body)
    this.attemptLog.push({ idempotencyKey: args.idempotencyKey, status: res.status })
    if (res.status >= 200 && res.status < 300) {
      const result: ProductionDeliverResult = { delivered: true, resultRef: `webhook:${redactUrl(currentUrl)}#${requestFingerprint({ method: "POST", url: currentUrl, body, artifactChecksums: args.artifacts.map((a) => a.checksum) })}`, response, retryClass: "transient" }
      this.settled.set(args.idempotencyKey, result)
      return result
    }
    const cls = this.classifier(new Error(`webhook status ${res.status}`), response)
    throw new DeliveryError("WEBHOOK_FAILED", `Webhook delivery failed with status ${res.status} to ${redactUrl(currentUrl)}`, cls, res.status >= 500 ? 502 : 422)
  }
}

// ---------------------------------------------------------------------------
// Email delivery abstraction
// ---------------------------------------------------------------------------

/** Neutral SMTP seam. Production wires a real client; tests wire a recorder. */
export interface SmtpTransport {
  send(args: {
    readonly from: string
    readonly to: string
    readonly subject: string
    readonly body: string
    readonly headers?: Readonly<Record<string, string>>
  }): Promise<{ messageId: string }>
}

export interface EmailDeliveryProviderOptions {
  readonly from: string
  readonly transport: SmtpTransport
  /** Build a subject from the run id. */
  readonly subject?: (runId: string) => string
  readonly classifier?: DeliveryOutcomeClassifier
}

export class EmailDeliveryProvider implements ProductionDeliveryProvider {
  readonly id = "email"
  private readonly from: string
  private readonly transport: SmtpTransport
  private readonly subjectFn: (runId: string) => string
  private readonly classifier: DeliveryOutcomeClassifier
  private readonly settled = new Map<string, ProductionDeliverResult>()
  readonly sentLog: string[] = []

  constructor(options: EmailDeliveryProviderOptions) {
    this.from = options.from
    this.transport = options.transport
    this.subjectFn = options.subject ?? ((runId) => `Vaulltcore automation result: ${runId}`)
    this.classifier = options.classifier ?? defaultClassifier
  }

  async deliver(args: ProductionDeliverArgs): Promise<ProductionDeliverResult> {
    const existing = this.settled.get(args.idempotencyKey)
    if (existing) return existing
    // The destination is an email address; validate shape (no URL/SSRF surface).
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.destination)) {
      throw new DeliveryError("EMAIL_INVALID", `Invalid email destination`, "permanent_validation", 422)
    }
    const body = artifactsToPayload(args.artifacts, args.contents)
    try {
      const result = await this.transport.send({ from: this.from, to: args.destination, subject: this.subjectFn(args.runId), body, headers: { "x-vc-idempotency-key": args.idempotencyKey } })
      const response: DeliveryResponse = { status: 250, statusText: "OK", headers: { "message-id": result.messageId }, body: null }
      const out: ProductionDeliverResult = { delivered: true, resultRef: `email:${result.messageId}`, response, retryClass: "transient" }
      this.settled.set(args.idempotencyKey, out)
      this.sentLog.push(args.idempotencyKey)
      return out
    } catch (error) {
      const cls = this.classifier(error, null)
      throw new DeliveryError("EMAIL_FAILED", `Email delivery failed: ${error instanceof Error ? error.message : "unknown"}`, cls, 502)
    }
  }
}

// ---------------------------------------------------------------------------
// Slack (B2B notification) via incoming webhook
// ---------------------------------------------------------------------------

export interface SlackDeliveryProviderOptions {
  /** Slack incoming webhook URL. */
  readonly webhookUrl: string
  readonly ssrf?: SsrfGuard
  readonly timeoutMs?: number
  readonly classifier?: DeliveryOutcomeClassifier
  readonly transport?: WebhookDeliveryProviderOptions["transport"]
}

export class SlackDeliveryProvider implements ProductionDeliveryProvider {
  readonly id = "slack"
  private readonly webhookUrl: string
  private readonly webhook: WebhookDeliveryProvider

  constructor(options: SlackDeliveryProviderOptions) {
    this.webhookUrl = options.webhookUrl
    this.webhook = new WebhookDeliveryProvider({
      ssrf: options.ssrf ?? new SsrfGuard({ allowHttp: false, allowPrivate: false }),
      timeoutMs: options.timeoutMs ?? 15_000,
      classifier: options.classifier,
      transport: options.transport,
    })
  }

  async deliver(args: ProductionDeliverArgs): Promise<ProductionDeliverResult> {
    // Wrap artifacts into a Slack message payload. The webhook URL is the
    // destination; we override the destination with the configured webhook URL
    // (tenant cannot choose an arbitrary Slack endpoint — the secret-bearing
    // URL is configured, not caller-supplied). This prevents cross-tenant
    // destination reuse: each tenant's provider has its own configured URL.
    const text = args.artifacts.map((a) => `• *${a.name}* (sha256:${a.checksum.slice(0, 12)})`).join("\n") || "Automation completed."
    const payload = encoder.encode(JSON.stringify({ text }))
    const wrappedContents = new Map<string, Uint8Array>([["slack", payload]])
    const wrappedArtifacts: AutomationArtifact[] = [{ artifactId: "slack", runId: args.runId, versionId: "", stepId: null, type: "slack-message", name: "message", contentRef: "", checksum: "", size: null, createdAt: Date.now(), metadata: {} }]
    return this.webhook.deliver({ ...args, destination: this.webhookUrl, artifacts: wrappedArtifacts, contents: wrappedContents })
  }
}
