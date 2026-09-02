/**
 * CloudExecutionEnvironment — the Phase 1B {@link ExecutionEnvironment}
 * contract implemented over a vendor-neutral {@link CloudExecutionProvider}.
 *
 * Job binding and integrity:
 * - Sandbox names are derived deterministically as `vaulltcore-<sha256(jobId)>`,
 *   so a fresh environment instance reattaches to the same remote sandbox
 *   (no in-memory registry needed).
 * - Snapshot integrity binds (jobId, sandboxName, payload checksum, engine
 *   version, environment version) into one sha256 tag. Restore recomputes the
 *   tag from freshly revalidated provider metadata and refuses on any drift —
 *   a tampered or cross-tenant image can never become a continuation source.
 *
 * Capability honesty:
 * - No native snapshot ⇒ `snapshot()` returns null (explicit "not captured");
 *   nothing is attached to `record.latestSnapshot`.
 * - No native restore ⇒ `restore()` throws CapabilityUnsupportedError; the
 *   recovery algorithm catches it and falls back to logical resume.
 * - A cloud snapshot is always an optimization. The durable checkpoint +
 *   event log stay authoritative.
 */

import { createHash } from "node:crypto"
import {
  CapabilityUnsupportedError,
  type CloudExecutionHandle,
  type CloudExecutionProvider,
  type CloudSnapshotRef,
  type CloudSnapshotMetadata,
} from "./provider"
import {
  canonicalize,
  type ExecutionCapabilities,
  type ExecutionEnvironment,
  type ExecutionSnapshot,
  type WorkspaceHandle,
  type WorkspaceState,
} from "@vaulltcore/runner"
import { VaulltcoreError } from "@vaulltcore/runner"

const HANDLE_PREFIX = "cloud:"

export class CloudExecutionEnvironment implements ExecutionEnvironment {
  readonly environmentVersion: string

  constructor(private readonly provider: CloudExecutionProvider) {
    this.environmentVersion = `cloud/${provider.providerId}/${provider.environmentVersion}`
  }

  capabilities(): ExecutionCapabilities {
    return this.provider.capabilities()
  }

  /** Deterministic job-bound sandbox name. */
  private nameFor(jobId: string): string {
    return `vaulltcore-${createHash("sha256").update(jobId).digest("hex")}`
  }

  /** Recompute the binding+integrity tag over provider-revalidated metadata. */
  private integrityTag(
    snapshot: Pick<ExecutionSnapshot, "jobId" | "engineVersion" | "environmentVersion">,
    meta: CloudSnapshotMetadata | CloudSnapshotRef,
  ): string {
    return createHash("sha256")
      .update(
        canonicalize({
          jobId: snapshot.jobId,
          sandboxName: meta.sandboxName,
          payloadChecksum: meta.payloadChecksum,
          engineVersion: snapshot.engineVersion,
          environmentVersion: snapshot.environmentVersion,
        }),
      )
      .digest("hex")
  }

  async create(jobId: string): Promise<WorkspaceHandle> {
    const name = this.nameFor(jobId)
    const existing = await this.provider.inspect({ name })
    if (existing.status !== "unknown" && existing.status !== "terminated") {
      // Reattach to the live sandbox (fresh-process continuity).
      if (existing.status === "provisioning") await this.provider.start(existing.handle)
      if (existing.status === "suspended") await this.provider.resumeSandbox(existing.handle)
      return { id: HANDLE_PREFIX + jobId, root: null }
    }
    const provisioned = await this.provider.provision(name)
    await this.provider.start(provisioned)
    return { id: HANDLE_PREFIX + jobId, root: null }
  }

  async getState(handle: WorkspaceHandle): Promise<WorkspaceState> {
    return { workspaceId: handle.id, root: null, snapshotRef: null }
  }

