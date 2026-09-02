/**
 * Vaulltcore neutral integration contracts (Phase 2C).
 *
 * The provider-neutral surface every external-system adapter implements:
 *  - {@link IntegrationProvider}: identity verification, capability declaration,
 *    webhook signature verification, and raw→normalized event mapping.
 *  - {@link NormalizedEvent}: the single event shape fan-out/subscriptions match
 *    on, regardless of provider. Deterministic event identity prevents
 *    duplicate automation work from duplicate webhooks.
 *  - {@link ExternalMutation}: identity boundary for idempotent mutations.
 *
 * No provider-specific types leak into these contracts. GitHub/GitLab/Linear/
 * Slack each implement adapters; the contracts are shared. This is NOT a
 * general workflow engine — providers expose read + scoped mutation + event
 * normalization only.
 *
 * Security: every operation is tenant-scoped; the adapter receives a resolved
 * credential (never the raw secret store); webhook verification proves sender
 * identity but event CONTENT is always treated as untrusted data, never as
 * instructions. SSRF protection is reused from @vaulltcore/delivery.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { ResolvedCredential, ConnectionCapability } from "@vaulltcore/credentials"
import type { RetryClass } from "@vaulltcore/delivery"

/** Concrete provider kind within a family (e.g. "github-com", "linear"). */
export interface ProviderKind {
  readonly family: string
  readonly provider: string
  /** Human label for UI (redacted-safe). */
  readonly label: string
  /** Capabilities this provider can grant. */
  readonly capabilities: readonly ConnectionCapability[]
}

/** Normalized external identity returned by verifyIdentity. */
export interface ProviderIdentity {
  readonly externalId: string
  readonly displayName: string | null
  readonly scopes: readonly string[]
}

/** Base error for integration providers; carries a retry class + HTTP-ish status. */
export class IntegrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryClass: RetryClass = "unknown_uncertain",
    readonly status = 502,
  ) {
    super(message)
    this.name = "IntegrationError"
  }
}

/** A normalized external resource (repo, project, channel, …). */
export interface ExternalResource {
  readonly kind: string
  readonly id: string
  readonly displayName: string | null
  readonly url: string | null
  /** Sanitized metadata (no secrets). */
  readonly metadata: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Normalized events
// ---------------------------------------------------------------------------

/** Coarse event categories shared across providers. */
export const NORMALIZED_EVENT_KINDS = [
  "repo.push",
  "pr.opened",
  "pr.updated",
  "pr.closed",
  "pr.merged",
  "issue.opened",
  "issue.updated",
  "issue.closed",
  "issue.commented",
  "pr.commented",
  "message.received",
  "review.submitted",
  "release.published",
  "custom",
] as const
export type NormalizedEventKind = (typeof NORMALIZED_EVENT_KINDS)[number]

/**
 * The single normalized event shape fan-out matches on. Deterministic
 * `eventId` (tenant + provider + providerEventId) is the dedup identity: a
 * duplicate webhook never creates duplicate work. `receivedAt` supports replay
 * protection; `providerTimestamp` (when the event happened upstream) supports
 * timestamp validation.
 */
export interface NormalizedEvent {
  /** Deterministic: `sha256(tenantId|provider|providerEventId)` prefix. */
  readonly eventId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly provider: string
  /** The provider's own event id (delivery id, X-GitHub-Delivery, …). */
  readonly providerEventId: string
  readonly kind: NormalizedEventKind
  /** Stable resource identity the event concerns (e.g. "github:owner/repo"). */
  readonly resource: string
  readonly action: string | null
  readonly actor: { readonly externalId: string; readonly displayName: string | null } | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly providerTimestamp: number | null
  readonly receivedAt: number
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

/** A raw inbound webhook before verification/normalization. */
export interface RawWebhook {
  readonly provider: string
  readonly headers: Readonly<Record<string, string>>
  readonly rawBody: string
  /** The URL path the webhook was delivered to (may encode tenant/route). */
  readonly path: string
}

/** Result of verifying + normalizing a webhook. */
export interface WebhookVerifyResult {
  readonly verified: boolean
  readonly reason: string | null
  /** The normalized event when verified + recognized; null otherwise. */
  readonly event: Omit<NormalizedEvent, "eventId" | "tenantId" | "orgId" | "projectId" | "receivedAt"> | null
}

// ---------------------------------------------------------------------------
// External mutation idempotency
// ---------------------------------------------------------------------------

/**
 * Identity boundary for an idempotent external mutation. The adapter MUST be
 * idempotent on this key: a replay (worker retry) returns the original result
 * without a duplicate side effect. Execution stays at-least-once; settlement
 * is exactly-once at this durable identity boundary.
 *
 * Deterministic form: `tenant + connectionId + operationId`.
 */
export interface ExternalMutation {
  readonly tenantId: string
  readonly connectionId: string
  /** Stable operation id (e.g. "commit:owner/repo:branch:sha" or "pr:create:…"). */
  readonly operationId: string
}

// ---------------------------------------------------------------------------
// Provider seam
// ---------------------------------------------------------------------------

/**
 * Neutral provider seam. Adapters implement this; the control plane, webhook
 * gateway, and fan-out layer speak only this surface. No GitHub/GitLab/Linear
 * types leak here. Methods carry tenant scope via the resolved credential.
 */
export interface IntegrationProvider {
  readonly kind: ProviderKind
  /** Verify the credential resolves to a valid external identity. */
  verifyIdentity(credential: ResolvedCredential): Promise<ProviderIdentity>
  /** Verify a webhook signature + normalize to a provider event. Never trusts
   *  content as instructions; only maps known event shapes. */
  verifyWebhook(raw: RawWebhook, options: { secret: string }): Promise<WebhookVerifyResult>
}

/**
 * Registry of available providers by (family, provider). Adapters register
 * here; the control plane / webhook gateway resolve a provider for a
 * connection. Adding a provider never touches the registry's callers.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, IntegrationProvider>()

  register(provider: IntegrationProvider): void {
    const key = `${provider.kind.family}:${provider.kind.provider}`
    if (this.providers.has(key)) throw new IntegrationError("PROVIDER_EXISTS", `provider ${key} already registered`)
    this.providers.set(key, provider)
  }

  resolve(family: string, provider: string): IntegrationProvider {
    const p = this.providers.get(`${family}:${provider}`)
    if (!p) throw new IntegrationError("PROVIDER_NOT_FOUND", `no provider registered for ${family}:${provider}`, "permanent_validation", 404)
    return p
  }

  list(): ProviderKind[] {
    return [...this.providers.values()].map((p) => p.kind)
  }
}

/** Deterministic event id: sha256(tenantId|provider|providerEventId). */
export function deterministicEventId(tenantId: string, provider: string, providerEventId: string): string {
  return "evt:" + createHash("sha256").update(`${tenantId}|${provider}|${providerEventId}`).digest("hex").slice(0, 32)
}

/** Constant-time HMAC-SHA256 verification for webhook signatures.
 *  Accepts "<algo>=<hex>" forms (GitHub "sha256=", Slack "v0=") or bare "<hex>".
 *  Never throws. */
export function verifyHmacSha256(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false
  const eq = signature.indexOf("=")
  const hex = eq >= 0 ? signature.slice(eq + 1) : signature
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  const a = Buffer.from(hex, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
