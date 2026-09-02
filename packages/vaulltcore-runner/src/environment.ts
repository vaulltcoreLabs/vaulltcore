/**
 * Reference ExecutionEnvironment: a deterministic, filesystem-backed compute
 * seam. Concepts adapted from Google AX (`internal/ate` actor lifecycle and
 * the `cursorstore` hashed-binding pattern, Apache-2.0); re-implemented as
 * Vaulltcore-owned TypeScript with no Kubernetes/Agent Substrate dependency.
 *
 * Workspace identity is bound to the job via sha256(jobId) — never the
 * process's ambient cwd — so a fresh process reattaches deterministically.
 * A snapshot is an immutable directory copy plus a sha256 manifest; restore
 * re-validates the manifest before materializing.
 */

import { createHash } from "node:crypto"
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ExecutionCapabilities, ExecutionEnvironment, ExecutionSnapshot, WorkspaceHandle, WorkspaceState } from "./contracts"
import { newSnapshotId } from "./ids"

const SNAPSHOT_ROOT = "snapshots"
const LIVE_WORKSPACE = "workspace"

export interface EnvironmentHooks {
  /** Fault-injection point mid-snapshot (tests); must throw to abort. */
  readonly duringSnapshot?: (root: string) => void
}

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  readonly environmentVersion = "local/1"

  constructor(
    private readonly baseDir?: string,
    private readonly hooks: EnvironmentHooks = {},
  ) {}

  /** Local FS can capture/restore real directory snapshots and the workspace
   * survives this host's worker restarts, so everything is native. */
  capabilities(): ExecutionCapabilities {
    return { nativeSuspend: true, nativeSnapshot: true, nativeRestore: true, durableWorkspace: true }
  }

  private base(): string {
    return this.baseDir ?? tmpdir()
  }

  /** Deterministic job-bound root (hashed like AX's cursorStore path). */
  private jobRoot(jobId: string): string {
    const hash = createHash("sha256").update(jobId).digest("hex")
    return path.join(this.base(), "vaulltcore-env", hash)
  }

  async create(jobId: string): Promise<WorkspaceHandle> {
    const root = path.join(this.jobRoot(jobId), LIVE_WORKSPACE)
    // Reattach if the live workspace survives from an earlier attempt on this
    // host (same-host compute continuity); otherwise start empty.
    await mkdir(root, { recursive: true })
    return { id: `env:${jobId}`, root }
  }

  async getState(handle: WorkspaceHandle): Promise<WorkspaceState> {
    return { workspaceId: handle.id, root: handle.root, snapshotRef: null }
  }

  async snapshot(
    handle: WorkspaceHandle,
    meta: { jobId: string; attempt: number; engineVersion: string },
  ): Promise<ExecutionSnapshot> {
    if (!handle.root) throw new Error(`Workspace ${handle.id} has no local root to snapshot`)
    const snapshotId = newSnapshotId()
    const dir = path.join(this.jobRoot(meta.jobId), SNAPSHOT_ROOT, snapshotId)
    await mkdir(dir, { recursive: true })

    this.hooks.duringSnapshot?.(handle.root)

    // Immutable copy + integrity manifest (sorted "relpath sha256" lines) →
    // atomic manifest write (temp + rename, AX cursorStore pattern).
    await cp(handle.root, dir, { recursive: true })
    const lines: string[] = []
    for (const rel of await listFiles(dir)) {
      const hash = createHash("sha256").update(await readFile(path.join(dir, rel))).digest("hex")
      lines.push(`${rel} ${hash}`)
    }
    lines.sort()
    const manifestPath = path.join(dir, "manifest.json")
    const manifestOps = { algorithm: "sha256" as const, checksum: createHash("sha256").update(lines.join("\n")).digest("hex") }
    const tmp = `${manifestPath}.tmp`
    await writeFile(tmp, JSON.stringify({ files: lines }, null, 2))
    await rename(tmp, manifestPath)

    return {
      snapshotId,
      jobId: meta.jobId,
      attempt: meta.attempt,
      engineVersion: meta.engineVersion,
      environmentVersion: this.environmentVersion,
      createdAt: Date.now(),
      integrity: manifestOps,
      storage: { kind: "local-directory", uri: dir },
      workspaceState: await this.getState(handle),
    }
  }

  async restore(snapshot: ExecutionSnapshot): Promise<WorkspaceHandle> {
    const dir = snapshot.storage.uri
    // Validate job binding before doing any work.
    if (!dir.startsWith(this.jobRoot(snapshot.jobId))) {
      throw new Error(`Snapshot storage ${dir} does not bind to job ${snapshot.jobId}`)
    }
    // Validate integrity: recompute manifest over copied files.
    const manifestPath = path.join(dir, "manifest.json")
    const manifest: { files: string[] } = JSON.parse(await readFile(manifestPath, "utf8"))
    const checksum = createHash("sha256").update(manifest.files.join("\n")).digest("hex")
    if (checksum !== snapshot.integrity.checksum) {
      throw new Error(`Snapshot ${snapshot.snapshotId} integrity mismatch (corrupt or tampered)`)
    }
    // Verify the payload actually matches the manifest (catch torn copies).
    for (const line of manifest.files) {
      const [rel, hash] = line.split(" ")
      const actual = createHash("sha256").update(await readFile(path.join(dir, rel!))).digest("hex")
      if (actual !== hash) throw new Error(`Snapshot ${snapshot.snapshotId} payload hash mismatch for ${rel}`)
    }

    const root = path.join(this.jobRoot(snapshot.jobId), LIVE_WORKSPACE)
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "manifest.json") continue
      await cp(path.join(dir, entry.name), path.join(root, entry.name), { recursive: true })
    }
    return { id: `env:${snapshot.jobId}`, root }
  }

  /** Compute suspend: a marker hook; local FS persists across suspend. */
  async suspend(_handle: WorkspaceHandle): Promise<void> {}

  /** Compute resume: reattach the handle (process-local liveness marker). */
  async resume(handle: WorkspaceHandle): Promise<WorkspaceHandle> {
    return handle
  }

  async destroy(handle: WorkspaceHandle): Promise<void> {
    const jobId = handle.id.replace(/^env:/, "")
    await rm(this.jobRoot(jobId), { recursive: true, force: true })
  }
}

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === "manifest.json") continue
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await listFiles(root, child)))
    else if ((await stat(path.join(root, child))).isFile()) out.push(child)
  }
  return out
}
