/**
 * Single-node file-backed {@link DurableJobStore}.
 *
 * Layout per job:  <root>/<jobId>/{job.json, events.jsonl, checkpoint.json}
 *
 * Durability mechanics:
 * - events.jsonl is append-only; seq is assigned from the record's lastSeq
 *   inside the per-job critical section, so seq is strictly monotonic.
 * - job.json / checkpoint.json are written atomically (tmp + rename).
 * - Lease acquisition CAS-increments `attempt`; every mutating call carries
 *   the caller's attempt so a fenced (stale) worker fails loudly.
 *
 * This is not multi-writer safe across processes (Phase 1B replaces it with a
 * transactional store); the lease fencing contract is already in place.
 */

import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import type { JobCheckpoint, JobEvent, JobRecord, NewJobEvent } from "./contracts"
import { JobNotFoundError, LeaseFencedError, VaulltcoreError } from "./errors"
import { assertImmutableJobUpdate, type DurableJobStore, type LeaseGrant } from "./store"

class Mutex {
  private tail: Promise<void> = Promise.resolve()
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => (release = resolve))
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

interface JobFile {
  record: JobRecord
  lastSeq: number
}

export class FileJobStore implements DurableJobStore {
  private readonly mutexes = new Map<string, Mutex>()

  constructor(private readonly root: string) {}

  private dir(jobId: string): string {
    return path.join(this.root, jobId)
  }

  private async withLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.mutexes.get(jobId)
    if (!mutex) {
      mutex = new Mutex()
      this.mutexes.set(jobId, mutex)
    }
    return mutex.run(fn)
  }

  private async readJobFile(jobId: string): Promise<JobFile> {
    const file = path.join(this.dir(jobId), "job.json")
    if (!existsSync(file)) throw new JobNotFoundError(jobId)
    return JSON.parse(await readFile(file, "utf8")) as JobFile
  }

  private async writeJobFile(jobId: string, file: JobFile): Promise<void> {
    await this.atomicWrite(path.join(this.dir(jobId), "job.json"), JSON.stringify(file, null, 2))
  }

  private async atomicWrite(target: string, contents: string): Promise<void> {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, contents, "utf8")
    await rename(tmp, target)
  }

  async createJobRecord(record: JobRecord): Promise<void> {
    await mkdir(this.dir(record.jobId), { recursive: true })
    await this.withLock(record.jobId, async () => {
      await this.writeJobFile(record.jobId, { record, lastSeq: 0 })
      const handle = await open(path.join(this.dir(record.jobId), "events.jsonl"), "a")
      await handle.close()
    })
  }

  async getJobRecord(jobId: string): Promise<JobRecord | null> {
    try {
      return (await this.readJobFile(jobId)).record
    } catch (error) {
      if (error instanceof JobNotFoundError) return null
      throw error
    }
  }

  async updateJobRecord(
    jobId: string,
    expectedAttempt: number,
    mutate: (record: JobRecord) => Partial<JobRecord>,
  ): Promise<JobRecord> {
    return this.withLock(jobId, async () => {
      const file = await this.readJobFile(jobId)
      if (file.record.attempt !== expectedAttempt) throw new LeaseFencedError(jobId)
      const patch = mutate(file.record)
      assertImmutableJobUpdate(jobId, file.record, patch)
      const next: JobRecord = { ...file.record, ...patch, updatedAt: Date.now() }
      await this.writeJobFile(jobId, { ...file, record: next })
      return next
    })
  }

  async acquireLease(jobId: string, leaseToken: string, leaseMs: number): Promise<LeaseGrant> {
    return this.withLock(jobId, async () => {
      const file = await this.readJobFile(jobId)
      const { record } = file
      const now = Date.now()
      const leaseLive = record.leaseToken !== null && record.leaseExpiresAt !== null && record.leaseExpiresAt > now
      if (leaseLive && record.leaseToken !== leaseToken) {
        throw new VaulltcoreError("LEASE_HELD", `Job ${jobId} is leased by another worker until ${record.leaseExpiresAt}`)
      }
      const grant: LeaseGrant = { attempt: record.attempt + 1, leaseToken, leaseExpiresAt: now + leaseMs }
      const next: JobRecord = {
        ...record,
        attempt: grant.attempt,
        leaseToken,
        leaseExpiresAt: grant.leaseExpiresAt,
        updatedAt: now,
      }
      await this.writeJobFile(jobId, { ...file, record: next })
      return grant
    })
  }

  /** Explicit ownership release. Idempotent; a mismatched token is a no-op. */
  async releaseLease(jobId: string, leaseToken: string): Promise<void> {
    await this.withLock(jobId, async () => {
      const file = await this.readJobFile(jobId)
      const { record } = file
      if (record.leaseToken !== leaseToken) return
      await this.writeJobFile(jobId, {
        ...file,
        record: { ...record, leaseToken: null, leaseExpiresAt: null, updatedAt: Date.now() },
      })
    })
  }

  async appendEvents<T>(jobId: string, events: readonly NewJobEvent<T>[], expectedAttempt?: number): Promise<JobEvent<T>[]> {
    if (events.length === 0) return []
    return this.withLock(jobId, async () => {
      const file = await this.readJobFile(jobId)
      if (expectedAttempt !== undefined && file.record.attempt !== expectedAttempt) {
        throw new LeaseFencedError(jobId)
      }
      let seq = file.lastSeq
      const stamped: JobEvent<T>[] = events.map((event) => ({ ...event, seq: ++seq }))
      const lines = stamped.map((event) => JSON.stringify(event)).join("\n") + "\n"
      const handle = await open(path.join(this.dir(jobId), "events.jsonl"), "a")
      try {
        await handle.appendFile(lines, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.writeJobFile(jobId, { ...file, lastSeq: seq })
      return stamped
    })
  }

  async listEvents(jobId: string, afterSeq = 0): Promise<JobEvent[]> {
    const file = path.join(this.dir(jobId), "events.jsonl")
    if (!existsSync(file)) {
      if (!(await this.getJobRecord(jobId))) throw new JobNotFoundError(jobId)
      return []
    }
    const raw = await readFile(file, "utf8")
    const events: JobEvent[] = []
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as JobEvent
      if (event.seq > afterSeq) events.push(event)
    }
    return events
  }

  async saveCheckpoint(jobId: string, checkpoint: JobCheckpoint): Promise<void> {
    await this.withLock(jobId, async () => {
      const file = await this.readJobFile(jobId)
      if (file.record.attempt !== checkpoint.attempt) throw new LeaseFencedError(jobId)
      if (checkpoint.lastEventSeq > file.lastSeq) {
        throw new VaulltcoreError(
          "CHECKPOINT_AHEAD_OF_LOG",
          `Checkpoint watermark ${checkpoint.lastEventSeq} exceeds committed seq ${file.lastSeq}`,
        )
      }
      await this.atomicWrite(
        path.join(this.dir(jobId), "checkpoint.json"),
        JSON.stringify({ schemaVersion: 1, checkpoint }, null, 2),
      )
    })
  }

  async getCheckpoint(jobId: string): Promise<JobCheckpoint | null> {
    const file = path.join(this.dir(jobId), "checkpoint.json")
    if (!existsSync(file)) {
      if (!(await this.getJobRecord(jobId))) throw new JobNotFoundError(jobId)
      return null
    }
    const parsed = JSON.parse(await readFile(file, "utf8")) as { checkpoint: JobCheckpoint }
    return parsed.checkpoint
  }
}
