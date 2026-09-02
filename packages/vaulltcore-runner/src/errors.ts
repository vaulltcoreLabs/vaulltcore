export class VaulltcoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "VaulltcoreError"
  }
}

/** Job does not exist in the durable store. */
export class JobNotFoundError extends VaulltcoreError {
  constructor(jobId: string) {
    super("JOB_NOT_FOUND", `Job not found: ${jobId}`)
  }
}

/** Operation is invalid for the job's current lifecycle status. */
export class InvalidJobStateError extends VaulltcoreError {
  constructor(jobId: string, status: string, op: string) {
    super("INVALID_JOB_STATE", `Cannot ${op} job ${jobId} in status "${status}"`)
  }
}

/** Checkpoint failed integrity/consistency validation; resume refused. */
export class InvalidCheckpointError extends VaulltcoreError {
  constructor(jobId: string, reason: string) {
    super("INVALID_CHECKPOINT", `Checkpoint for job ${jobId} rejected: ${reason}`)
  }
}

/** Tenant/org/project identity mismatch — never continue another tenant's job. */
export class IdentityMismatchError extends VaulltcoreError {
  constructor(jobId: string, detail: string) {
    super("IDENTITY_MISMATCH", `Identity mismatch for job ${jobId}: ${detail}`)
  }
}

/** A newer attempt owns the job; this worker must stop immediately. */
export class LeaseFencedError extends VaulltcoreError {
  constructor(jobId: string) {
    super("LEASE_FENCED", `Job ${jobId} is owned by a newer attempt`)
  }
}

/** Engine required by a job is not registered with this runner. */
export class EngineNotFoundError extends VaulltcoreError {
  constructor(engineId: string) {
    super("ENGINE_NOT_FOUND", `No engine registered with id "${engineId}"`)
  }
}

/** Tool not present in the registry or not allowed by the execution policy. */
export class ToolNotAllowedError extends VaulltcoreError {
  constructor(toolName: string) {
    super("TOOL_NOT_ALLOWED", `Tool not registered or not allowed by policy: ${toolName}`)
  }
}
