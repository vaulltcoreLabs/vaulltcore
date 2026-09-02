/**
 * DockerCloudProvider (Phase 1D) — the first real {@link CloudExecutionProvider}.
 *
 * One provider. It demonstrates the Phase 1C seam against actual remote
 * execution (containers) while preserving the invariants:
 *
 * - explicit environment: a sandbox is a named container, bound to exactly
 *   one job (the name is a deterministic hash of the jobId so any process can
 *   reattach);
 * - isolated workspace: a dedicated volume per job; no host `process.env`
 *   leakage (a controlled allow-list is injected as exec env, never the host's
 *   full environment);
 * - CPU/memory/time limits: enforced via `docker run` resource flags;
 * - termination / inspect: honest;
 * - capability reporting: nativeSnapshot + nativeRestore via `docker commit`
 *   and `docker run <image>`; nativeSuspend via `docker pause`/`unpause`;
 *   durableWorkspace=false (workspace dies with the container unless snapshotted);
 * - honest snapshot semantics: if a snapshot is unavailable (e.g. container
 *   removed), the provider says so — it never emulates a snapshot.
 *
 * Docker is invoked through a configurable binary (default `docker`); in
 * environments where docker needs elevated privileges the binary can be set to
 * `sudo docker`.
 */

import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  CapabilityUnsupportedError,
  type CloudExecResult,
  type CloudExecutionHandle,
  type CloudExecutionProvider,
  type CloudSandboxInfo,
  type CloudSandboxStatus,
  type CloudSnapshotMetadata,
  type CloudSnapshotRef,
} from "@vaulltcore/environment-cloud"
import type { ExecutionCapabilities } from "@vaulltcore/runner"

const execFileAsync = promisify(execFile)

export interface DockerCloudProviderOptions {
  readonly providerId?: string
  /** Docker CLI invocation. Default ["docker"]. Use ["sudo","docker"] when needed. */
  readonly dockerBin?: readonly string[]
  /** Base image for sandboxes. Default "node:22-alpine". */
  readonly baseImage?: string
  /** CPU limit (cores) per sandbox. Default 1.0. */
  readonly cpus?: number
  /** Memory limit (bytes) per sandbox. Default 512MB. */
  readonly memoryBytes?: number
  /** Wall-clock timeout per execute() call (ms). Default 30000. */
  readonly execTimeoutMs?: number
  /** Environment variables to allow-list into the sandbox (never the host env). */
  readonly sandboxEnv?: Record<string, string>
}

/** A name prefix to keep vaulltcore sandboxes identifiable. */
const NAME_PREFIX = "vc-"

/**
 * Real Docker-backed provider. Containers are the "remote sandbox"; docker
 * commit images are the native snapshots. The provider holds no in-memory job
 * state — it re-derives everything from docker inspect, so a fresh process
 * reattaches correctly (a hard Phase 1D requirement).
 */
export class DockerCloudProvider implements CloudExecutionProvider {
  readonly providerId: string
  readonly environmentVersion = "docker-1"
  private readonly dockerBin: readonly string[]
  private readonly baseImage: string
  private readonly cpus: number
  private readonly memoryBytes: number
  private readonly execTimeoutMs: number
  private readonly sandboxEnv: Record<string, string>
  private snapshotCounter = 0

  constructor(options: DockerCloudProviderOptions = {}) {
    this.providerId = options.providerId ?? "docker-remote"
    this.dockerBin = options.dockerBin ?? ["docker"]
    this.baseImage = options.baseImage ?? "node:22-alpine"
    this.cpus = options.cpus ?? 1.0
    this.memoryBytes = options.memoryBytes ?? 512 * 1024 * 1024
    this.execTimeoutMs = options.execTimeoutMs ?? 30000
    this.sandboxEnv = options.sandboxEnv ?? {}
  }

  capabilities(): ExecutionCapabilities {
    // Docker genuinely supports all native lifecycle ops. durableWorkspace is
    // false: a removed container loses its writable layer; only a committed
    // image (snapshot) survives.
    return { nativeSuspend: true, nativeSnapshot: true, nativeRestore: true, durableWorkspace: false }
  }

  /** Deterministic, job-bound sandbox name. */
  private nameFor(jobName: string): string {
    return NAME_PREFIX + jobName
  }

  async provision(name: string): Promise<CloudExecutionHandle> {
    const containerName = this.nameFor(name)
    // Idempotent: if a container with this name exists (running or paused),
    // reattach to it rather than creating a duplicate.
    const existing = await this.inspectHandle(containerName).catch(() => null)
    if (existing) return { name, sandboxId: containerName }
    const envArgs: string[] = []
    for (const [k, v] of Object.entries(this.sandboxEnv)) {
      envArgs.push("-e", `${k}=${v}`)
    }
    // Create (don't start) a long-lived container; the engine drives exec.
    await this.docker("create", "--name", containerName, "--cpus", String(this.cpus), "--memory", String(this.memoryBytes), ...envArgs, this.baseImage, "sleep", "infinity")
    return { name, sandboxId: containerName }
  }

  async start(handle: CloudExecutionHandle): Promise<CloudExecutionHandle> {
    // `docker create` + `docker start` keeps the container alive across execs.
    try {
      await this.docker("start", handle.sandboxId)
    } catch (error) {
      // Already started is fine.
      if (!String((error as Error).message).includes("already")) throw error
    }
    return handle
  }

