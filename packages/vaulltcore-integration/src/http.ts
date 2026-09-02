/**
 * Provider-neutral HTTP seam (Phase 2C).
 *
 * A thin, SSRF-guarded HTTP client that git/connector/model adapters reuse
 * so no provider SDK becomes a core dependency and so every outbound call is
 * SSRF-checked + credential-redacted. Mirrors the Phase 2B delivery HTTP
 * transport but is shaped for adapter read/mutation calls (GET/POST/PATCH/PUT,
 * JSON bodies, sanitized responses, classified errors).
 *
 * Security: destinations are SSRF-checked (no loopback/private/metadata),
 * credentials are never placed in logs/audit/errors, response headers are
 * sanitized, redirects are not followed to internal addresses. The usable
 * secret crosses the resolver boundary only and is placed in an
 * Authorization header transiently for one request.
 */

import { request as requestHttp, request as requestHttps, type RequestOptions } from "node:http"
import { SsrfGuard, sanitizeResponseHeaders, defaultClassifier, type RetryClass } from "@vaulltcore/delivery"
import { IntegrationError } from "./contracts"

export interface ProviderHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** Sanitized, truncated body for adapter parsing/diagnostics. */
  readonly body: string
}

export interface ProviderHttpOptions {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  /** Transient auth header value (e.g. `Bearer <secret>`); never logged. */
  readonly authHeader?: string
  readonly timeoutMs?: number
}

export interface ProviderHttpTransportOptions {
  readonly ssrf?: SsrfGuard
  readonly allowHttp?: boolean
  readonly allowPrivate?: boolean
  readonly timeoutMs?: number
  /** Injectable transport (tests / fake providers). */
  readonly transport?: (parsed: { protocol: string; hostname: string; port: number | null }, opts: RequestOptions, body: Uint8Array, timeoutMs: number) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>
}

function doHttp(parsed: { protocol: string; hostname: string; port: number | null }, opts: RequestOptions, body: Uint8Array, timeoutMs: number): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const base: RequestOptions = { method: opts.method, hostname: parsed.hostname, port: parsed.port ?? undefined, path: opts.path, headers: opts.headers, timeout: timeoutMs }
    const req = parsed.protocol === "https:" ? requestHttps(base) : requestHttp(base)
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

/** A reusable SSRF-guarded HTTP client for adapters. */
export class ProviderHttpClient {
  private readonly ssrf: SsrfGuard
  private readonly timeoutMs: number
  private readonly transport: NonNullable<ProviderHttpTransportOptions["transport"]>

  constructor(options: ProviderHttpTransportOptions = {}) {
    this.ssrf = options.ssrf ?? new SsrfGuard({ allowHttp: options.allowHttp ?? false, allowPrivate: options.allowPrivate ?? false })
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.transport = options.transport ?? doHttp
  }

  async request(options: ProviderHttpOptions): Promise<ProviderHttpResponse> {
    let checkedUrl: string
    try {
      const checked = await this.ssrf.check(options.url)
      checkedUrl = checked.url
    } catch (error) {
      // SSRF block (or any guard error) is a permanent provider request error;
      // never include the destination or secret in the message.
      throw new IntegrationError("PROVIDER_HTTP_ERROR", "provider request destination rejected", "permanent_validation", 422)
    }
    const url = new URL(checkedUrl)
    const bodyStr = options.body !== undefined ? JSON.stringify(options.body) : ""
    const body = Buffer.from(bodyStr, "utf8")
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.body !== undefined ? { "content-type": "application/json", "content-length": String(body.byteLength) } : {}),
      ...(options.headers ?? {}),
    }
    // Transient auth header; never logged. Not included in thrown errors.
    if (options.authHeader) headers.authorization = options.authHeader
    const parsed = { protocol: url.protocol, hostname: url.hostname, port: Number(url.port) || null }
    let res: { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
    try {
      res = await this.transport(parsed, { method: options.method, path: url.pathname + url.search, headers }, body, options.timeoutMs ?? this.timeoutMs)
    } catch (error) {
      const cls: RetryClass = defaultClassifier(error, null)
      throw new IntegrationError("PROVIDER_HTTP_ERROR", "provider request error", cls, 502)
    }
    const flat: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue
      flat[k] = Array.isArray(v) ? v.join(", ") : v
    }
    return {
      status: res.status,
      headers: sanitizeResponseHeaders(flat),
      body: res.body.toString("utf8").slice(0, 65536),
    }
  }
}

/** Classify an HTTP response into a retry class + IntegrationError. */
export function classifyResponse(status: number, message: string): IntegrationError {
  const cls: RetryClass = defaultClassifier(new Error(`status ${status}`), { status })
  const code = status === 401 ? "PROVIDER_UNAUTHORIZED" : status === 403 ? "PROVIDER_FORBIDDEN" : status === 404 ? "PROVIDER_NOT_FOUND" : status === 429 ? "PROVIDER_RATE_LIMITED" : status >= 500 ? "PROVIDER_SERVER_ERROR" : "PROVIDER_REQUEST_ERROR"
  return new IntegrationError(code, message, cls, status >= 500 ? 502 : status)
}
