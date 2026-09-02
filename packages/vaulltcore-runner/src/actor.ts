/**
 * ExecutionActorController — Vaulltcore-owned actor lifecycle coordinator.
 *
 * Concepts adapted from Google AX (`internal/ate` actor lifecycle and the
 * single-writer contract in `internal/harness`, Apache-2.0, commit
 * 703a79f2a55def5be183ad7bd54da7c38cc22cc5), hardened with Vaulltcore
 * durable ownership: exactly one active execution owner may advance a job;
 * every mutation is fenced by the ownership generation/token. The controller
 * knows only the neutral AgentEngine/ExecutionEnvironment seams — never
 * OpenCode internals — so engines and compute providers are replaceable.
 */

import {
  AgentEngine,
  ActorHandle,
  ExecutionActorController,
  ExecutionCapabilities,
  ExecutionEnvironment,
  ExecutionPolicy,
  ExecutionSnapshot,
  FULL_EXECUTION_CAPABILITIES,
  JobCheckpoint,
  JobRecord,
  JobState,
  JobStatus,
  RecoveryContext,
  SuspensionReason,
  WorkspaceHandle,
  WorkspaceProvider,
  isTerminal,
} from "./contracts"
import { newLeaseToken } from "./ids"
import { validateCheckpoint } from "./checkpoint"
import { SimulatedCrashError } from "./engine"
import { InvalidJobStateError, JobNotFoundError, VaulltcoreError } from "./errors"
import type { SnapshotFacts, SnapshotPolicy } from "./snapshot-policy"
import type { OwnershipGrant } from "./contracts"
import type { DurableJobStore } from "./store"

export interface ActorControllerDeps {
  readonly store: DurableJobStore
  readonly environment: ExecutionEnvironment | null
  /** Phase 1A legacy workspace fallback (used only when no environment is set). */
  readonly workspace: WorkspaceProvider | null
  readonly resolveEngine: (record: JobRecord) => AgentEngine
  readonly resolvePolicy: (record: JobRecord) => ExecutionPolicy
  readonly toJobState: (record: JobRecord) => Promise<JobState>
  /**
   * Phase 1C cost-aware snapshot policy (optional). Consulted at suspension
   * boundaries only; advisory — checkpoint durability is never affected by
   * any decision. When absent, environments snapshot on every suspend
   * (Phase 1B behavior) as long as they report native snapshot capability.
   */
  readonly snapshotPolicy?: SnapshotPolicy
}

export class ExecutionActorControllerImpl implements ExecutionActorController {
  constructor(private readonly deps: ActorControllerDeps) {}

  // --------------------------------------------------------------------------
  // Ownership
  // --------------------------------------------------------------------------

  async acquire(jobId: string): Promise<ActorHandle> {
    const record = await this.requireRecord(jobId)
    if (isTerminal(record.status)) throw new InvalidJobStateError(jobId, record.status, "acquire execution ownership of")
    const policy = this.deps.resolvePolicy(record)
    const grant = await this.deps.store.acquireLease(jobId, newLeaseToken(), policy.leaseMs)
    const ownership: OwnershipGrant = { jobId, generation: grant.attempt, token: grant.leaseToken, expiresAt: grant.leaseExpiresAt }
    const fresh = (await this.requireRecord(jobId)) as JobRecord
    return { jobId, ownership, record: fresh }
  }

  async start(handle: ActorHandle): Promise<JobRecord> {
    return this.deps.store.updateJobRecord(handle.jobId, handle.ownership.generation, () => ({ status: "preparing" as JobStatus }))
  }

  async release(handle: ActorHandle): Promise<void> {
    await this.deps.store.releaseLease?.(handle.jobId, handle.ownership.token)
  }

  // --------------------------------------------------------------------------
  // Suspension (first-class, never an error)
  // --------------------------------------------------------------------------

