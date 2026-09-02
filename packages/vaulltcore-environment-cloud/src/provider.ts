/**
 * Vendor-neutral remote execution provider seam (Phase 1C).
 *
 * One provider = one way to run remote compute (a microVM service, a sandbox
 * API, a container host). The runner and the actor controller never see this
 * interface: they talk to the Phase 1B {@link ExecutionEnvironment} contract,
 * which {@link CloudExecutionEnvironment} implements on top of a provider.
 * There is deliberately no mention of Fly, E2B, Cloudflare, Docker, or
 * Kubernetes here — a provider for any of them implements these methods.
 *
 * Capability honesty rule: a provider reports its native capabilities; calling
 * an operation it does not natively support must throw
 * {@link CapabilityUnsupportedError}, never emulate the result silently. In
 * particular, a logical checkpoint is never presented as a compute snapshot.
 */

import type { ExecutionCapabilities } from "@vaulltcore/runner"

export class CapabilityUnsupportedError extends Error {
  readonly code = "CAPABILITY_UNSUPPORTED"

  constructor(
    readonly capability: keyof ExecutionCapabilities,
    providerId: string,
  ) {
    super(`Provider "${providerId}" does not support native ${capability}`)
    this.name = "CapabilityUnsupportedError"
  }
}

/** A live remote sandbox handle. The name is job-bound and deterministic so
 * any process can reattach; the sandboxId is provider-assigned per instance. */
export interface CloudExecutionHandle {
  readonly name: string
  readonly sandboxId: string
}

export type CloudSandboxStatus = "provisioning" | "running" | "suspended" | "terminated" | "unknown"

export interface CloudSandboxInfo {
  readonly handle: CloudExecutionHandle
  readonly status: CloudSandboxStatus
  readonly createdAt: number
}

export interface CloudExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Opaque provider pointer to a captured sandbox image. */
export interface CloudSnapshotRef {
  readonly snapshotId: string
  /** Job-bound sandbox name this image was captured from (binding evidence). */
  readonly sandboxName: string
  readonly createdAt: number
  /** Provider-side integrity digest of the captured payload. */
  readonly payloadChecksum: string
  /** Vendor storage pointer (opaque to the control plane). */
  readonly uri: string
}

/** Recorded snapshot metadata, freshly validated by the provider. */
export interface CloudSnapshotMetadata extends CloudSnapshotRef {}

export interface CloudExecutionProvider {
  readonly providerId: string
  /** Provider implementation version; part of snapshot compatibility. */
  readonly environmentVersion: string
  /** Honest native capability report. */
  capabilities(): ExecutionCapabilities
  /** Allocate a sandbox for the job-bound name (idempotent by name). */
  provision(name: string): Promise<CloudExecutionHandle>
  /** Start compute on a provisioned sandbox. */
  start(handle: CloudExecutionHandle): Promise<CloudExecutionHandle>
  /** Run a command inside the sandbox (used by remote-capable engines). */
  execute(handle: CloudExecutionHandle, command: string, args?: readonly string[]): Promise<CloudExecResult>
  /** Stream sandbox output lines. */
  stream(handle: CloudExecutionHandle): AsyncIterable<string>
  /** Pause compute without destroying workspace state. */
  suspend(handle: CloudExecutionHandle): Promise<void>
  /** Resume a suspended sandbox. */
  resumeSandbox(handle: CloudExecutionHandle): Promise<CloudExecutionHandle>
  /** Capture a native sandbox image (requires nativeSnapshot capability). */
  snapshot(handle: CloudExecutionHandle): Promise<CloudSnapshotRef>
  /** Materialize a sandbox from a captured image (requires nativeRestore). */
  restore(ref: CloudSnapshotRef): Promise<CloudExecutionHandle>
  /** Re-read and re-validate snapshot metadata for a storage uri. */
  inspectSnapshot(uri: string): Promise<CloudSnapshotMetadata>
  /** Destroy the sandbox and its captured images. */
  terminate(handle: CloudExecutionHandle): Promise<void>
  /** Read sandbox state by handle or job-bound name. */
  inspect(ref: { name: string }): Promise<CloudSandboxInfo>
}
