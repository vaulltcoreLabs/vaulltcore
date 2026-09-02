/**
 * S3-compatible object storage artifact provider (Phase 2B).
 *
 * A real object-storage provider behind the {@link ProductionArtifactStore}
 * interface. It speaks the S3 REST API (path-style requests, SigV4 signing)
 * over plain `node:http`/`node:https`, so it works against MinIO, LocalStack,
 * R2, GCS S3 interop, AWS S3, or any S3-compatible endpoint. AWS itself is NOT
 * a core dependency — there is no AWS SDK import; only the standard library is
 * used. The bucket/key layout is content-addressed (`<tenant>/<org>/<project>/<sha256>`),
 * so `put` is idempotent on content and a retry never duplicates a non-
 * idempotent external write.
 *
 * Resumable uploads are out of scope for this phase (single-shot PUT). Delete +
 * head are idempotent per the interface contract. Integrity is verified by
 * recomputing the SHA-256 of a fetched object.
 *
 * Real-network tests are gated behind `S3_TEST_ENDPOINT` (see test file) and
 * skip honestly when the endpoint is unreachable. No test fakes a pass.
 */

import { request, type RequestOptions, type ClientRequest } from "node:http"
import { request as requestHttps } from "node:https"
import { createHash, createHmac } from "node:crypto"
import { sanitizeMetadata } from "@vaulltcore/audit"
import {
  type ArtifactHead,
  type ArtifactOwner,
  type ArtifactPutOptions,
  type ArtifactPutResult,
  type ProductionArtifactStore,
  ArtifactStoreError,
  sha256Hex,
} from "./contracts"

const CONTENT_REF_PREFIX = "sha256:"
const SAFE_SEG = /[^a-zA-Z0-9_-]/g

function safeSeg(id: string): string {
  return id.replace(SAFE_SEG, "_")
}

/** Content-addressed object key under the owner scope. */
function objectKey(owner: ArtifactOwner, digestHex: string): string {
  return `${safeSeg(owner.tenantId)}/${safeSeg(owner.orgId)}/${safeSeg(owner.projectId)}/${digestHex}`
}

function digestFromRef(contentRef: string): string {
  if (!contentRef.startsWith(CONTENT_REF_PREFIX)) throw new ArtifactStoreError("ARTIFACT_BAD_REF", `Unrecognized content reference: ${contentRef}`, 400)
  const hex = contentRef.slice(CONTENT_REF_PREFIX.length)
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new ArtifactStoreError("ARTIFACT_BAD_REF", `Malformed content reference: ${contentRef}`, 400)
  return hex
}

export interface S3ArtifactStoreOptions {
  /** Endpoint URL, e.g. `http://127.0.0.1:9000` or `https://s3.us-east-1.amazonaws.com`. */
  readonly endpoint: string
  /** Bucket name. */
  readonly bucket: string
  /** Access key id. */
  readonly accessKey: string
  /** Secret access key. */
  readonly secretKey: string
  /** AWS region (default `us-east-1`). */
  readonly region?: string
  /** Force path-style addressing (default true; MinIO/LocalStack need this). */
  readonly pathStyle?: boolean
  /** Injectable HTTP transport for tests (default picks http/https by endpoint). */
  readonly transport?: (options: RequestOptions) => import("node:http").ClientRequest
}

interface ParsedEndpoint {
  readonly protocol: string
  readonly hostname: string
  readonly port: number | null
  readonly pathBase: string
}

function parseEndpoint(endpoint: string): ParsedEndpoint {
  const url = new URL(endpoint)
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : null,
    pathBase: url.pathname.replace(/\/+$/, ""),
  }
}

/** A minimal AWS SigV4 signer for S3 REST requests (no AWS SDK). */
class SigV4 {
  constructor(
    private readonly accessKey: string,
    private readonly secretKey: string,
    private readonly region: string,
    private readonly service = "s3",
  ) {}

  private hmac(key: Buffer | string, data: string): Buffer {
    return createHmac("sha256", key).update(data, "utf8").digest()
  }

  private hexHash(data: string): string {
    return createHash("sha256").update(data, "utf8").digest("hex")
  }