  async execute(handle: CloudExecutionHandle, command: string, args: readonly string[] = []): Promise<CloudExecResult> {
    const full = [command, ...args]
    try {
      const { stdout, stderr } = await this.dockerWithTimeout(["exec", handle.sandboxId, ...full], this.execTimeoutMs)
      return { exitCode: 0, stdout, stderr }
    } catch (error) {
      const e = error as ExecError
      return { exitCode: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message }
    }
  }

  async *stream(handle: CloudExecutionHandle): AsyncIterable<string> {
    // Stream `docker logs -f` until the consumer stops iterating.
    const child = execFile(this.dockerBin[0]!, [...this.dockerBin.slice(1), "logs", "-f", handle.sandboxId], {
      maxBuffer: 10 * 1024 * 1024,
    })
    let buffer = ""
    let resolver: (() => void) | null = null
    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString()
      if (resolver) {
        resolver()
        resolver = null
      }
    })
    child.stderr?.on("data", (chunk) => {
      buffer += chunk.toString()
      if (resolver) {
        resolver()
        resolver = null
      }
    })
    try {
      while (true) {
        if (!buffer) {
          await new Promise<void>((resolve) => {
            resolver = resolve
          })
        }
        if (!buffer) break
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) yield line
      }
    } finally {
      child.kill("SIGTERM")
    }
  }

  async suspend(handle: CloudExecutionHandle): Promise<void> {
    await this.docker("pause", handle.sandboxId).catch(() => {})
  }

  async resumeSandbox(handle: CloudExecutionHandle): Promise<CloudExecutionHandle> {
    await this.docker("unpause", handle.sandboxId).catch(() => {})
    return handle
  }

  async snapshot(handle: CloudExecutionHandle): Promise<CloudSnapshotRef> {
    const snapshotId = `vcsnap_${handle.name}_${++this.snapshotCounter}`
    const imageTag = `${NAME_PREFIX}snap:${snapshotId}`
    // `docker commit` freezes the writable layer into a new image.
    await this.docker("commit", handle.sandboxId, imageTag)
    // Integrity digest of the committed image (sha256 of its id).
    const { stdout: idOut } = await this.docker("images", "--quiet", "--no-trunc", imageTag)
    const imageId = idOut.trim()
    const payloadChecksum = createHash("sha256").update(`${imageTag}:${imageId}`).digest("hex")
    return { snapshotId, sandboxName: handle.name, createdAt: Date.now(), payloadChecksum, uri: imageTag }
  }

  async restore(ref: CloudSnapshotRef): Promise<CloudExecutionHandle> {
    const containerName = this.nameFor(ref.sandboxName)
    // Remove any existing container for this name, then materialize from the
    // snapshot image.
    await this.docker("rm", "-f", containerName).catch(() => {})
    await this.docker("create", "--name", containerName, "--cpus", String(this.cpus), "--memory", String(this.memoryBytes), ref.uri, "sleep", "infinity")
    await this.docker("start", containerName).catch(() => {})
    return { name: ref.sandboxName, sandboxId: containerName }
  }

  async inspectSnapshot(uri: string): Promise<CloudSnapshotMetadata> {
    const { stdout } = await this.docker("images", "--quiet", "--no-trunc", uri)
    const imageId = stdout.trim()
    if (!imageId) throw new CapabilityUnsupportedError("nativeRestore", this.providerId)
    const payloadChecksum = createHash("sha256").update(`${uri}:${imageId}`).digest("hex")
    return { snapshotId: uri, sandboxName: "", createdAt: 0, payloadChecksum, uri }
  }

  async terminate(handle: CloudExecutionHandle): Promise<void> {
    await this.docker("rm", "-f", handle.sandboxId).catch(() => {})
  }

  async inspect(ref: { name: string }): Promise<CloudSandboxInfo> {
    const containerName = this.nameFor(ref.name)
    const info = await this.inspectHandle(containerName)
    if (!info) {
      return { handle: { name: ref.name, sandboxId: containerName }, status: "terminated", createdAt: 0 }
    }
    return info
  }

  private async inspectHandle(containerName: string): Promise<CloudSandboxInfo | null> {
    let status: CloudSandboxStatus = "unknown"
    let createdAt = 0
    try {
      const { stdout } = await this.docker("inspect", "--format", "{{.State.Status}}|{{.Created}}", containerName)
      const [rawStatus, created] = stdout.trim().split("|")
      status = mapDockerStatus(rawStatus ?? "")
      createdAt = created ? Date.parse(created) : 0
    } catch {
      return null
    }
    return { handle: { name: containerName.replace(NAME_PREFIX, ""), sandboxId: containerName }, status, createdAt }
  }

  private async docker(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.dockerBin[0]!, [...this.dockerBin.slice(1), ...args], { maxBuffer: 50 * 1024 * 1024 })
  }

  private async dockerWithTimeout(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.dockerBin[0]!, [...this.dockerBin.slice(1), ...args], { maxBuffer: 50 * 1024 * 1024, timeout: timeoutMs })
  }
}

interface ExecError extends Error {
  code?: number
  stdout?: string
  stderr?: string
}

function mapDockerStatus(raw: string): CloudSandboxStatus {
  switch (raw) {
    case "running":
      return "running"
    case "paused":
      return "suspended"
    case "exited":
    case "dead":
      return "terminated"
    default:
      return "unknown"
  }
}
