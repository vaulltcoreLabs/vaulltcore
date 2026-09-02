/**
 * Shared business-layer test fixture: a single in-memory SQLite database with
 * all Phase 1E stores wired together, plus a seeded tenant/org/project and an
 * active API key.
 */

import { NodeSqliteDatabase } from "@vaulltcore/store-sql"
import { SqlIdentityStore } from "@vaulltcore/identity"
import { DEFAULT_ADMISSION_POLICY, SqlPolicyStore } from "@vaulltcore/policy"
import { SqlQuotaStore } from "@vaulltcore/quota"
import { SqlMeteringStore } from "@vaulltcore/metering"
import { DEFAULT_PRICING, SqlBillingStore } from "@vaulltcore/billing"
import { SqlAuditStore } from "@vaulltcore/audit"

export interface BusinessFixture {
  readonly db: NodeSqliteDatabase
  readonly identity: SqlIdentityStore
  readonly policy: SqlPolicyStore
  readonly quota: SqlQuotaStore
  readonly metering: SqlMeteringStore
  readonly billing: SqlBillingStore
  readonly audit: SqlAuditStore
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly principalId: string
  /** Active API key secret for the seeded principal (owner role). */
  readonly apiKeySecret: string
  readonly apiKeyId: string
}

export async function seedFixture(overrides: { tenantId?: string; orgId?: string; projectId?: string; principalId?: string } = {}): Promise<BusinessFixture> {
  const db = NodeSqliteDatabase.memory()
  const identity = new SqlIdentityStore(db)
  const policy = new SqlPolicyStore(db)
  const quota = new SqlQuotaStore(db)
  const metering = new SqlMeteringStore(db)
  const billing = new SqlBillingStore(db)
  const audit = new SqlAuditStore(db)

  const tenantId = overrides.tenantId ?? "t-acme"
  const orgId = overrides.orgId ?? "org-acme"
  const projectId = overrides.projectId ?? "proj-alpha"
  const principalId = overrides.principalId ?? "p-owner"

  await identity.createTenant(tenantId, "system", "Acme")
  await identity.createOrganization(tenantId, orgId, "Acme Engineering")
  await identity.createProject(tenantId, orgId, projectId, "Alpha")
  await identity.registerPrincipal(tenantId, principalId, "service_account")
  await identity.addMember(tenantId, orgId, principalId, "owner")
  await identity.grantProject(tenantId, orgId, projectId, principalId, "owner")
  const key = await identity.createApiKey(tenantId, orgId, principalId, "test-key")
  await policy.createPolicy({ tenantId, orgId, projectId }, { ...DEFAULT_ADMISSION_POLICY, allowedTools: ["noop", "read_file"] })
  await billing.createPricingVersion(DEFAULT_PRICING)

  return {
    db,
    identity,
    policy,
    quota,
    metering,
    billing,
    audit,
    tenantId,
    orgId,
    projectId,
    principalId,
    apiKeySecret: key.secret,
    apiKeyId: key.keyId,
  }
}

/** Default quota limits derived from the default policy. */
export const DEFAULT_LIMITS = {
  maxConcurrentJobs: 2,
  jobsPerPeriod: 100,
  periodMs: 3_600_000,
  maxTokens: 250_000,
  maxDurationMs: 3_600_000,
}
