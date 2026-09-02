/**
 * Typed input contracts + durable input revisions (Phase 2A).
 *
 * Input is validated before admission. The exact accepted input is frozen as a
 * {@link RunInputRevision} (with a checksum) and never silently replaced. If
 * changes are required after creation, a new revision is recorded — historical
 * input stays recoverable so every execution job remains traceable to the exact
 * version + input revision that produced it.
 */

import { createHash } from "node:crypto"
import { type InputContract, type InputValue, type RunInputRevision, AutomationError } from "./contracts"
import { newInputRevisionId } from "./ids"
import { stableString } from "./version"

export class InvalidInputError extends AutomationError {
  constructor(reason: string) {
    super("INVALID_INPUT", `Invalid automation input: ${reason}`, 400)
  }
}

/** Validate submitted values against the published input contract. Rejects:
 *  - missing required fields
 *  - unknown fields (not in the contract)
 *  - wrong type
 *  - min/max/enum violations
 *  - artifact_ref values that are not non-empty strings */
export function validateInput(contract: InputContract, values: Readonly<Record<string, unknown>>): void {
  const fieldsById = new Map(contract.fields.map((f) => [f.fieldId, f]))
  // unknown fields
  for (const key of Object.keys(values)) {
    if (!fieldsById.has(key)) throw new InvalidInputError(`unknown input field "${key}"`)
  }
  for (const field of contract.fields) {
    const has = Object.prototype.hasOwnProperty.call(values, field.fieldId)
    if (field.required && !has) throw new InvalidInputError(`required field "${field.fieldId}" is missing`)
    if (!has) continue
    const value = values[field.fieldId]
    validateFieldValue(field, value)
  }
}

function validateFieldValue(field: { readonly fieldId: string; readonly type: string; readonly min?: number | null; readonly max?: number | null; readonly enum?: readonly string[] | null }, value: unknown): void {
  const id = field.fieldId
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") throw new InvalidInputError(`field "${id}" must be a string`)
      if (field.min !== null && field.min !== undefined && value.length < field.min) throw new InvalidInputError(`field "${id}" is shorter than ${field.min}`)
      if (field.max !== null && field.max !== undefined && value.length > field.max) throw new InvalidInputError(`field "${id}" is longer than ${field.max}`)
      if (field.enum && !field.enum.includes(value)) throw new InvalidInputError(`field "${id}" must be one of ${field.enum.join(", ")}`)
      return
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidInputError(`field "${id}" must be a finite number`)
      if (field.min !== null && field.min !== undefined && value < field.min) throw new InvalidInputError(`field "${id}" is less than ${field.min}`)
      if (field.max !== null && field.max !== undefined && value > field.max) throw new InvalidInputError(`field "${id}" is greater than ${field.max}`)
      return
    }
    case "boolean": {
      if (typeof value !== "boolean") throw new InvalidInputError(`field "${id}" must be a boolean`)
      return
    }
    case "json": {
      if (value === null || typeof value !== "object") throw new InvalidInputError(`field "${id}" must be a JSON object/array`)
      return
    }
    case "artifact_ref": {
      if (typeof value !== "string" || value === "") throw new InvalidInputError(`field "${id}" must be a non-empty artifact reference string`)
      return
    }
    default:
      throw new InvalidInputError(`field "${id}" has unknown type "${field.type}"`)
  }
}

/** Build a durable, checksummed input revision from accepted values. The
 *  checksum is over the canonical (fieldId-sorted) values so tampering is
 *  detectable. The revision is immutable once stored. */
export function buildInputRevision(args: {
  readonly runId: string
  readonly values: Readonly<Record<string, unknown>>
  readonly now?: number
}): RunInputRevision {
  const checksum = createHash("sha256").update(stableString(args.values)).digest("hex")
  return {
    inputRevisionId: newInputRevisionId(),
    runId: args.runId,
    checksum,
    values: JSON.parse(JSON.stringify(args.values)) as Readonly<Record<string, unknown>>,
    createdAt: args.now ?? Date.now(),
  }
}

/** Recompute and compare a revision's checksum; throws on mismatch. */
export function verifyInputRevision(revision: RunInputRevision): void {
  const recomputed = createHash("sha256").update(stableString(revision.values)).digest("hex")
  if (recomputed !== revision.checksum) {
    throw new AutomationError("INPUT_CHECKSUM_MISMATCH", `Input revision ${revision.inputRevisionId} is corrupt (checksum mismatch)`)
  }
}

/** Convert raw InputValue[] into a fieldId→value map (last write wins per field
 *  is rejected as invalid — duplicate fields are an error). */
export function valuesToMap(values: readonly InputValue[]): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const v of values) {
    if (Object.prototype.hasOwnProperty.call(out, v.fieldId)) {
      throw new InvalidInputError(`duplicate input field "${v.fieldId}"`)
    }
    out[v.fieldId] = v.value
  }
  return out
}
