/**
 * Human approval gates (Phase 2A).
 *
 * A first-class {@link ApprovalRequest} with an immutable run/version identity.
 * States: pending → {approved | rejected | changes_requested | expired}.
 *
 * Decisions are idempotent: once terminally decided the request cannot change,
 * and two concurrent approvers cannot produce contradictory terminal decisions
 * — the store's fenced, atomic decision (conditional UPDATE on
 * `approvalVersion` + status='pending') serializes to exactly one terminal
 * outcome; a concurrent second decision observes the already-terminal request
 * and returns it unchanged. A run awaiting approval cannot continue execution or
 * delivery until a valid `approved` decision permits it.
 *
 * Approver authorization reuses the existing identity layer (no second auth
 * model): the principal must hold the version's `minApproverRole` within the
 * run's org. Decision metadata is sanitized.
 */

import {
  type ApprovalRequest,
  type ApprovalStatus,
  AutomationError,
} from "./contracts"
import { newApprovalId } from "./ids"
import { sanitizeMetadata } from "@vaulltcore/audit"
import { ROLE_RANK } from "@vaulltcore/identity"

export class IllegalApprovalTransitionError extends AutomationError {
  constructor(approvalId: string, from: ApprovalStatus, to: ApprovalStatus) {
    super("ILLEGAL_APPROVAL_TRANSITION", `Approval ${approvalId} cannot transition ${from} → ${to}`, 409)
  }
}

export class ApprovalAlreadyDecidedError extends AutomationError {
  constructor(approvalId: string, status: ApprovalStatus) {
    super("APPROVAL_ALREADY_DECIDED", `Approval ${approvalId} is already ${status}`, 409)
  }
}

export class ApprovalFencedError extends AutomationError {
  constructor(approvalId: string) {
    super("APPROVAL_FENCED", `Approval ${approvalId} is owned by a newer version`, 409)
  }
}

/** A pending request may move to any terminal decision, or expire. A terminal
 *  request may not change. */
export function canDecide(from: ApprovalStatus, to: ApprovalStatus): boolean {
  if (from !== "pending") return false
  return to === "approved" || to === "rejected" || to === "changes_requested" || to === "expired"
}

/** The decision an approver may record. */
export type ApprovalDecision = "approved" | "rejected" | "changes_requested"

/** Build a fresh pending approval request. */
export function buildApprovalRequest(args: {
  readonly runId: string
  readonly versionId: string
  readonly gateId: string
  readonly minApproverRole: ApprovalRequest["minApproverRole"]
  readonly contextArtifacts: readonly string[]
  readonly expiresAfterMs?: number | null
  readonly now?: number
}): ApprovalRequest {
  const now = args.now ?? Date.now()
  return {
    approvalId: newApprovalId(),
    runId: args.runId,
    versionId: args.versionId,
    gateId: args.gateId,
    status: "pending",
    minApproverRole: args.minApproverRole,
    contextArtifacts: [...args.contextArtifacts],
    createdAt: now,
    expiresAt: args.expiresAfterMs ? now + args.expiresAfterMs : null,
    decisionActor: null,
    decisionTime: null,
    decisionMetadata: null,
    approvalVersion: 1,
  }
}

/** Whether a request is expired by wall-clock time (still pending but past
 *  expiresAt). The store uses this to atomically expire. */
export function isExpired(req: ApprovalRequest, now = Date.now()): boolean {
  return req.status === "pending" && req.expiresAt !== null && req.expiresAt <= now
}

/** Authorize an approver against the request's minimum role. Throws on denial.
 *  Reuses the identity layer's role ranking. */
export function authorizeApprover(req: ApprovalRequest, principalRole: string): void {
  const required = ROLE_RANK[req.minApproverRole as keyof typeof ROLE_RANK] ?? 0
  const have = ROLE_RANK[principalRole as keyof typeof ROLE_RANK] ?? 0
  if (have < required) {
    throw new AutomationError("FORBIDDEN_APPROVER_ROLE", `Approver role "${principalRole}" is below required "${req.minApproverRole}"`, 403)
  }
}

/** Apply a decision to a request record (returns updated record). Does NOT
 *  mutate the input; the store performs the fenced persist. Sanitizes metadata. */
export function applyDecision(
  req: ApprovalRequest,
  decision: ApprovalDecision,
  actor: { readonly principalId: string; readonly kind: string },
  metadata?: Record<string, unknown>,
  now?: number,
): ApprovalRequest {
  if (!canDecide(req.status, decision)) {
    throw new IllegalApprovalTransitionError(req.approvalId, req.status, decision)
  }
  const ts = now ?? Date.now()
  return {
    ...req,
    status: decision,
    decisionActor: actor,
    decisionTime: ts,
    decisionMetadata: sanitizeMetadata(metadata ?? {}),
    approvalVersion: req.approvalVersion + 1,
  }
}

/** Apply an expiry transition (terminal). Used by the store's atomic expire. */
export function applyExpiry(req: ApprovalRequest, now = Date.now()): ApprovalRequest {
  if (!canDecide(req.status, "expired")) {
    throw new IllegalApprovalTransitionError(req.approvalId, req.status, "expired")
  }
  return {
    ...req,
    status: "expired",
    decisionTime: now,
    approvalVersion: req.approvalVersion + 1,
  }
}
