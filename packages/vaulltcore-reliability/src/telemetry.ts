/**
 * Operational telemetry emitter (Phase 2E).
 *
 * Emits structured, tenant-scoped operational events to the durable audit log.
 * The audit store persists `type` as TEXT, so Phase 2E event types are additive
 * (no schema change). Telemetry NEVER carries credentials, authorization
 * headers, API keys, access/refresh tokens, secret references that reveal
 * secret material, or unrestricted raw event payloads — {@link sanitizeMetadata}
 * strips them before write, and {@link buildTelemetryMetadata} never puts raw
 * payloads into metadata in the first place.
 *
 * Stable identifiers included where safe: tenantId, runId, dispatchId,
 * sourceEventId, triggerId, attempt number, worker identity or safe instance
 * identifier, timestamps, durations, and failure classification. Worker
 * identity is the configured worker id (a safe operational handle), never a
 * raw secret or a principal credential.
 */

import type { SqlAuditStore } from "@vaulltcore/audit"
import { sanitizeMetadata, type AuditEventType } from "@vaulltcore/audit"
import type { FailureClass } from "@vaulltcore/ops"

/** A safe operational telemetry record (secrets never present). */
export interface TelemetryEvent {
  readonly tenantId: string
  readonly orgId?: string | null
  readonly projectId?: string | null
  readonly type: AuditEventType
  readonly metadata?: Record<string, unknown>
}

/** Emitted by a reliability component after a meaningful lifecycle transition.
 *  Always tenant-scoped; never throws (best-effort, like all audit writes). */
export interface TelemetrySink {
  emit(event: TelemetryEvent): Promise<void>
}

/** A telemetry sink backed by the durable audit store. Never throws — a
 *  telemetry failure must never break a reliability transition. */
export class AuditTelemetrySink implements TelemetrySink {
  private readonly audit: SqlAuditStore
  private readonly actorPrincipalId: string
  constructor(audit: SqlAuditStore, actorPrincipalId = "reliability") {
    this.audit = audit
    this.actorPrincipalId = actorPrincipalId
  }
  async emit(event: TelemetryEvent): Promise<void> {
    await this.audit.append({
      actor: { principalId: this.actorPrincipalId, kind: "service_account", tenantId: event.tenantId },
      scope: { tenantId: event.tenantId, ...(event.orgId ? { orgId: event.orgId } : {}), ...(event.projectId ? { projectId: event.projectId } : {}) },
      type: event.type,
      metadata: sanitizeMetadata(event.metadata ?? {}),
    }).catch(() => {})
  }
}

/** Build safe telemetry metadata for a lease lifecycle event. Never includes
 *  secret material — only stable identifiers + sanitized diagnostics. */
export function leaseMetadata(args: {
  readonly itemId?: string
  readonly dispatchId?: string
  readonly workerId: string
  readonly generation: number
  readonly leaseMs?: number
}): Record<string, unknown> {
  const out: Record<string, unknown> = { workerId: args.workerId, generation: args.generation }
  if (args.itemId) out.itemId = args.itemId
  if (args.dispatchId) out.dispatchId = args.dispatchId
  if (args.leaseMs !== undefined) out.leaseMs = args.leaseMs
  return out
}

/** Build safe telemetry metadata for a retry/dead-letter/redrive event. */
export function retryMetadata(args: {
  readonly itemId?: string
  readonly dispatchId?: string
  readonly attempt: number
  readonly failureClass?: FailureClass | string | null
  readonly nextRetryAt?: number | null
  readonly reason?: string | null
}): Record<string, unknown> {
  const out: Record<string, unknown> = { attempt: args.attempt }
  if (args.itemId) out.itemId = args.itemId
  if (args.dispatchId) out.dispatchId = args.dispatchId
  if (args.failureClass) out.failureClass = args.failureClass
  if (args.nextRetryAt !== undefined) out.nextRetryAt = args.nextRetryAt
  if (args.reason) out.reason = args.reason.slice(0, 500)
  return out
}

/** Build safe telemetry metadata for a reconciliation event. */
export function reconciliationMetadata(args: {
  readonly scanned: number
  readonly detected: number
  readonly recovered: number
  readonly cursor?: string | null
  readonly kind?: string
}): Record<string, unknown> {
  const out: Record<string, unknown> = { scanned: args.scanned, detected: args.detected, recovered: args.recovered }
  if (args.cursor) out.cursor = args.cursor
  if (args.kind) out.kind = args.kind
  return out
}

/** Build safe telemetry metadata for a capacity event. */
export function capacityMetadata(args: {
  readonly tenantId: string
  readonly scope?: string
  readonly inUse?: number
  readonly maxConcurrent?: number
  readonly global?: boolean
}): Record<string, unknown> {
  const out: Record<string, unknown> = { tenantId: args.tenantId }
  if (args.scope) out.scope = args.scope
  if (args.inUse !== undefined) out.inUse = args.inUse
  if (args.maxConcurrent !== undefined) out.maxConcurrent = args.maxConcurrent
  if (args.global) out.global = true
  return out
}
