/**
 * Phase 1D distributed-control-plane contracts: dispatcher, worker identity,
 * lease renewal, worker-loss recovery, and snapshot lifecycle.
 *
 * These types are engine-agnostic and store-agnostic, like the rest of the
 * neutral runner package. They let a control plane enqueue work, a worker claim
 * it, and a supervisor reconcile worker loss — without the runner owning any
 * particular queue technology or process topology.
 *
 * Hard rule preserved from Phase 1A–1C: exactly one authoritative active owner
 * may advance a job; every mutation is fenced by the ownership generation. Lease
 * renewal is itself fenced — a stale worker waking up after a partition can
 * never reclaim authority merely because it still has the old job in memory.
 */

import type { JobIdentity } from "./contracts"

// ---------------------------------------------------------------------------
// Worker identity
// ---------------------------------------------------------------------------

/**
 * Stable identity for an execution worker over its lifetime. The workerId is
 * durable (a supervisor can list known workers); the bootToken changes per
 * process start so a reincarnated worker is distinguishable from a zombie.
 */
export interface WorkerIdentity {
  readonly workerId: string
  /** Unique per process incarnation; rotates on worker restart. */
  readonly bootToken: string
  /** Human label for ops/dashboards; never used for correctness. */
  readonly label?: string
}

/** A liveness heartbeat from a worker, with the leases it currently holds. */
export interface WorkerHeartbeat {
  readonly worker: WorkerIdentity
  readonly at: number
  /** Job ids this worker reports as actively executing. */
  readonly activeJobs: readonly string[]
}

/** Result of a fenced lease renewal attempt. */
export type LeaseRenewalResult =
  | { readonly renewed: true; readonly expiresAt: number }
  | { readonly renewed: false; readonly reason: "fenced" | "not_found" }
  | { readonly renewed: false; readonly reason: "expired"; readonly expiresAt: number }

/** A worker's lease over a job, as the supervisor understands it. */
export interface WorkerLease {
  readonly jobId: string
  readonly worker: WorkerIdentity
  readonly generation: number
  readonly token: string
  readonly expiresAt: number
  readonly lastHeartbeatAt: number
}

/** Classification of a lease relative to `now`. */
export type LeaseExpiry =
  | { readonly state: "live"; readonly expiresAt: number }
  | { readonly state: "expiring"; readonly expiresAt: number }
  | { readonly state: "expired"; readonly expiresAt: number }

// ---------------------------------------------------------------------------
// Job dispatcher seam
// ---------------------------------------------------------------------------

/**
 * Neutral dispatch boundary. The control plane enqueues durable jobs; a worker
 * claims the next available job and acknowledges ownership. The dispatcher
 * decides WHERE work goes; the runner decides HOW work executes. That
 * separation is mandatory — no queue technology is embedded in the runner.
 *
 * All claim/acknowledge/heartbeat/release operations are fenced: a claim
 * acquires (or steals, when expired) the job lease; subsequent operations carry
 * the worker's generation/token so a stale worker cannot advance a job a newer
 * owner has taken.
 */
export interface JobDispatcher {
  /** Make a durable job available for claiming. Idempotent per job. */
  enqueue(jobId: string): Promise<void>
  /**
   * Claim the next available job for a worker. Resolves to null when no job is
   * available. The returned grant carries the fenced ownership generation +
   * token the worker must present on every subsequent operation. `leaseMs`
   * sets the initial lease duration; fenced lease renewal (heartbeat) keeps it
   * alive.
   */
  claim(worker: WorkerIdentity, leaseMs: number): Promise<DispatchClaim | null>
  /**
   * Acknowledge that the worker has started processing a claimed job. Fenced:
   * only the claim holder may acknowledge.
   */
  acknowledge(claim: DispatchClaim): Promise<void>
  /**
   * Renew the worker's lease on a job. Fenced: a stale generation/token cannot
   * renew. This is the heartbeat durability path — renewal must itself be
   * fenced so a stale worker cannot reclaim authority.
   */
  heartbeat(claim: DispatchClaim, leaseMs: number): Promise<LeaseRenewalResult>
  /**
   * Release ownership (job reached a terminal state or the worker is stepping
   * down gracefully). Fenced: a stale token is a no-op.
   */
  release(claim: DispatchClaim): Promise<void>
}

