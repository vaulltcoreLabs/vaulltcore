/**
 * Audit contracts (Phase 1E).
 *
 * The audit log is append-only and durable. Records carry immutable actor
 * identity, tenant/org/project scope where applicable, event type, timestamp,
 * and sanitized metadata. Plaintext secrets, API keys, and credentials NEVER
 * appear in audit data — {@link sanitizeMetadata} strips them before any write.
 */

export const AUDIT_EVENT_TYPES = [
  "tenant_created",
  "org_created",
  "project_created",
  "member_added",
  "member_role_changed",
  "member_removed",
  "apikey_created",
  "apikey_revoked",
  "policy_created",
  "policy_changed",
  "quota_reserved",
  "quota_rejected",
  "quota_released",
  "quota_settled",
  "job_admitted",
  "job_rejected",
  "job_started",
  "job_suspended",
  "job_resumed",
  "job_cancelled",
  "job_completed",
  "job_failed",
  "ownership_recovered",
  "policy_decision",
  "ledger_entry",
  // Phase 2A: automation product-layer actions. Additive — the audit store
  // persists `type` as TEXT, so no schema change is required. These let the
  // product layer audit template/version/run/approval/delivery actions through
  // the same append-only, sanitized audit log (no second audit model).
  "automation_template_created",
  "automation_template_archived",
  "automation_version_published",
  "automation_run_created",
  "automation_run_cancelled",
  "automation_run_failed",
  "automation_run_completed",
  "automation_approval_requested",
  "automation_approval_approved",
  "automation_approval_rejected",
  "automation_delivery_completed",
  // Phase 2B: operational recovery. Additive (TEXT-persisted type).
  "automation_recovery_scan",
  // Phase 2C: integration lifecycle. Additive (TEXT-persisted type). Every
  // important integration lifecycle action produces a durable audit record;
  // secrets are stripped by sanitizeMetadata before write.
  "integration_connected",
  "integration_disconnected",
  "integration_revoked",
  "integration_rotated",
  "integration_credential_refreshed",
  "webhook_accepted",
  "webhook_rejected",
  "external_mutation",
  "provider_failure",
  "byok_usage",
  // Phase 2D: connected-product lifecycle. Additive (TEXT-persisted type).
  // OAuth authorization attempts, connection activation/degradation, trigger
  // dispatch, and model connection activation all emit durable, sanitized
  // audit records. No secrets ever appear (sanitizeMetadata strips them).
  "authorization_started",
  "authorization_verified",
  "connection_activated",
  "connection_degraded",
  "connection_refreshed",
  "connection_revoked",
  "connection_disconnected",
  "callback_rejected",
  "trigger_dispatched",
  "trigger_rejected",
  "trigger_dead_lettered",
  "model_connection_activated",
  "model_connection_deactivated",
  // Phase 2E: production reliability + operational telemetry. Additive
  // (TEXT-persisted type). Every reliability lifecycle action emits a durable,
  // sanitized audit record; secrets are stripped by sanitizeMetadata before
  // write. These cover leases, retries, dead-letters, redrives, reconciliation,
  // capacity/backpressure, cancellation, timeouts, and terminal settlement.
  "lease_acquired",
  "lease_renewed",
  "lease_expired",
  "lease_lost",
  "retry_scheduled",
  "retry_attempted",
  "retry_exhausted",
  "work_dead_lettered",
  "work_redriven",
  "reconciliation_detected",
  "reconciliation_recovered",
  "capacity_admitted",
  "capacity_released",
  "capacity_reclaimed",
  "work_cancelled",
  "work_timed_out",
  "work_terminal",
  // Phase 2F: durable metering, immutable usage ledger, cost attribution &
  // B2B usage governance. Additive (TEXT-persisted type). Significant
  // administrative usage-accounting actions emit durable, sanitized records;
  // high-volume token events belong in the usage ledger, NOT the audit log
  // (audit is not a replacement for the usage ledger).
  "usage_reconciliation_requested",
  "usage_reconciliation_completed",
  "usage_drift_detected",
  "usage_adjustment_committed",
  "usage_limit_changed",
  "usage_export_requested",
  // Phase 2G: B2B identity & tenant security hardening. Additive
  // (TEXT-persisted type). Security-sensitive authentication/session/
  // membership/service-identity actions emit durable, sanitized records;
  // secrets are stripped by sanitizeMetadata before write. These names are
  // exact — emitted by vaulltcore-auth / phase2g-routes.
  "authentication_failed",
  "session_revoked",
  "user_identity_disabled",
  "member_added",
  "member_removed",
  "member_role_changed",
  "service_identity_created",
  "service_identity_disabled",
  "service_identity_revoked",
  "machine_credential_issued",
  "machine_credential_revoked",
] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

/** Immutable actor identity recorded on every audit event. */
export interface AuditActor {
  readonly principalId: string
  readonly kind: string
  readonly tenantId: string
}

export interface AuditEvent {
  readonly eventId: string
  readonly actor: AuditActor | null
  readonly tenantId: string | null
  readonly orgId: string | null
  readonly projectId: string | null
  readonly type: AuditEventType
  readonly timestamp: number
  /** Sanitized metadata; secrets already stripped. */
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface AuditInput {
  readonly actor?: AuditActor | null
  readonly scope?: { tenantId?: string; orgId?: string; projectId?: string } | null
  readonly type: AuditEventType
  readonly metadata?: Record<string, unknown>
}
