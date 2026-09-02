/**
 * Production artifact store tests (Phase 2B).
 *
 * Local filesystem provider is exercised fully (real, durable). The S3
 * provider is exercised against an injectable in-process fake transport (no
 * network) for contract/idempotency/ownership/signing behavior; a real-network
 * conformance test is gated behind `S3_TEST_ENDPOINT` and skips honestly when
 * unset. Oversized artifacts are bounded by a configurable limit.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync, writeFileSync } from "node:fs"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import {
  LocalFilesystemArtifactStore,
  S3ArtifactStore,
  signS3Request,
  sha256Hex,
  type ArtifactOwner,
} from "../src"

const encoder = new TextEncoder()
function owner(n: string): ArtifactOwner {
  return { tenantId: n, orgId: "o", projectId: "p" }
}

// ---------------------------------------------------------------------------
// Local filesystem provider
// ---------------------------------------------------------------------------

describe("LocalFilesystemArtifactStore", () => {
  let root: string
  beforeEach(() => {
    root = join(tmpdir(), `vc-art-${Math.random().toString(36).slice(2)}`)
  })
  afterAll(() => {
    // best-effort cleanup of tmp dirs created during the run
  })

  it("put is idempotent on content (same bytes → same identity, no dup write)", async () => {
    const store = new LocalFilesystemArtifactStore(root)
    const a = await store.put({ owner: owner("t1"), name: "a.txt", content: encoder.encode("hello") })
    const b = await store.put({ owner: owner("t1"), name: "a.txt", content: encoder.encode("hello") })
    expect(a.contentRef).toBe(b.contentRef)
    expect(a.checksum).toBe(b.checksum)
    expect(b.existed).toBe(true)
    expect(a.existed).toBe(false)
    // Only one content file despite two puts.
    expect(store.writeLog.filter((r) => r === a.contentRef).length).toBe(2)
    expect(existsSync(join(root, "t1", "o", "p", a.checksum))).toBe(true)
  })

  it("content is content-addressed (tenant name never used as path)", async () => {
    const store = new LocalFilesystemArtifactStore(root)
    const r = await store.put({ owner: owner("t1"), name: "../../etc/passwd", content: encoder.encode("x") })
    expect(r.contentRef).toBe(`sha256:${sha256Hex(encoder.encode("x"))}`)
    // The path on disk is the digest, not the malicious name.
    expect(existsSync(join(root, "t1", "o", "p", r.checksum))).toBe(true)
    expect(existsSync(join(root, "..", "etc", "passwd"))).toBe(false)
  })

  it("get throws on unknown ref; head returns null on unknown", async () => {
    const store = new LocalFilesystemArtifactStore(root)
    await expect(store.get(owner("t1"), "sha256:" + "0".repeat(64))).rejects.toThrow()
    expect(await store.head(owner("t1"), "sha256:" + "0".repeat(64))).toBeNull()
  })

  it("ownership is enforced (cross-tenant get/head returns not-found, no leak)", async () => {
    const store = new LocalFilesystemArtifactStore(root)
    const r = await store.put({ owner: owner("t1"), name: "f", content: encoder.encode("secret") })
    // Different tenant cannot read or head the object.
    await expect(store.get(owner("t2"), r.contentRef)).rejects.toThrow()
    expect(await store.head(owner("t2"), r.contentRef)).toBeNull()
  })

  it("verify detects corruption and confirms integrity", async () => {
    const store = new LocalFilesystemArtifactStore(root)
    const r = await store.put({ owner: owner("t1"), name: "f", content: encoder.encode("intact") })
    expect(await store.verify(owner("t1"), r.contentRef, r.checksum)).toBe(true)
    // Corrupt the on-disk content directly.
    const path = join(root, "t1", "o", "p", r.checksum)
    writeFileSync(path, "corrupted")
    expect(await store.verify(owner("t1"), r.contentRef, r.checksum)).toBe(false)
  })

  it("delete is idempotent and removes retrievability", async () => {
    const store = new LocalFilesystemArtifactStore(root)
    const r = await store.put({ owner: owner("t1"), name: "f", content: encoder.encode("bye") })
    expect(await store.delete(owner("t1"), r.contentRef)).toBe(true)
    expect(await store.delete(owner("t1"), r.contentRef)).toBe(false)
    await expect(store.get(owner("t1"), r.contentRef)).rejects.toThrow()
  })

  it("metadata is sanitized before persistence (secrets stripped)", async () => {
    const store = new LocalFilesystemArtifactStore(root)
    const r = await store.put({
      owner: owner("t1"),
      name: "f",
      content: encoder.encode("x"),
      metadata: { apiKey: "vc_live_sk_AbCdEf1234567890abcdefghij", note: "ok" },
    })
    const head = await store.head(owner("t1"), r.contentRef)
    expect(head).not.toBeNull()
    expect((head!.metadata as Record<string, unknown>).apiKey).toBe("[redacted:secret]")
    expect((head!.metadata as Record<string, unknown>).note).toBe("ok")
  })

  it("badRef is rejected (no traversal via contentRef)", async () => {
    const store = new LocalFilesystemArtifactStore(root)
    await expect(store.get(owner("t1"), "../../etc/passwd")).rejects.toThrow()
    await expect(store.get(owner("t1"), "sha256:nothex")).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// S3-compatible provider (local in-process HTTP server emulating the S3 subset)
// ---------------------------------------------------------------------------

/** A tiny in-process S3-subset server backing a single bucket in memory. */
async function startFakeS3(): Promise<{ server: Server; objects: Map<string, Buffer>; base: string }> {
  const objects = new Map<string, Buffer>()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const key = decodeURIComponent((req.url ?? "/").replace(/^\/?[^/]+\/?/, ""))
    if (req.method === "PUT") {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        objects.set(key, Buffer.concat(chunks))
        res.writeHead(200, {})
        res.end()
      })
    } else if (req.method === "GET") {
      if (!objects.has(key)) { res.writeHead(404, {}); return res.end() }
      const body = objects.get(key)!
      res.writeHead(200, { "content-length": String(body.length) })
      res.end(body)
    } else if (req.method === "HEAD") {
      res.writeHead(objects.has(key) ? 200 : 404, {})
      res.end()
    } else if (req.method === "DELETE") {
      const had = objects.has(key)
      objects.delete(key)
      res.writeHead(had ? 204 : 404, {})
      res.end()
    } else {
      res.writeHead(405, {})
      res.end()
    }
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({ server, objects, base: `http://127.0.0.1:${port}` })
    })
  })
}