  async suspend(handle: ActorHandle, reason: SuspensionReason = "worker_loss"): Promise<JobState> {
    const record = await this.requireRecord(handle.jobId)
    if (isTerminal(record.status)) return this.deps.toJobState(record)

    let snapshot: ExecutionSnapshot | null = null
    if (this.deps.environment) {
      // Reattach to the job-bound workspace deterministically (fresh process
      // suspending a dead worker's job finds the same bound directory).
      const environment = this.deps.environment
      const workspace = await environment.create(handle.jobId)
      const capabilities = await this.capabilitiesOf(environment)

      // Cost-aware capture decision (Phase 1C). Advisory only: the durable
      // checkpoint written at commit boundaries is unaffected either way.
      const decision = this.deps.snapshotPolicy
        ? this.deps.snapshotPolicy.decide(
            this.snapshotFacts(record, await this.deps.store.getCheckpoint(handle.jobId), capabilities, reason),
          )
        : null
      if (decision) {
        await this.deps.store.appendEvents(
          handle.jobId,
          [
            {
              jobId: handle.jobId,
              timestamp: Date.now(),
              type: "warning",
              data: { reason: "snapshot_decision", detail: decision.reason, decision: decision.decision },
            },
          ],
          record.attempt,
        )
      }

      const capture = decision ? decision.decision === "snapshot_now" : capabilities.nativeSnapshot
      if (capture) {
        snapshot = await environment.snapshot(workspace, {
          jobId: handle.jobId,
          attempt: record.attempt,
          engineVersion: this.deps.resolveEngine(record).version,
        })
        if (snapshot) {
          // Persist the reference durably BEFORE parking the job.
          await this.deps.store.updateJobRecord(handle.jobId, record.attempt, () => ({ latestSnapshot: snapshot }))
        } else {
          await this.reportSnapshotUnsupported(handle.jobId, record.attempt, "environment returned no snapshot (explicit unsupported capture)")
        }
      } else if (!decision) {
        // No policy configured but the environment declared no native
        // snapshot capability: explicit fallback, never pretend.
        await this.reportSnapshotUnsupported(handle.jobId, record.attempt, "environment reports no native snapshot capability")
      }
      if (!capabilities.nativeSuspend) {
        throw new VaulltcoreError(
          "CAPABILITY_UNSUPPORTED",
          `Environment ${environment.environmentVersion} cannot natively suspend; compute left running for job ${handle.jobId}`,
        )
      }
      await environment.suspend(workspace)
    }

    await this.deps.store.appendEvents(
      handle.jobId,
      [
        {
          jobId: handle.jobId,
          timestamp: Date.now(),
          type: "warning",
          data: { reason: "suspended", detail: reason, snapshotId: snapshot?.snapshotId ?? null },
        },
      ],
      record.attempt,
    )
    const next = await this.deps.store.updateJobRecord(handle.jobId, record.attempt, () => ({
      status: "suspended" as JobStatus,
      leaseToken: null,
      leaseExpiresAt: null,
    }))
    return this.deps.toJobState(next)
  }

  // --------------------------------------------------------------------------
  // Recovery algorithm
  // --------------------------------------------------------------------------

  /** Worker-loss entry point; identical algorithm, distinct audit semantics. */
  async recover(jobId: string): Promise<RecoveryContext> {
    return this.proceed("recover", jobId)
  }

  /** Explicit resume entry point. */
  async resume(jobId: string): Promise<RecoveryContext> {
    return this.proceed("resume", jobId)
  }

  /**
   * Deterministic recovery:
   * validate → fence → checkpoint → events → workspace → snapshot → proceed.
   * Invalid continuation parks safely; the checkpoint/event log (never the
   * snapshot) is authoritative.
   */
  private async proceed(_mode: "recover" | "resume", jobId: string): Promise<RecoveryContext> {
    const record = await this.requireRecord(jobId)
    if (isTerminal(record.status)) throw new InvalidJobStateError(jobId, record.status, "recover")
    if (record.leaseToken && record.leaseExpiresAt && record.leaseExpiresAt > Date.now()) {
      throw new VaulltcoreError("LEASE_HELD", `Job ${jobId} is actively leased`)
    }
    const policy = this.deps.resolvePolicy(record)
    const engine = this.deps.resolveEngine(record)
    const handle = await this.acquire(jobId)
    try {
      return await this.proceedValidated(jobId, record, policy, engine, handle)
    } catch (error) {
      if (error instanceof SimulatedCrashError) throw error
      // Invalid continuation parks safely; ownership is released so a later
      // recovery attempt can pick the job up once the issue is resolved.
      await this.deps.store.releaseLease?.(jobId, handle.ownership.token).catch(() => {})
      await this.deps.store
        .updateJobRecord(jobId, handle.ownership.generation, () => ({ status: "suspended" as JobStatus, error: (error as Error).message }))
        .catch(() => {})
      throw error
    }
  }

