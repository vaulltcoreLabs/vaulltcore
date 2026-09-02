/**
 * Production artifact content store contracts (Phase 2B).
 *
 * Phase 2A introduced a minimal {@link ArtifactStore} (put/get/verify) backed by
 * an in-memory impl. Phase 2B adds a richer, production-capable content store
 * seam with the capabilities a durable product layer needs: head, delete,
 * immutable content-addressed identity, content length/type, tenant/project
 * ownership, metadata sanitization, integrity verification, idempotent writes,
 * and resumable/retry-safe operations where supported.
 *
 * Content addressing is the idempotency mechanism: identical content always
 * resolves to the same immutable artifact identity (a SHA-256 digest), so a
 * retry never duplicates a non-idempotent external write — the object already
 * exists and `put` returns the existing identity. Artifact references are NEVER
 * derived from tenant-supplied paths: the store mints the identity and rejects
 * path traversal. A tenant cannot reference another tenant's object — every
 * read/write carries the owning (tenant, org, project) scope and the store
 * enforces it.
 *
 * Vendor-neutral: no S3, R2, GCS, or AWS type is referenced here. Providers
 * (local filesystem, S3-compatible object storage) sit behind this interface.
 * AWS itself is never a core architectural dependency.
 */

import { createHash } from "node:crypto"

/** Owner scope for artifact content. Matches the Phase 1 {@link JobIdentity}. */
export interface ArtifactOwner {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
}

/** Immutable artifact content identity. Content-addressed (SHA-256 digest). */
export interface ArtifactIdentity {
  /** Opaque content reference (e.g. `sha256:<hex>` or a provider-specific key). */
  readonly contentRef: string
  readonly checksum: string
  readonly size: number
  readonly contentType: string | null
}

/** Metadata describing a stored object (from `head`). Sanitized. */
export interface ArtifactHead extends ArtifactIdentity {
  readonly owner: ArtifactOwner
  readonly name: string
  readonly createdAt: number
  readonly metadata: Readonly<Record<string, unknown>>
}

/** Options for a content `put`. Ownership + name are always required. */
export interface ArtifactPutOptions {
  readonly owner: ArtifactOwner
  readonly name: string
  readonly content: Uint8Array
  readonly contentType?: string | null
  /** Immutable metadata; sanitized before persistence (secrets stripped). */
  readonly metadata?: Record<string, unknown>
  /** When true, an existing identical object is returned without re-writing
   *  (idempotent). When false and the object exists, still idempotent (content
   *  addressing) but may recompute/verify. Default true. */
  readonly idempotent?: boolean
  /** Now clock (tests). */
  readonly now?: number
}

/** Outcome of a `put`: the durable, immutable identity of the stored content. */
export interface ArtifactPutResult extends ArtifactIdentity {
  /** Whether the object already existed (idempotent replay). */
  readonly existed: boolean
}

/**
 * Vendor-neutral production artifact content store.
 *
 * Guarantees a provider MUST uphold:
 * - `put` is idempotent on content: identical bytes → same identity, no
 *   duplicate side effects (a retry is safe even for non-idempotent backends).
 * - `get` throws on unknown ref (never returns null silently — a missing
 *   artifact is an error, not an empty result).
 * - `head` returns null on unknown ref (existence check, not a content read).
 * - `delete` is idempotent: deleting a missing ref is a no-op (returns false,
 *   no error). A deleted ref is no longer retrievable.
 * - Integrity: `get`/`head` content is verifiable against the stored checksum;
 *   `verify` recomputes and compares. Corruption is detected, never silent.
 * - Ownership: every ref is scoped to its (tenant, org, project). A read/write
 *   with a mismatched owner returns not-found (no cross-tenant existence leak).
 * - Path safety: refs are minted by the store; tenant-supplied names are
 *   sanitized and never used as raw storage paths. Path traversal is rejected.
 * - Metadata is sanitized before persistence (secrets stripped).
 */
export interface ProductionArtifactStore {
  /** Store content; returns the immutable content identity. Idempotent. */
  put(options: ArtifactPutOptions): Promise<ArtifactPutResult>
  /** Retrieve content by ref under an owner scope. Throws on unknown/mismatch. */
  get(owner: ArtifactOwner, contentRef: string): Promise<Uint8Array>
  /** Read metadata without loading content. Returns null on unknown/mismatch. */
  head(owner: ArtifactOwner, contentRef: string): Promise<ArtifactHead | null>
  /** Delete content by ref under an owner scope. Idempotent (missing = false). */
  delete(owner: ArtifactOwner, contentRef: string): Promise<boolean>
  /** Recompute the checksum and compare to the stored one. Throws on mismatch. */
  verify(owner: ArtifactOwner, contentRef: string, expectedChecksum: string): Promise<boolean>
}

/** Base error for artifact providers. */
export class ArtifactStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
  ) {
    super(message)
    this.name = "ArtifactStoreError"
  }
}

/** SHA-256 hex digest of content. Reused across all providers. */
export function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}