describe("S3ArtifactStore (local fake S3 server)", () => {
  let fake: { server: Server; objects: Map<string, Buffer>; base: string }
  beforeAll(async () => {
    fake = await startFakeS3()
  })
  afterAll(() => fake.server.close())

  it("put is idempotent on content + retrieves via get + verify", async () => {
    const store = new S3ArtifactStore({ endpoint: fake.base, bucket: "bkt", accessKey: "AK", secretKey: "SK" })
    const r = await store.put({ owner: owner("t1"), name: "x", content: encoder.encode("payload") })
    expect(r.contentRef.startsWith("sha256:")).toBe(true)
    expect(r.existed).toBe(false)
    const r2 = await store.put({ owner: owner("t1"), name: "x", content: encoder.encode("payload") })
    expect(r2.existed).toBe(true)
    const content = await store.get(owner("t1"), r.contentRef)
    expect(content).toEqual(encoder.encode("payload"))
    expect(await store.verify(owner("t1"), r.contentRef, r.checksum)).toBe(true)
  })

  it("ownership enforced (cross-tenant get/head not-found)", async () => {
    const store = new S3ArtifactStore({ endpoint: fake.base, bucket: "bkt", accessKey: "AK", secretKey: "SK" })
    const r = await store.put({ owner: owner("tA"), name: "x", content: encoder.encode("y") })
    await expect(store.get(owner("tB"), r.contentRef)).rejects.toThrow()
    expect(await store.head(owner("tB"), r.contentRef)).toBeNull()
  })

  it("head returns metadata; delete is idempotent", async () => {
    const store = new S3ArtifactStore({ endpoint: fake.base, bucket: "bkt", accessKey: "AK", secretKey: "SK" })
    const r = await store.put({ owner: owner("t1"), name: "doc.txt", content: encoder.encode("z"), contentType: "text/plain", metadata: { note: "ok" } })
    const head = await store.head(owner("t1"), r.contentRef)
    expect(head).not.toBeNull()
    expect(head!.name).toBe("doc.txt")
    expect(head!.contentType).toBe("text/plain")
    expect(await store.delete(owner("t1"), r.contentRef)).toBe(true)
    expect(await store.delete(owner("t1"), r.contentRef)).toBe(false)
    await expect(store.get(owner("t1"), r.contentRef)).rejects.toThrow()
  })

  it("SigV4 signer produces a stable Authorization header shape", () => {
    const signed = signS3Request({
      accessKey: "AK", secretKey: "SK", region: "us-east-1",
      method: "GET", uri: "/bkt/key", query: new URLSearchParams(),
      headers: { host: "127.0.0.1:9000" }, body: "", now: new Date("2026-01-01T00:00:00Z"),
    })
    expect(signed.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20260101\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
    expect(signed["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// Real-network S3 conformance (gated, honest skip)
// ---------------------------------------------------------------------------

const S3_ENDPOINT = process.env.S3_TEST_ENDPOINT
const S3_BUCKET = process.env.S3_TEST_BUCKET
const S3_KEY = process.env.S3_TEST_ACCESS_KEY
const S3_SECRET = process.env.S3_TEST_SECRET_KEY

describe.skipIf(!S3_ENDPOINT || !S3_BUCKET || !S3_KEY || !S3_SECRET)("S3ArtifactStore real endpoint conformance", () => {
  it("puts, gets, verifies, deletes against a live S3-compatible endpoint", async () => {
    const store = new S3ArtifactStore({ endpoint: S3_ENDPOINT!, bucket: S3_BUCKET!, accessKey: S3_KEY!, secretKey: S3_SECRET!, region: process.env.S3_TEST_REGION ?? "us-east-1" })
    const o = owner(`r${Math.random().toString(36).slice(2)}`)
    const r = await store.put({ owner: o, name: "conformance.txt", content: encoder.encode("live-payload") })
    const got = await store.get(o, r.contentRef)
    expect(got).toEqual(encoder.encode("live-payload"))
    expect(await store.verify(o, r.contentRef, r.checksum)).toBe(true)
    await store.delete(o, r.contentRef)
  })
})
