/**
 * Deterministic in-memory remote provider for tests. Needs no credentials and
 * behaves exactly like a real remote service: sandboxes persist in the
 * provider (the "account"), so a brand-new CloudExecutionEnvironment instance
 * over the same provider reattaches — no in-memory environment state needed.
 *
 * Every operation appends to {@link FakeCloudProvider.calls} so tests can
 * assert the exact lifecycle dispatch sequence.
 */

import { createHash } from "node:crypto"
import {
  CapabilityUnsupportedError,
  type CloudExecResult,
  type CloudExecutionHandle,
  type CloudExecutionProvider,
  type CloudSandboxInfo,
  type CloudSandboxStatus,
  type CloudSnapshotMetadata,
  type CloudSnapshotRef,
} from "./provider"
import type { ExecutionCapabilities } from "@vaulltcore/runner"

const FULL: ExecutionCapabilities = { nativeSuspend: true, nativeSnapshot: true, nativeRestore: true, durableWorkspace: true }

interface FakeSandbox {
  handle: CloudExecutionHandle
  status: CloudSandboxStatus
  createdAt: number
  fs: Map<string, string>
  output: string[]
}

interface StoredSnapshot {
  ref: CloudSnapshotRef
  /** Serialized workspace contents (JSON of [relpath, contents] pairs). */
  payload: string
}

export interface FakeCloudProviderOptions {
  readonly providerId?: string
  readonly capabilities?: Partial<ExecutionCapabilities>
}

export class FakeCloudProvider implements CloudExecutionProvider {
  readonly providerId: string
  readonly environmentVersion = "1"
  readonly calls: string[] = []
  private readonly caps: ExecutionCapabilities
  private readonly sandboxes = new Map<string, FakeSandbox>()
  private readonly snapshots = new Map<string, StoredSnapshot>()
  private snapshotCounter = 0

  constructor(options: FakeCloudProviderOptions = {}) {
    this.providerId = options.providerId ?? "fake-remote"
    this.caps = { ...FULL, ...(options.capabilities ?? {}) }
  }

  capabilities(): ExecutionCapabilities {
    return this.caps
  }

  private record(op: string, detail = ""): void {
    this.calls.push(detail ? `${op}:${detail}` : op)
  }

  private sandboxByName(name: string): FakeSandbox | undefined {
    return [...this.sandboxes.values()].find((sandbox) => sandbox.handle.name === name)
  }

  private requireRunning(handle: CloudExecutionHandle): FakeSandbox {
    const sandbox = this.sandboxes.get(handle.sandboxId)
    if (!sandbox || sandbox.status !== "running") throw new Error(`Sandbox ${handle.sandboxId} is not running`)
    return sandbox
  }

  async provision(name: string): Promise<CloudExecutionHandle> {
    this.record("provision", name)
    const existing = this.sandboxByName(name)
    if (existing) return existing.handle
    const sandboxId = `sbx_${name}_${this.sandboxes.size}`
    const sandbox: FakeSandbox = {
      handle: { name, sandboxId },
      status: "provisioning",
      createdAt: Date.now(),
      fs: new Map(),
      output: [],
    }
    this.sandboxes.set(sandboxId, sandbox)
    return sandbox.handle
  }

  async start(handle: CloudExecutionHandle): Promise<CloudExecutionHandle> {
    this.record("start", handle.sandboxId)
    const sandbox = this.sandboxes.get(handle.sandboxId)
    if (sandbox && sandbox.status === "provisioning") sandbox.status = "running"
    return handle
  }

  async execute(handle: CloudExecutionHandle, command: string, args: readonly string[] = []): Promise<CloudExecResult> {
    this.record("execute", command)
    const sandbox = this.requireRunning(handle)
    if (command === "write") {
      sandbox.fs.set(args[0]!, args[1] ?? "")
      sandbox.output.push(`wrote ${args[0]}`)
      return { exitCode: 0, stdout: `wrote ${args[0]}`, stderr: "" }
    }
    if (command === "read") {
      const contents = sandbox.fs.get(args[0]!)
      if (contents === undefined) return { exitCode: 1, stdout: "", stderr: `no such file: ${args[0]}` }
      sandbox.output.push(contents)
      return { exitCode: 0, stdout: contents, stderr: "" }
    }
    sandbox.output.push(`ok:${command}`)
    return { exitCode: 0, stdout: `ok:${command}`, stderr: "" }
  }