  sign(args: {
    readonly method: string
    readonly uri: string
    readonly query: URLSearchParams
    readonly headers: Record<string, string>
    readonly body: Buffer | string
    readonly now: Date
  }): Record<string, string> {
    const { method, uri, query, headers, body, now } = args
    const iso = now.toISOString()
    const date = iso.slice(0, 10).replace(/-/g, "")
    const dateTime = iso.slice(0, 19).replace(/[-:]/g, "") + "Z"
    const bodyHash = this.hexHash(typeof body === "string" ? body : body.toString("latin1"))
    const canonicalQuery = canonicalQueryString(query)
    // x-amz-date + x-amz-content-sha256 MUST be part of the signed header set so
    // the signature covers them (and they are sent on the wire).
    const allHeaders: Record<string, string> = {
      ...headers,
      host: headers.host ?? "",
      "x-amz-date": dateTime,
      "x-amz-content-sha256": bodyHash,
    }
    const signedHeaderKeys = Object.keys(allHeaders).map((k) => k.toLowerCase()).sort()
    const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${allHeaders[k] ?? ""}\n`).join("")
    const signedHeaders = signedHeaderKeys.join(";")
    const canonicalRequest = `${method}\n${uri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`
    const scope = `${date}/${this.region}/${this.service}/aws4_request`
    const stringToSign = `AWS4-HMAC-SHA256\n${dateTime}\n${scope}\n${this.hexHash(canonicalRequest)}`
    const kDate = this.hmac("AWS4" + this.secretKey, date)
    const kRegion = this.hmac(kDate, this.region)
    const kService = this.hmac(kRegion, this.service)
    const kSigning = this.hmac(kService, "aws4_request")
    const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex")
    return {
      ...allHeaders,
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }
  }
}

function canonicalQueryString(query: URLSearchParams): string {
  const pairs: string[] = []
  query.sort()
  for (const [k, v] of query.entries()) pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return pairs.join("&")
}

/** A captured HTTP response. */
interface HttpResponse {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: Buffer
}

function doRequest(transport: S3ArtifactStoreOptions["transport"], parsed: ParsedEndpoint, opts: RequestOptions, body?: Buffer): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const baseOptions: RequestOptions = {
      method: opts.method,
      hostname: parsed.hostname,
      port: parsed.port ?? undefined,
      path: opts.path,
      headers: opts.headers,
    }
    const req = transport ? transport(baseOptions) : parsed.protocol === "https:" ? requestHttps(baseOptions) : request(baseOptions)
    req.on("error", reject)
    req.on("response", (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    if (body && body.length > 0) req.write(body)
    req.end()
  })
}

interface StoredMeta {
  readonly checksum: string
  readonly size: number
  readonly contentType: string | null
  readonly name: string
  readonly owner: ArtifactOwner
  readonly createdAt: number
  readonly metadata: Readonly<Record<string, unknown>>
}

const META_SUFFIX = ".meta.json"

export class S3ArtifactStore implements ProductionArtifactStore {
  private readonly endpoint: ParsedEndpoint
  private readonly bucket: string
  private readonly signer: SigV4
  private readonly region: string
  private readonly pathStyle: boolean
  private readonly transport: S3ArtifactStoreOptions["transport"]

  constructor(options: S3ArtifactStoreOptions) {
    this.endpoint = parseEndpoint(options.endpoint)
    this.bucket = options.bucket
    this.region = options.region ?? "us-east-1"
    this.pathStyle = options.pathStyle ?? true
    this.signer = new SigV4(options.accessKey, options.secretKey, this.region)
    this.transport = options.transport
  }

  private hostHeader(): string {
    return this.pathStyle
      ? this.endpoint.hostname + (this.endpoint.port ? `:${this.endpoint.port}` : "")
      : `${this.bucket}.${this.endpoint.hostname}` + (this.endpoint.port ? `:${this.endpoint.port}` : "")
  }

  private requestPath(key: string): string {
    const base = this.endpoint.pathBase
    if (this.pathStyle) return `${base}/${this.bucket}/${key}`
    return `${base}/${key}`
  }

  private async s3Request(method: string, key: string, body: Buffer | string, extraHeaders: Record<string, string> = {}, query: URLSearchParams = new URLSearchParams()): Promise<HttpResponse> {
    const path = this.requestPath(key)
    const host = this.hostHeader()
    const headers: Record<string, string> = { host, ...extraHeaders }
    const signed = this.signer.sign({ method, uri: path.split("?")[0] ?? "", query, headers, body, now: new Date() })
    const opts: RequestOptions = { method, path, headers: signed }
    return doRequest(this.transport, this.endpoint, opts, typeof body === "string" ? Buffer.from(body, "utf8") : body)
  }

  async put(options: ArtifactPutOptions): Promise<ArtifactPutResult> {
    if (options.owner.tenantId === "") throw new ArtifactStoreError("ARTIFACT_BAD_OWNER", "Artifact owner tenantId is required", 400)
    const checksum = sha256Hex(options.content)
    const contentRef = `${CONTENT_REF_PREFIX}${checksum}`
    const key = objectKey(options.owner, checksum)
    const contentType = options.contentType ?? "application/octet-stream"
    // Idempotent: if the object already exists (HEAD ok), skip re-uploading the
    // (immutable) bytes but refresh sanitized metadata. A retry is safe.
    const head = await this.s3Request("HEAD", key, "", {}).catch((e) => e as { status?: number })
    const existed = !(head instanceof Error) && (head as HttpResponse).status === 200
    if (!existed) {
      const res = await this.s3Request("PUT", key, Buffer.from(options.content), {
        "content-type": contentType,
        "content-length": String(options.content.byteLength),
      })
      if (res.status !== 200) throw new ArtifactStoreError("ARTIFACT_PUT_FAILED", `S3 put failed (${res.status}): ${res.body.toString("utf8").slice(0, 200)}`, 502)
    }
    // Persist sanitized metadata sidecar.
    const meta: StoredMeta = {
      checksum,
      size: options.content.byteLength,
      contentType: options.contentType ?? null,
      name: options.name,
      owner: options.owner,
      createdAt: options.now ?? Date.now(),
      metadata: sanitizeMetadata(options.metadata ?? {}),
    }
    const metaKey = `${key}${META_SUFFIX}`
    const metaRes = await this.s3Request("PUT", metaKey, JSON.stringify(meta), { "content-type": "application/json" })
    if (metaRes.status !== 200) throw new ArtifactStoreError("ARTIFACT_PUT_FAILED", `S3 meta put failed (${metaRes.status})`, 502)
    return { contentRef, checksum, size: options.content.byteLength, contentType: options.contentType ?? null, existed }
  }

  async get(owner: ArtifactOwner, contentRef: string): Promise<Uint8Array> {
    const hex = digestFromRef(contentRef)
    const key = objectKey(owner, hex)
    const res = await this.s3Request("GET", key, "", {})
    if (res.status === 404) throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", `Artifact content not found: ${contentRef}`, 404)
    if (res.status !== 200) throw new ArtifactStoreError("ARTIFACT_GET_FAILED", `S3 get failed (${res.status})`, 502)
    return new Uint8Array(res.body)
  }

  async head(owner: ArtifactOwner, contentRef: string): Promise<ArtifactHead | null> {
    const hex = digestFromRef(contentRef)
    const metaKey = `${objectKey(owner, hex)}${META_SUFFIX}`
    const res = await this.s3Request("GET", metaKey, "", {})
    if (res.status === 404) return null
    if (res.status !== 200) return null
    try {
      const meta = JSON.parse(res.body.toString("utf8")) as StoredMeta
      // Enforce ownership (the key already encodes it; double-check the meta).
      if (meta.owner.tenantId !== owner.tenantId || meta.owner.orgId !== owner.orgId || meta.owner.projectId !== owner.projectId) return null
      return { contentRef, checksum: meta.checksum, size: meta.size, contentType: meta.contentType, name: meta.name, owner: meta.owner, createdAt: meta.createdAt, metadata: meta.metadata }
    } catch {
      return null
    }
  }

  async delete(owner: ArtifactOwner, contentRef: string): Promise<boolean> {
    const hex = digestFromRef(contentRef)
    const key = objectKey(owner, hex)
    const metaKey = `${key}${META_SUFFIX}`
    const existed = (await this.s3Request("HEAD", key, "", {}).catch(() => null) as HttpResponse | null)?.status === 200
    await this.s3Request("DELETE", key, "", {}).catch(() => null)
    await this.s3Request("DELETE", metaKey, "", {}).catch(() => null)
    return existed ?? false
  }

  async verify(owner: ArtifactOwner, contentRef: string, expectedChecksum: string): Promise<boolean> {
    const content = await this.get(owner, contentRef)
    return sha256Hex(content) === expectedChecksum
  }
}

/** Exposed for unit-testing the signer deterministically (no network). */
export function signS3Request(args: {
  readonly accessKey: string
  readonly secretKey: string
  readonly region: string
  readonly method: string
  readonly uri: string
  readonly query: URLSearchParams
  readonly headers: Record<string, string>
  readonly body: Buffer | string
  readonly now: Date
}): Record<string, string> {
  const signer = new SigV4(args.accessKey, args.secretKey, args.region)
  return signer.sign(args)
}

/** Type re-export so tests can construct a fake transport without http types. */
export type { RequestOptions, ClientRequest } from "node:http"
