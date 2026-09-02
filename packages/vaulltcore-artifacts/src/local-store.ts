/**
 * Local filesystem artifact content store (Phase 2B).
 *
 * A real, durable (across process restarts) provider for development and
 * single-node deployments. Content is content-addressed: the on-disk path is
 * derived from the SHA-256 digest under a tenant-scoped directory, never from a
 * tenant-supplied name. The tenant-supplied `name` is stored as metadata only.
 *
 * Path safety: the storage key is the digest hex; the on-disk layout is
 * `<root>/<tenant-safe>/<sha256-hex>` where the tenant segment is sanitized to a
 * fixed charset. No `..`, no separators, no absolute paths from tenant input.
 * Ownership is enforced on every read/write: a mismatched owner returns
 * not-found (no cross-tenant existence leak).
 *
 * Metadata + head are persisted alongside content as a small JSON sidecar.
 */

import { promises as fs, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
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

/** Sanitize a tenant/org/project id into a single safe filesystem segment. */
function safeSegment(id: string): string {
  return id.replace(SAFE_SEG, "_")
}

function ownerDir(root: string, owner: ArtifactOwner): string {
  return join(root, safeSegment(owner.tenantId), safeSegment(owner.orgId), safeSegment(owner.projectId))
}

/** Content path is content-addressed: <ownerDir>/<sha256-hex>. */
function contentPath(root: string, owner: ArtifactOwner, digestHex: string): string {
  return join(ownerDir(root, owner), digestHex)
}

/** Sidecar path: <ownerDir>/<sha256-hex>.meta.json. */
function metaPath(root: string, owner: ArtifactOwner, digestHex: string): string {
  return join(ownerDir(root, owner), `${digestHex}.meta.json`)
}

/** Extract the digest hex from a contentRef (`sha256:<hex>`). */
function digestFromRef(contentRef: string): string {
  if (!contentRef.startsWith(CONTENT_REF_PREFIX)) {
    throw new ArtifactStoreError("ARTIFACT_BAD_REF", `Unrecognized content reference: ${contentRef}`, 400)
  }
  const hex = contentRef.slice(CONTENT_REF_PREFIX.length)
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new ArtifactStoreError("ARTIFACT_BAD_REF", `Malformed content reference: ${contentRef}`, 400)
  }
  return hex
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

export class LocalFilesystemArtifactStore implements ProductionArtifactStore {
  private readonly root: string
  /** When set, `put` records writes (for test assertions). */
  readonly writeLog: string[] = []

  constructor(root: string) {
    if (root === "" || root.includes("..")) throw new ArtifactStoreError("ARTIFACT_BAD_ROOT", "Invalid artifact root", 400)
    this.root = root
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
  }

  async put(options: ArtifactPutOptions): Promise<ArtifactPutResult> {
    if (options.content.length > 0 && options.owner.tenantId === "") {
      throw new ArtifactStoreError("ARTIFACT_BAD_OWNER", "Artifact owner tenantId is required", 400)
    }
    const checksum = sha256Hex(options.content)
    const contentRef = `${CONTENT_REF_PREFIX}${checksum}`
    const dir = ownerDir(this.root, options.owner)
    const cpath = contentPath(this.root, options.owner, checksum)
    const mpath = metaPath(this.root, options.owner, checksum)
    const existed = existsSync(cpath)
    if (!existed) {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(cpath, options.content)
    }
    const meta: StoredMeta = {
      checksum,
      size: options.content.byteLength,
      contentType: options.contentType ?? null,
      name: options.name,
      owner: options.owner,
      createdAt: options.now ?? Date.now(),
      metadata: sanitizeMetadata(options.metadata ?? {}),
    }
    // Metadata is always (re)written so the head reflects the latest sanitized
    // metadata for that content identity; content itself is immutable.
    await fs.writeFile(mpath, JSON.stringify(meta))
    this.writeLog.push(contentRef)
    return { contentRef, checksum, size: options.content.byteLength, contentType: meta.contentType, existed }
  }

  async get(owner: ArtifactOwner, contentRef: string): Promise<Uint8Array> {
    const hex = digestFromRef(contentRef)
    const cpath = contentPath(this.root, owner, hex)
    if (!existsSync(cpath)) throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", `Artifact content not found: ${contentRef}`, 404)
    const buf = await fs.readFile(cpath)
    return new Uint8Array(buf)
  }

  async head(owner: ArtifactOwner, contentRef: string): Promise<ArtifactHead | null> {
    const hex = digestFromRef(contentRef)
    const mpath = metaPath(this.root, owner, hex)
    if (!existsSync(mpath)) return null
    try {
      const meta = JSON.parse(await fs.readFile(mpath, "utf8")) as StoredMeta
      return {
        contentRef,
        checksum: meta.checksum,
        size: meta.size,
        contentType: meta.contentType,
        name: meta.name,
        owner: meta.owner,
        createdAt: meta.createdAt,
        metadata: meta.metadata,
      }
    } catch {
      // Corrupt sidecar: treat as not-found (content integrity is re-checkable).
      return null
    }
  }

  async delete(owner: ArtifactOwner, contentRef: string): Promise<boolean> {
    const hex = digestFromRef(contentRef)
    const cpath = contentPath(this.root, owner, hex)
    const mpath = metaPath(this.root, owner, hex)
    const cExists = existsSync(cpath)
    try {
      await fs.unlink(cpath).catch(() => {})
      await fs.unlink(mpath).catch(() => {})
    } catch {
      // ignore
    }
    // Best-effort cleanup of empty owner dirs (never throw).
    await fs.rmdir(dirname(cpath)).catch(() => {})
    return cExists
  }

  async verify(owner: ArtifactOwner, contentRef: string, expectedChecksum: string): Promise<boolean> {
    const content = await this.get(owner, contentRef)
    return sha256Hex(content) === expectedChecksum
  }
}