/** A claimed job grant returned by {@link JobDispatcher.claim}. */
export interface DispatchClaim {
  readonly jobId: string
  readonly worker: WorkerIdentity
  /** Fenced ownership generation (attempt). */
  readonly generation: number
  /** Fencing token the worker must present on every mutation. */
  readonly token: string
  readonly expiresAt: number
}

// ---------------------------------------------------------------------------
// Worker-loss recovery (supervisor/reconciler)
// ---------------------------------------------------------------------------

/**
 * Why a job became recovery-eligible. All reasons are explicit; transient
 * worker loss is never silently mapped to `failed`.
 */
export type RecoveryEligibilityReason =
  | "worker_loss"
  | "lease_expired"
  | "orphaned"
  | "worker_unavailable"

/** A job the reconciler identified as needing recovery. */
export interface RecoveryCandidate {
  readonly jobId: string
  readonly reason: RecoveryEligibilityReason
  /** Last known worker/lease, when one was recorded. */
  readonly lease: WorkerLease | null
}

// ---------------------------------------------------------------------------
// Snapshot lifecycle (Phase 1D)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a captured recovery artifact. A snapshot is always an
 * optimization — the durable checkpoint + event log stay authoritative — but
 * the lifecycle is tracked so garbage collection never deletes the last valid
 * recovery artifact before its replacement is durably committed.
 */
export const SNAPSHOT_LIFECYCLE_STATES = [
  "created",
  "active",
  "superseded",
  "expired",
  "deleting",
  "deleted",
  "failed",
] as const

export type SnapshotLifecycleState = (typeof SNAPSHOT_LIFECYCLE_STATES)[number]

export const ACTIVE_SNAPSHOT_STATES: ReadonlySet<SnapshotLifecycleState> = new Set(["created", "active"])

/** Durable record of a captured snapshot's lifecycle + provenance. */
export interface SnapshotRecord {
  readonly snapshotId: string
  readonly tenantId: string
  readonly jobId: string
  /** Storage pointer kind (vendor-neutral; matches ExecutionSnapshot.storage.kind). */
  readonly provider: string
  /** Bytes, when known (null when the provider does not report size). */
  readonly sizeBytes: number | null
  readonly createdAt: number
  /** When the snapshot becomes eligible for GC. Null ⇒ never auto-expire. */
  readonly expiresAt: number | null
  /** Integrity hash carried by the ExecutionSnapshot (sha256). */
  readonly integrityHash: string
  /** Ownership generation under which the snapshot was captured. */
  readonly attempt: number
  state: SnapshotLifecycleState
  /** Set when state transitioned to superseded/deleted/failed, for audit. */
  supersededBy: string | null
  updatedAt: number
}

/** Conservative GC decision for a set of snapshot records. */
export interface SnapshotGcDecision {
  readonly deletable: readonly SnapshotRecord[]
  readonly retained: readonly SnapshotRecord[]
  /** Sanitized reason per snapshot id (no prompts/secrets). */
  readonly reasons: ReadonlyMap<string, string>
}

// ---------------------------------------------------------------------------
// Idempotency (Phase 1D durable SQL idempotency)
// ---------------------------------------------------------------------------

/**
 * A claimed idempotency slot. The control plane reserves the (tenantId, key)
 * composite atomically before creating a job, so a crash after job creation
 * cannot produce a duplicate job on retry.
 */
export interface IdempotencyClaim {
  readonly tenantId: string
  readonly key: string
  /** SHA-256 over the canonical request body; a changed request is a conflict. */
  readonly requestHash: string
}

