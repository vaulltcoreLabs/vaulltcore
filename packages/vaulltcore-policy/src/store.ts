/**
 * SQL-backed policy store + deterministic evaluator (Phase 1E).
 *
 * Policies are versioned and durable. Evaluation is pure and deterministic:
 * the same request + active policy yields the same decision (no interactive
 * permission flows — those are explicitly NOT restored). The store records
 * policy creation/changes so the audit layer can attribute them.
 */

import { SqlStoreBase, isUniqueViolation, type Migration, type SqlDialect, type SqlDatabase } from "@vaulltcore/store-sql"
import {
  DEFAULT_ADMISSION_POLICY,
  type AdmissionDecision,
  type AdmissionPolicy,
  type AdmissionRequest,
  PolicyError,
} from "./contracts"

export const POLICY_MIGRATIONS: readonly Migration[] = [
  {
    version: 3,
    name: "admission_policy",
    statements: [
      `CREATE TABLE admission_policies (
        policy_id      TEXT NOT NULL,
        tenant_id      TEXT NOT NULL,
        org_id         TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        definition     TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        active         INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (tenant_id, org_id, project_id, policy_id)
      )`,
      `CREATE UNIQUE INDEX admission_policy_active_idx ON admission_policies (tenant_id, org_id, project_id) WHERE active = 1`,
    ],
  },
]

interface PolicyRow {
  policy_id: string
  tenant_id: string
  org_id: string
  project_id: string
  policy_version: string
  definition: string
  created_at: number
  active: number
}

export interface PolicyStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlPolicyStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: PolicyStoreOptions = {}) {
    super(db, POLICY_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
  }

  private rowToPolicy(row: PolicyRow): AdmissionPolicy {
    return JSON.parse(row.definition) as AdmissionPolicy
  }

  /** Create a new (or superseding) policy. Setting `active` deactivates the
   * previous active policy for the scope in the same transaction. */
  async createPolicy(scope: { tenantId: string; orgId: string; projectId: string }, policy: AdmissionPolicy, active = true): Promise<AdmissionPolicy> {
    const now = Date.now()
    this.atomic("createPolicy", () => {
      if (active) {
        this.prepare("UPDATE admission_policies SET active = 0 WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND active = 1").run(
          scope.tenantId,
          scope.orgId,
          scope.projectId,
        )
      }
      try {
        this.prepare(
          "INSERT INTO admission_policies (policy_id, tenant_id, org_id, project_id, policy_version, definition, created_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(policy.policyId, scope.tenantId, scope.orgId, scope.projectId, policy.policyVersion, JSON.stringify(policy), now, active ? 1 : 0)
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new PolicyError("POLICY_EXISTS", `Policy ${policy.policyId} already exists for scope`)
        }
        throw error
      }
    })
    return policy
  }

  /** Read the currently-active policy for a scope, falling back to the default. */
  async getActivePolicy(scope: { tenantId: string; orgId: string; projectId: string }): Promise<AdmissionPolicy> {
    const row = this.prepare("SELECT * FROM admission_policies WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND active = 1").get(
      scope.tenantId,
      scope.orgId,
      scope.projectId,
    ) as unknown as PolicyRow | undefined
    return row ? this.rowToPolicy(row) : { ...DEFAULT_ADMISSION_POLICY }
  }

  /** Historical lookup (a job pins its policy; this is for audit/inspection). */
  async getPolicy(scope: { tenantId: string; orgId: string; projectId: string }, policyId: string): Promise<AdmissionPolicy | null> {
    const row = this.prepare("SELECT * FROM admission_policies WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND policy_id = ?").get(
      scope.tenantId,
      scope.orgId,
      scope.projectId,
      policyId,
    ) as unknown as PolicyRow | undefined
    return row ? this.rowToPolicy(row) : null
  }

  /**
   * Deterministically evaluate an admission request against the active policy.
   * Returns an immutable {@link AdmissionDecision}. Denials are returned as
   * `allowed: false` (with a reasonCode) rather than thrown — the caller
   * decides whether to reject the request, and the decision is auditable.
   *
   * Programmatic decisions remain deterministic: no interactive prompts.
   */
  async evaluate(scope: { tenantId: string; orgId: string; projectId: string }, request: AdmissionRequest): Promise<AdmissionDecision> {
    const policy = await this.getActivePolicy(scope)
    const deniedTools = request.requestedTools.filter((tool) => !policy.allowedTools.includes(tool))
    if (deniedTools.length > 0) {
      return deny(policy, "POLICY_TOOL_NOT_ALLOWED", `tools not permitted by policy: ${deniedTools.join(", ")}`)
    }
    if (policy.maxSteps <= 0) return deny(policy, "POLICY_MAX_STEPS_ZERO", "policy allows zero steps")
    if (request.requestedMaxSteps !== undefined && request.requestedMaxSteps > policy.maxSteps) {
      return deny(policy, "POLICY_MAX_STEPS_EXCEEDED", `requested ${request.requestedMaxSteps} steps exceeds policy max ${policy.maxSteps}`)
    }
    if (request.requestedAllowSnapshots === true && !policy.allowSnapshots) {
      return deny(policy, "POLICY_SNAPSHOTS_FORBIDDEN", "policy forbids snapshots")
    }
    return allow(policy)
  }

  /** Evaluate using an explicitly-provided policy (no DB read). Deterministic. */
  static evaluateWith(policy: AdmissionPolicy, request: AdmissionRequest): AdmissionDecision {
    const deniedTools = request.requestedTools.filter((tool) => !policy.allowedTools.includes(tool))
    if (deniedTools.length > 0) return deny(policy, "POLICY_TOOL_NOT_ALLOWED", `tools not permitted by policy: ${deniedTools.join(", ")}`)
    if (policy.maxSteps <= 0) return deny(policy, "POLICY_MAX_STEPS_ZERO", "policy allows zero steps")
    if (request.requestedMaxSteps !== undefined && request.requestedMaxSteps > policy.maxSteps) {
      return deny(policy, "POLICY_MAX_STEPS_EXCEEDED", `requested ${request.requestedMaxSteps} steps exceeds policy max ${policy.maxSteps}`)
    }
    if (request.requestedAllowSnapshots === true && !policy.allowSnapshots) {
      return deny(policy, "POLICY_SNAPSHOTS_FORBIDDEN", "policy forbids snapshots")
    }
    return allow(policy)
  }
}

function allow(policy: AdmissionPolicy): AdmissionDecision {
  return {
    allowed: true,
    reasonCode: "OK",
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    maxSteps: policy.maxSteps,
    maxTokens: policy.maxTokens,
    maxDurationMs: policy.maxDurationMs,
    maxConcurrentJobs: policy.maxConcurrentJobs,
    allowedTools: [...policy.allowedTools],
    egressAllowlist: [...policy.egressAllowlist],
    allowSnapshots: policy.allowSnapshots,
  }
}

function deny(policy: AdmissionPolicy, reasonCode: string, _message: string): AdmissionDecision {
  return {
    allowed: false,
    reasonCode,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    maxSteps: policy.maxSteps,
    maxTokens: policy.maxTokens,
    maxDurationMs: policy.maxDurationMs,
    maxConcurrentJobs: policy.maxConcurrentJobs,
    allowedTools: [...policy.allowedTools],
    egressAllowlist: [...policy.egressAllowlist],
    allowSnapshots: policy.allowSnapshots,
  }
}
