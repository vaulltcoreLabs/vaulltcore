/**
 * Replaceable secret-provider seam (Phase 2C).
 *
 * The credential store NEVER stores a plaintext secret. It calls a
 * {@link SecretProvider} to store the secret in a backend of the operator's
 * choice (environment, KMS, Vault, an encrypted column behind a separate
 * service, …) and receives an opaque `secretRef` + a one-way `fingerprint`
 * back. At resolve time the provider dereferences the ref into a usable
 * secret value for an adapter, inside the resolver boundary only.
 *
 * No single secret-management vendor is hard-coded. The dev/test providers
 * here demonstrate the seam; production supplies its own.
 */

import { createHash, randomBytes } from "node:crypto"

export interface StoredSecret {
  /** Opaque reference; never dereferenced by the credential store. */
  readonly secretRef: string
  /** SHA-256 fingerprint of the secret body (never the secret). */
  readonly fingerprint: string
}

/**
 * Stores + dereferences secrets behind an opaque boundary. The credential
 * layer only ever sees `secretRef` + `fingerprint`; the plaintext secret
 * crosses this seam only on `resolve`, into the adapter.
 */
export interface SecretProvider {
  /**
   * Store a secret. Must be idempotent on identical secret content (same
   * content ⇒ same ref). Returns the opaque ref + a one-way fingerprint.
   */
  store(secret: string, scope: { tenantId: string; orgId: string; projectId: string; family: string; provider: string }): Promise<StoredSecret>
  /** Dereference a ref into the usable secret value, or null if gone. */
  resolve(secretRef: string): Promise<string | null>
  /** Delete a stored secret (rotation/revocation cleanup). Best-effort. */
  delete(secretRef: string): Promise<void>
}

/** SHA-256 fingerprint of a secret body. Never reveals the secret. */
export function secretFingerprint(secret: string): string {
  return "sha256:" + createHash("sha256").update(secret).digest("hex")
}

/**
 * Dev/test SecretProvider backed by an in-memory map. NOT for production.
 * Demonstrates the seam without a real secret backend.
 */
export class InMemorySecretProvider implements SecretProvider {
  private readonly secrets = new Map<string, string>()

  async store(secret: string, scope: { tenantId: string; orgId: string; projectId: string; family: string; provider: string }): Promise<StoredSecret> {
    const fingerprint = secretFingerprint(secret)
    const ref = "mem:" + createHash("sha256").update(`${scope.tenantId}|${scope.orgId}|${scope.projectId}|${fingerprint}`).digest("hex")
    this.secrets.set(ref, secret)
    return { secretRef: ref, fingerprint }
  }

  async resolve(secretRef: string): Promise<string | null> {
    return this.secrets.get(secretRef) ?? null
  }

  async delete(secretRef: string): Promise<void> {
    this.secrets.delete(secretRef)
  }
}

/**
 * Dev/test SecretProvider that stores secrets in the process environment.
 * Demonstrates the operator-supplied backend seam. NOT for production.
 */
export class EnvSecretProvider implements SecretProvider {
  async store(secret: string, scope: { tenantId: string; orgId: string; projectId: string; family: string; provider: string }): Promise<StoredSecret> {
    const fingerprint = secretFingerprint(secret)
    const ref = `vc_secret_${scope.family}_${randomBytes(6).toString("base64url")}`
    process.env[ref] = secret
    return { secretRef: ref, fingerprint }
  }

  async resolve(secretRef: string): Promise<string | null> {
    const v = process.env[secretRef]
    return typeof v === "string" ? v : null
  }

  async delete(secretRef: string): Promise<void> {
    delete process.env[secretRef]
  }
}
