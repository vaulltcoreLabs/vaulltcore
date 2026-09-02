/**
 * Vaulltcore Production Artifact Stores (Phase 2B).
 *
 * Vendor-neutral artifact content storage with real, production-capable
 * providers (local filesystem + S3-compatible object storage). The seam is
 * {@link ProductionArtifactStore}; AWS is never a core dependency.
 *
 * Dependency direction: artifacts → audit (sanitizer only). It does not depend
 * on the runner, automation, store-sql, identity, or any vendor SDK.
 */

export * from "./contracts"
export { LocalFilesystemArtifactStore } from "./local-store"
export { S3ArtifactStore, signS3Request, type S3ArtifactStoreOptions, type RequestOptions, type ClientRequest } from "./s3-store"