  private async proceedValidated(
    jobId: string,
    record: JobRecord,
    policy: ExecutionPolicy,
    engine: AgentEngine,
    handle: ActorHandle,
  ): Promise<RecoveryContext> {
    await this.setStatus(handle, "resuming")

    const checkpoint = await this.deps.store.getCheckpoint(jobId)
    if (!checkpoint) {
      // Crashed before the first commit boundary: nothing committed.
      const workspace = await this.materializeWorkspace(record)
      return {
        handle,
        checkpoint: null,
        committedEvents: [],
        orphanedEvents: [],
        workspace,
        restoredFromSnapshot: false,
        reusedToolCalls: 0,
      }
    }

    const allEvents = await this.deps.store.listEvents(jobId)
    const committed = allEvents.filter((e) => e.seq <= checkpoint.lastEventSeq)
    validateCheckpoint({
      checkpoint,
      record,
      policy,
      engineId: engine.id,
      engineVersion: engine.version,
      eventsThroughWatermark: committed,
      storedMaxSeq: allEvents.length,
    })
    const orphaned = allEvents.filter((e) => e.seq > checkpoint.lastEventSeq)

    let workspace: WorkspaceHandle | null = null
    let restoredFromSnapshot = false
    if (this.deps.environment && record.latestSnapshot) {
      try {
        workspace = await this.restoreSnapshot(record, record.latestSnapshot, engine.version)
        restoredFromSnapshot = true
      } catch (error) {
        // Snapshot is an optimization only; fall back to logical resume.
        workspace = await this.materializeWorkspace(record)
        await this.deps.store.appendEvents(jobId, [
          {
            jobId,
            timestamp: Date.now(),
            type: "warning",
            data: {
              reason: "snapshot_restore_failed",
              detail: `compute restore failed: ${(error as Error).message}; falling back to logical resume`,
              snapshotId: record.latestSnapshot.snapshotId,
            },
          },
        ])
      }
    } else {
      workspace = await this.materializeWorkspace(record)
    }

    const reusedToolCalls = Object.values(checkpoint.toolCalls).filter((c) => c.status === "completed").length
    await this.deps.store.appendEvents(
      jobId,
      [
        {
          jobId,
          timestamp: Date.now(),
          type: "resumed",
          data: {
            attempt: handle.ownership.generation,
            executionId: checkpoint.executionId,
            fromSeq: checkpoint.lastEventSeq,
            fromStep: checkpoint.lastCompletedStep?.stepIndex ?? null,
            continuation: checkpoint.continuation.type,
            reusedToolCalls,
            restoredFromSnapshot,
          },
        },
        ...(orphaned.length > 0
          ? [
              {
                jobId,
                timestamp: Date.now(),
                type: "warning" as const,
                data: {
                  reason: "orphaned_events",
                  detail: `${orphaned.length} event(s) committed after the checkpoint watermark are in-flight remnants and will not be replayed`,
                  fromSeq: orphaned[0]!.seq,
                  toSeq: orphaned[orphaned.length - 1]!.seq,
                },
              },
            ]
          : []),
      ],
      handle.ownership.generation,
    )

    return { handle, checkpoint, committedEvents: committed, orphanedEvents: orphaned, workspace, restoredFromSnapshot, reusedToolCalls }
  }

  // --------------------------------------------------------------------------
  // Snapshots (compute resume auxiliary)
  // --------------------------------------------------------------------------