export type IdempotencyClaimResult =
  /** No prior record: the caller owns this slot and must fulfill it. */
  | { readonly kind: "new"; readonly slotId: string }
  /** Prior record with the same request hash and a fulfilled job: return it. */
  | { readonly kind: "fulfilled"; readonly jobId: string; readonly responseStatus: number }
  /**
   * Prior record with the same request hash but not yet fulfilled (the creator
   * crashed mid-create). Same request ⇒ safe to re-attempt; the caller re-runs
   * job creation and fulfills the same slot.
   */
  | { readonly kind: "pending"; readonly slotId: string }
  /** Prior record with a different request hash: explicit conflict. */
  | { readonly kind: "conflict"; readonly jobId: string | null; readonly detail: string }

/** A durable idempotency record (read model). */
export interface IdempotencyRecord {
  readonly tenantId: string
  readonly key: string
  readonly requestHash: string
  readonly jobId: string | null
  readonly responseStatus: number | null
  readonly createdAt: number
  readonly expiresAt: number | null
}

/**
 * Neutral idempotency registry seam. The control plane speaks this; the
 * implementation (in-memory for tests, SQL for production) lives behind it.
 *
 * Hard invariant: claim must atomically reserve (tenantId, key) — UNIQUE on
 * (tenantId, key). Same tenant + same key + same request hash returns the
 * original job; a different request is an explicit conflict. Different tenants
 * may use identical keys without collision.
 */
export interface IdempotencyRegistry {
  /**
   * Reserve the (tenantId, key) slot. Returns:
   * - `new`: caller owns the slot, must {@link fulfill} it with the created job.
   * - `fulfilled`: a prior identical request already produced a job — return it.
   * - `pending`: prior identical request is mid-create (creator crashed);
   *   caller may re-attempt and fulfill the same slot.
   * - `conflict`: prior record exists with a different request hash.
   */
  claim(claim: IdempotencyClaim): IdempotencyClaimResult | Promise<IdempotencyClaimResult>
  /** Record the job produced for a previously-claimed slot. */
  fulfill(slotId: string, jobId: string, responseStatus: number): void | Promise<void>
  /** Read a record (read model). */
  get(tenantId: string, key: string): IdempotencyRecord | null | Promise<IdempotencyRecord | null>
  /** Read the fulfilled job + status for a slot (read model). */
  lookup(tenantId: string, key: string): { jobId: string; responseStatus: number | null } | null | Promise<{ jobId: string; responseStatus: number | null } | null>
  /** Delete a slot (admin/cleanup). */
  delete(tenantId: string, key: string): void | Promise<void>
}

/**
 * Neutral snapshot lifecycle registry seam. Tracks {@link SnapshotRecord}s and
 * decides conservative GC: never delete the last valid recovery artifact
 * before its replacement is durably committed.
 */
export interface SnapshotRegistry {
  /** Register a newly captured snapshot (state created). */
  register(record: Omit<SnapshotRecord, "state" | "supersededBy" | "updatedAt">): SnapshotRecord | Promise<SnapshotRecord>
  /** Promote a created snapshot to active. */
  activate(snapshotId: string): SnapshotRecord | null | Promise<SnapshotRecord | null>
  /** Mark a snapshot superseded by a newer one (the replacement must already be durable). */
  supersede(snapshotId: string, bySnapshotId: string): SnapshotRecord | null | Promise<SnapshotRecord | null>
  /** Read the latest active snapshot for a job, or null. */
  latestForJob(jobId: string): SnapshotRecord | null | Promise<SnapshotRecord | null>
  /** List all snapshots for a job (newest first). */
  listForJob(jobId: string): readonly SnapshotRecord[] | Promise<readonly SnapshotRecord[]>
  /** Compute a conservative GC decision. */
  gcDecision(now?: number): SnapshotGcDecision | Promise<SnapshotGcDecision>
  /** Apply a GC decision: mark deletable snapshots deleting/deleted. */
  applyGc(decision: SnapshotGcDecision): void | Promise<void>
}

/** Phantom import to keep {@link JobIdentity} in the module graph for doc refs. */
export type { JobIdentity }
