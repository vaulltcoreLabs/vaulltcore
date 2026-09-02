/**
 * Checkpoint integrity: canonical serialization, checksums, and validation.
 *
 * A checkpoint is only accepted for resume when it is internally consistent,
 * consistent with the durable event log it references, and belongs to the
 * identity and policy the job was created with. Anything else is rejected
 * with {@link InvalidCheckpointError} — resume must never guess.
 */

import { createHash } from "node:crypto"
import type { ExecutionPolicy, JobCheckpoint, JobEvent, JobIdentity, JobRecord } from "./contracts"
import { IdentityMismatchError, InvalidCheckpointError } from "./errors"

export const CHECKPOINT_SCHEMA_VERSION = 1

/** Canonical JSON: recursively sorted object keys so the checksum is stable. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
  return `{${entries.join(",")}}`
}

export function checksumCheckpoint(checkpoint: Omit<JobCheckpoint, "checksum">): string {
  // Defensive: a stale checksum field must never feed back into the hash.
  const { checksum: _ignored, ...rest } = checkpoint as JobCheckpoint
  return createHash("sha256").update(canonicalize({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, ...rest })).digest("hex")
}

export function finalizeCheckpoint(checkpoint: Omit<JobCheckpoint, "checksum">): JobCheckpoint {
  return { ...checkpoint, checksum: checksumCheckpoint(checkpoint) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertIdentityMatches(jobId: string, a: JobIdentity, b: JobIdentity, where: string): void {
  for (const key of ["tenantId", "orgId", "projectId"] as const) {
    if (a[key] !== b[key]) throw new IdentityMismatchError(jobId, `${where}: ${key} changed ("${a[key]}" → "${b[key]}")`)
  }
}

/**
 * Validate a checkpoint against the job record, the policy, the engine, and
 * the durable event log. Throws on any inconsistency; returns nothing.
 */
export function validateCheckpoint(input: {
  checkpoint: unknown
  record: JobRecord
  policy: ExecutionPolicy
  engineId: string
  engineVersion: string
  eventsThroughWatermark: readonly JobEvent[]
  storedMaxSeq: number
}): asserts input is { checkpoint: JobCheckpoint } & Omit<typeof input, "checkpoint"> {
  const { checkpoint, record, policy, engineVersion, eventsThroughWatermark, storedMaxSeq } = input
  if (!isRecord(checkpoint)) throw new InvalidCheckpointError(record.jobId, "checkpoint is not an object")
  const cp = checkpoint as unknown as JobCheckpoint

  if (typeof cp.checksum !== "string" || cp.checksum.length !== 64) {
    throw new InvalidCheckpointError(record.jobId, "missing or malformed checksum")
  }
  const { checksum, ...rest } = cp
  if (checksumCheckpoint(rest) !== checksum) {
    throw new InvalidCheckpointError(record.jobId, "checksum mismatch (corrupt or tampered checkpoint)")
  }
  if (cp.jobId !== record.jobId) throw new InvalidCheckpointError(record.jobId, `checkpoint jobId ${cp.jobId} ≠ record jobId`)
  assertIdentityMatches(record.jobId, cp, record, "checkpoint")
  if (cp.policyVersion !== policy.version) {
    throw new InvalidCheckpointError(record.jobId, `policy version ${cp.policyVersion} ≠ requested ${policy.version}`)
  }
  if (cp.engineVersion !== engineVersion) {
    throw new InvalidCheckpointError(record.jobId, `engine version ${cp.engineVersion} ≠ registered ${engineVersion}`)
  }
  if (!Number.isInteger(cp.lastEventSeq) || cp.lastEventSeq < 0) {
    throw new InvalidCheckpointError(record.jobId, "lastEventSeq is not a non-negative integer")
  }
  if (cp.lastEventSeq > storedMaxSeq) {
    throw new InvalidCheckpointError(
      record.jobId,
      `watermark ${cp.lastEventSeq} beyond durable log (max seq ${storedMaxSeq})`,
    )
  }
  if (cp.contextRef?.kind !== "event_projection" || cp.contextRef.throughSeq !== cp.lastEventSeq) {
    throw new InvalidCheckpointError(record.jobId, "contextRef does not cover exactly the committed watermark")
  }
  if (cp.lastCompletedStep !== null) {
    if (!Number.isInteger(cp.lastCompletedStep.stepIndex) || cp.lastCompletedStep.stepIndex < 0) {
      throw new InvalidCheckpointError(record.jobId, "malformed lastCompletedStep")
    }
  }
  const continuation = cp.continuation
  if (!isRecord(continuation) || !["provider_turn", "settle_tools", "done"].includes(continuation.type as string)) {
    throw new InvalidCheckpointError(record.jobId, "malformed continuation point")
  }

  // Cross-check the tool-call table against the committed event log: every
  // completed call must reference an existing committed tool_response event.
  const toolResponseSeqs = new Set(
    eventsThroughWatermark.filter((e) => e.type === "tool_response").map((e) => e.seq),
  )
  const toolCalls = cp.toolCalls ?? {}
  for (const [key, state] of Object.entries(toolCalls)) {
    if (!isRecord(state)) throw new InvalidCheckpointError(record.jobId, `malformed tool call state for ${key}`)
    if (!["recorded", "completed", "uncertain"].includes(state.status as string)) {
      throw new InvalidCheckpointError(record.jobId, `unknown tool call status for ${key}`)
    }
    const recordedAtSeq = (state as { recordedAtSeq?: unknown }).recordedAtSeq
    if (typeof recordedAtSeq !== "number" || recordedAtSeq > cp.lastEventSeq) {
      throw new InvalidCheckpointError(record.jobId, `tool call ${key} recorded beyond the committed watermark`)
    }
    if (state.status === "completed") {
      const resultSeq = (state as { resultSeq?: unknown }).resultSeq
      if (typeof resultSeq !== "number" || !toolResponseSeqs.has(resultSeq)) {
        throw new InvalidCheckpointError(
          record.jobId,
          `completed tool call ${key} references missing tool_response seq ${String(resultSeq)}`,
        )
      }
    }
  }
  if (continuation.type === "settle_tools") {
    const pending = (continuation as { pendingToolCallIds?: unknown }).pendingToolCallIds
    if (!Array.isArray(pending)) throw new InvalidCheckpointError(record.jobId, "malformed settle_tools pending list")
    for (const key of pending) {
      if (typeof key !== "string" || !(key in toolCalls)) {
        throw new InvalidCheckpointError(record.jobId, `pending tool call ${String(key)} missing from tool-call table`)
      }
    }
  }
}