  async snapshot(handle: ActorHandle, workspace: WorkspaceHandle | null, engineVersion: string): Promise<ExecutionSnapshot | null> {
    if (!this.deps.environment || !workspace) return null
    const snapshot = await this.deps.environment.snapshot(workspace, {
      jobId: handle.jobId,
      attempt: handle.ownership.generation,
      engineVersion,
    })
    // Explicit unsupported/fallback result: nothing captured, nothing recorded.
    if (!snapshot) return null
    await this.deps.store.updateJobRecord(handle.jobId, handle.ownership.generation, () => ({ latestSnapshot: snapshot }))
    return snapshot
  }

  // --------------------------------------------------------------------------
  // Destruction
  // --------------------------------------------------------------------------

  async destroy(jobId: string, workspace: WorkspaceHandle | null): Promise<void> {
    if (this.deps.environment) {
      if (workspace) await this.deps.environment.destroy(workspace)
      return
    }
    if (workspace) await this.deps.workspace?.destroy(workspace)
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async setStatus(handle: ActorHandle, status: JobStatus): Promise<JobRecord> {
    return this.deps.store.updateJobRecord(handle.jobId, handle.ownership.generation, () => ({ status }))
  }

  private async materializeWorkspace(record: JobRecord): Promise<WorkspaceHandle | null> {
    if (this.deps.environment) return this.deps.environment.create(record.jobId)
    if (this.deps.workspace) return this.deps.workspace.prepare(record.jobId)
    return null
  }

  private async restoreSnapshot(record: JobRecord, snapshot: ExecutionSnapshot, engineVersion: string): Promise<WorkspaceHandle | null> {
    if (snapshot.jobId !== record.jobId) throw new VaulltcoreError("SNAPSHOT_MISMATCH", `Snapshot ${snapshot.snapshotId} does not bind to job ${record.jobId}`)
    if (snapshot.engineVersion !== engineVersion) {
      throw new VaulltcoreError("SNAPSHOT_MISMATCH", `Snapshot engine version ${snapshot.engineVersion} ≠ current ${engineVersion}`)
    }
    if (!this.deps.environment) return null
    if (snapshot.environmentVersion !== this.deps.environment.environmentVersion) {
      throw new VaulltcoreError("SNAPSHOT_MISMATCH", `Snapshot environment version ${snapshot.environmentVersion} ≠ current ${this.deps.environment.environmentVersion}`)
    }
    return this.deps.environment.restore(snapshot)
  }

  private async requireRecord(jobId: string): Promise<JobRecord> {
    const record = await this.deps.store.getJobRecord(jobId)
    if (!record) throw new JobNotFoundError(jobId)
    return record
  }

  /** Capability report of an environment, defaulting to fully capable. */
  private async capabilitiesOf(environment: ExecutionEnvironment): Promise<ExecutionCapabilities> {
    return (await environment.capabilities?.()) ?? FULL_EXECUTION_CAPABILITIES
  }

  /** Facts derivable from durable state at a suspension boundary. Workspace
   * size and previous capture cost/duration are not known at this integration
   * point (providers do not report them yet), so they are null/zero. */
  private snapshotFacts(
    record: JobRecord,
    checkpoint: JobCheckpoint | null,
    capabilities: ExecutionCapabilities,
    reason: SuspensionReason,
  ): SnapshotFacts {
    const hasSnapshot = record.latestSnapshot !== null
    return {
      elapsedMs: Date.now() - record.createdAt,
      stepsSinceLastSnapshot: hasSnapshot ? 0 : (checkpoint?.usage.steps ?? 0),
      cumulativeTokens: checkpoint?.usage.totalTokens ?? 0,
      workspaceBytes: null,
      lastSnapshot: hasSnapshot ? { durationMs: 0, costUsd: 0 } : null,
      capabilities,
      suspensionRisk: reason === "infrastructure_eviction" ? "high" : "none",
    }
  }

  private async reportSnapshotUnsupported(jobId: string, attempt: number, detail: string): Promise<void> {
    await this.deps.store.appendEvents(
      jobId,
      [{ jobId, timestamp: Date.now(), type: "warning", data: { reason: "snapshot_unsupported", detail } }],
      attempt,
    )
  }
}