  async snapshot(
    handle: WorkspaceHandle,
    meta: { jobId: string; attempt: number; engineVersion: string },
  ): Promise<ExecutionSnapshot | null> {
    // Explicit "not captured" result when the provider cannot snapshot.
    if (!this.provider.capabilities().nativeSnapshot) return null
    const info = await this.provider.inspect({ name: this.nameFor(meta.jobId) })
    if (info.status === "unknown" || info.status === "terminated") {
      throw new VaulltcoreError("SNAPSHOT_UNAVAILABLE", `No live sandbox for job ${meta.jobId}`)
    }
    const ref = await this.provider.snapshot(info.handle)
    const tagInput = { jobId: meta.jobId, engineVersion: meta.engineVersion, environmentVersion: this.environmentVersion }
    const snapshot: ExecutionSnapshot = {
      snapshotId: ref.snapshotId,
      jobId: meta.jobId,
      attempt: meta.attempt,
      engineVersion: meta.engineVersion,
      environmentVersion: this.environmentVersion,
      createdAt: ref.createdAt,
      integrity: { algorithm: "sha256", checksum: this.integrityTag(tagInput, ref) },
      storage: { kind: "cloud-sandbox-image", uri: ref.uri },
      workspaceState: { workspaceId: handle.id, root: handle.root, snapshotRef: ref.uri },
    }
    return snapshot
  }

  async restore(snapshot: ExecutionSnapshot): Promise<WorkspaceHandle> {
    if (!this.provider.capabilities().nativeRestore) {
      throw new CapabilityUnsupportedError("nativeRestore", this.provider.providerId)
    }
    // Binding: the recorded sandbox must belong to this job's deterministic name.
    const expectedName = this.nameFor(snapshot.jobId)
    const meta = await this.provider.inspectSnapshot(snapshot.storage.uri)
    if (meta.sandboxName !== expectedName) {
      throw new VaulltcoreError(
        "SNAPSHOT_BINDING_MISMATCH",
        `Snapshot ${snapshot.snapshotId} binds to sandbox ${meta.sandboxName}, not job ${snapshot.jobId}`,
      )
    }
    // Integrity: recompute the tag over provider-fresh metadata (payload
    // checksum recomputed from stored bytes, so corruption breaks the tag).
    const tag = this.integrityTag(snapshot, meta)
    if (tag !== snapshot.integrity.checksum) {
      throw new VaulltcoreError("SNAPSHOT_INTEGRITY_MISMATCH", `Snapshot ${snapshot.snapshotId} failed integrity validation`)
    }
    const ref: CloudSnapshotRef = {
      snapshotId: meta.snapshotId,
      sandboxName: meta.sandboxName,
      createdAt: meta.createdAt,
      payloadChecksum: meta.payloadChecksum,
      uri: snapshot.storage.uri,
    }
    await this.provider.restore(ref)
    return { id: HANDLE_PREFIX + snapshot.jobId, root: null }
  }

  async suspend(handle: WorkspaceHandle): Promise<void> {
    if (!this.provider.capabilities().nativeSuspend) {
      throw new CapabilityUnsupportedError("nativeSuspend", this.provider.providerId)
    }
    const info = await this.provider.inspect({ name: this.nameFor(this.jobIdOf(handle)) })
    if (info.status === "unknown" || info.status === "terminated") return
    await this.provider.suspend(info.handle)
  }

  async resume(handle: WorkspaceHandle): Promise<WorkspaceHandle> {
    if (!this.provider.capabilities().nativeSuspend) {
      throw new CapabilityUnsupportedError("nativeSuspend", this.provider.providerId)
    }
    const info = await this.provider.inspect({ name: this.nameFor(this.jobIdOf(handle)) })
    if (info.status === "suspended") await this.provider.resumeSandbox(info.handle)
    return handle
  }

  async destroy(handle: WorkspaceHandle): Promise<void> {
    const info = await this.provider.inspect({ name: this.nameFor(this.jobIdOf(handle)) })
    if (info.status === "unknown" || info.status === "terminated") return
    await this.provider.terminate(info.handle)
  }

  private jobIdOf(handle: WorkspaceHandle): string {
    return handle.id.replace(new RegExp(`^${HANDLE_PREFIX}`), "")
  }
}
