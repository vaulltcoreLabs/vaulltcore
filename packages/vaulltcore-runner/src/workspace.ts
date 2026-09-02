/**
 * Local disposable workspace provider.
 *
 * Establishes the workspace seam for Phase 1A: one disposable workspace per
 * job execution, prepared/restored/snapshotted/destroyed through the
 * provider, never treated as permanent truth. A sandbox/cloud provider
 * (isolated microVM, container, etc.) implements the same interface later.
 */

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { WorkspaceHandle, WorkspaceProvider, WorkspaceSnapshotRef } from "./contracts"
import { newWorkspaceId } from "./ids"

export class LocalWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly baseDir?: string) {}

  private base(): string {
    return this.baseDir ?? tmpdir()
  }

  async prepare(_jobId: string): Promise<WorkspaceHandle> {
    await mkdir(this.base(), { recursive: true })
    const id = newWorkspaceId()
    const root = await mkdtemp(path.join(this.base(), `vaulltcore-${id}-`))
    return { id, root }
  }

  async restore(_jobId: string, snapshot: WorkspaceSnapshotRef): Promise<WorkspaceHandle> {
    await mkdir(this.base(), { recursive: true })
    const id = newWorkspaceId()
    const root = await mkdtemp(path.join(this.base(), `vaulltcore-${id}-`))
    await cp(snapshot.ref, root, { recursive: true })
    return { id, root }
  }

  async snapshot(handle: WorkspaceHandle): Promise<WorkspaceSnapshotRef> {
    if (!handle.root) throw new Error(`Workspace ${handle.id} has no local root to snapshot`)
    // Phase 1A: a snapshot is a directory copy under the same base dir. The ref
    // is the path; a cloud provider would upload and return a remote pointer.
    const ref = path.join(this.base(), `vaulltcore-snap-${handle.id}-${Date.now()}`)
    await mkdir(path.dirname(ref), { recursive: true })
    await cp(handle.root, ref, { recursive: true })
    return { workspaceId: handle.id, ref, createdAt: Date.now() }
  }

  async destroy(handle: WorkspaceHandle): Promise<void> {
    if (handle.root) await rm(handle.root, { recursive: true, force: true })
  }
}

export function envForJob(explicit: Record<string, string> | undefined): Record<string, string> {
  // Security baseline: agent tools and subprocesses receive only the env map
  // explicitly attached to the job. process.env is never consulted here.
  return { PATH: "/usr/local/bin:/usr/bin:/bin", ...(explicit ?? {}) }
}
