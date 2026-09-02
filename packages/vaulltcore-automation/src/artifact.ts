/**
 * Automation artifacts + vendor-neutral storage abstraction (Phase 2A).
 *
 * Artifacts are durable product outputs, not arbitrary temp files. Records carry
 * an immutable identity + content reference + checksum + size and remain valid
 * historical references even after delivery. Content lives behind an
 * {@link ArtifactStore} so Vaulltcore is not locked to one vendor; Phase 2A
 * ships an in-memory implementation for tests. A corrupt artifact checksum is
 * detected on verification.
 */

import { createHash } from "node:crypto"
import { type AutomationArtifact, type ArtifactStore, AutomationError } from "./contracts"
import { newArtifactId } from "./ids"
import { sanitizeMetadata } from "@vaulltcore/audit"

export class ArtifactNotFoundError extends AutomationError {
  constructor(ref: string) {
    super("ARTIFACT_NOT_FOUND", `Artifact content not found: ${ref}`, 404)
  }
}

export class ArtifactChecksumError extends AutomationError {
  constructor(artifactId: string) {
    super("ARTIFACT_CHECKSUM_MISMATCH", `Artifact ${artifactId} content is corrupt (checksum mismatch)`, 500)
  }
}

/** SHA-256 over raw artifact content bytes. */
export function contentChecksum(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

/**
 * In-memory {@link ArtifactStore} for tests and local development. Content is
 * keyed by its checksum (content-addressed) so identical content is stored once
 * and verified by recomputation. NOT durable across process restarts —
 * production wires a real store (S3, R2, …) implementing the same interface.
 */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly refs = new Map<string, Uint8Array>()

  async put(content: Uint8Array, _name: string): Promise<{ contentRef: string; checksum: string; size: number }> {
    const checksum = contentChecksum(content)
    const ref = `mem://${checksum}`
    if (!this.refs.has(ref)) this.refs.set(ref, content)
    return { contentRef: ref, checksum, size: content.byteLength }
  }

  async get(contentRef: string): Promise<Uint8Array> {
    const content = this.refs.get(contentRef)
    if (!content) throw new ArtifactNotFoundError(contentRef)
    return content
  }

  async verify(contentRef: string, expectedChecksum: string): Promise<boolean> {
    const content = this.refs.get(contentRef)
    if (!content) throw new ArtifactNotFoundError(contentRef)
    return contentChecksum(content) === expectedChecksum
  }
}

/** Build an immutable artifact record. Metadata is sanitized (secrets stripped)
 *  before persistence, mirroring the audit approach. */
export function buildArtifact(args: {
  readonly runId: string
  readonly versionId: string
  readonly stepId: string | null
  readonly type: string
  readonly name: string
  readonly contentRef: string
  readonly checksum: string
  readonly size: number | null
  readonly metadata?: Record<string, unknown>
  readonly now?: number
}): AutomationArtifact {
  return {
    artifactId: newArtifactId(),
    runId: args.runId,
    versionId: args.versionId,
    stepId: args.stepId,
    type: args.type,
    name: args.name,
    contentRef: args.contentRef,
    checksum: args.checksum,
    size: args.size,
    createdAt: args.now ?? Date.now(),
    metadata: sanitizeMetadata(args.metadata ?? {}),
  }
}

/** Verify an artifact record against its stored content. Throws on mismatch. */
export async function verifyArtifact(record: AutomationArtifact, store: ArtifactStore): Promise<void> {
  const ok = await store.verify(record.contentRef, record.checksum)
  if (!ok) throw new ArtifactChecksumError(record.artifactId)
}