  async *stream(handle: CloudExecutionHandle): AsyncIterable<string> {
    this.record("stream")
    const sandbox = this.sandboxes.get(handle.sandboxId)
    if (!sandbox) return
    for (const line of sandbox.output) yield line
  }

  async suspend(handle: CloudExecutionHandle): Promise<void> {
    if (!this.caps.nativeSuspend) throw new CapabilityUnsupportedError("nativeSuspend", this.providerId)
    this.record("suspend")
    const sandbox = this.sandboxes.get(handle.sandboxId)
    if (sandbox?.status === "running") sandbox.status = "suspended"
  }

  async resumeSandbox(handle: CloudExecutionHandle): Promise<CloudExecutionHandle> {
    if (!this.caps.nativeSuspend) throw new CapabilityUnsupportedError("nativeSuspend", this.providerId)
    this.record("resumeSandbox")
    const sandbox = this.sandboxes.get(handle.sandboxId)
    if (sandbox?.status === "suspended") sandbox.status = "running"
    return handle
  }

  async snapshot(handle: CloudExecutionHandle): Promise<CloudSnapshotRef> {
    if (!this.caps.nativeSnapshot) throw new CapabilityUnsupportedError("nativeSnapshot", this.providerId)
    this.record("snapshot")
    const sandbox = this.requireRunning(handle)
    const snapshotId = `snap_${handle.sandboxId}_${++this.snapshotCounter}`
    const payload = JSON.stringify([...sandbox.fs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
    const ref: CloudSnapshotRef = {
      snapshotId,
      sandboxName: handle.name,
      createdAt: Date.now(),
      payloadChecksum: createHash("sha256").update(payload).digest("hex"),
      uri: `fake://snapshots/${handle.name}/${snapshotId}`,
    }
    this.snapshots.set(ref.uri, { ref, payload })
    return ref
  }

  async restore(ref: CloudSnapshotRef): Promise<CloudExecutionHandle> {
    if (!this.caps.nativeRestore) throw new CapabilityUnsupportedError("nativeRestore", this.providerId)
    this.record("restore")
    const stored = this.snapshots.get(ref.uri)
    if (!stored) throw new Error(`Snapshot not found: ${ref.uri}`)
    const entries = JSON.parse(stored.payload) as Array<[string, string]>
    const sandboxId = `sbx_${ref.sandboxName}_restored_${this.sandboxes.size}`
    const sandbox: FakeSandbox = {
      handle: { name: ref.sandboxName, sandboxId },
      status: "running",
      createdAt: Date.now(),
      fs: new Map(entries),
      output: [],
    }
    this.sandboxes.set(sandboxId, sandbox)
    return sandbox.handle
  }

  async inspectSnapshot(uri: string): Promise<CloudSnapshotMetadata> {
    this.record("inspectSnapshot")
    const stored = this.snapshots.get(uri)
    if (!stored) throw new Error(`Snapshot not found: ${uri}`)
    return {
      ...stored.ref,
      // Recomputed from the stored payload on every read — corruption of the
      // payload breaks the checksum, breaking the environment's integrity tag.
      payloadChecksum: createHash("sha256").update(stored.payload).digest("hex"),
    }
  }

  async terminate(handle: CloudExecutionHandle): Promise<void> {
    this.record("terminate", handle.sandboxId)
    const sandbox = this.sandboxes.get(handle.sandboxId)
    if (sandbox) sandbox.status = "terminated"
  }

  async inspect(ref: { name: string }): Promise<CloudSandboxInfo> {
    this.record("inspect", ref.name)
    const sandbox = this.sandboxByName(ref.name)
    if (!sandbox) return { handle: { name: ref.name, sandboxId: "" }, status: "unknown", createdAt: 0 }
    return { handle: sandbox.handle, status: sandbox.status, createdAt: sandbox.createdAt }
  }

  /** Test-only corruption helper: flips payload bits so integrity checks fail. */
  corruptSnapshot(uri: string): void {
    const stored = this.snapshots.get(uri)
    if (!stored) throw new Error(`Snapshot not found: ${uri}`)
    stored.payload += "/*corrupted*/"
  }
}
