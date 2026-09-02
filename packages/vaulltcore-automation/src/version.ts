/**
 * Immutable automation versions: definition checksum + step-graph validation
 * (Phase 2A).
 *
 * Phase 2A is deliberately NOT a general workflow engine. The definition
 * supports one or more named, bounded execution steps forming a DAG (no loops,
 * no unbounded recursion). Validation runs before publication so a corrupt or
 * structurally invalid definition can never be published as an immutable
 * version.
 *
 * The checksum is a SHA-256 over the canonical (deterministically-serialized)
 * definition + input contract. It is persisted with the version and re-verified
 * on load so any mutation or corruption of the durable definition is detectable.
 */

import { createHash } from "node:crypto"
import {
  type AutomationDefinition,
  type AutomationStep,
  type AutomationVersion,
  type InputContract,
  AutomationError,
} from "./contracts"
import { newVersionId } from "./ids"

/** Deterministic JSON serialization (sorted keys, stable arrays) so the same
 *  definition always produces the same checksum regardless of property order. */
export function stableString(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableString(v)}`)
  return `{${entries.join(",")}}`
}

/** SHA-256 over the canonical definition + input contract. */
export function definitionChecksum(definition: AutomationDefinition, inputContract: InputContract): string {
  return createHash("sha256").update(stableString({ definition, inputContract })).digest("hex")
}

/** Recompute the checksum and compare; throws on mismatch (corruption). */
export function verifyVersionChecksum(version: AutomationVersion): void {
  const recomputed = definitionChecksum(version.definition, version.inputContract)
  if (recomputed !== version.checksum) {
    throw new AutomationError("VERSION_CHECKSUM_MISMATCH", `Version ${version.versionId} definition is corrupt (checksum mismatch)`)
  }
}

// ---------------------------------------------------------------------------
// Step-graph validation
// ---------------------------------------------------------------------------

export class InvalidDefinitionError extends AutomationError {
  constructor(reason: string) {
    super("INVALID_DEFINITION", `Invalid automation definition: ${reason}`, 400)
  }
}

/** Validate a definition's step graph before publication. Rejects:
 *  - duplicate step IDs
 *  - cycles
 *  - missing dependencies
 *  - artifact step references outside the version
 *  - invalid input mappings (fieldId not in the contract / placeholder empty)
 *  - approval context artifacts referencing unknown artifacts
 *  - delivery artifacts referencing unknown artifacts
 *  - empty definition (at least one step required) */
export function validateDefinition(definition: AutomationDefinition, inputContract: InputContract): void {
  const steps = definition.steps
  if (steps.length === 0) throw new InvalidDefinitionError("at least one step is required")

  const stepIds = new Set<string>()
  for (const step of steps) {
    if (!step.stepId) throw new InvalidDefinitionError("stepId is required")
    if (stepIds.has(step.stepId)) throw new InvalidDefinitionError(`duplicate stepId "${step.stepId}"`)
    stepIds.add(step.stepId)
    if (!step.execution.engine) throw new InvalidDefinitionError(`step "${step.stepId}" has no engine`)
    if (!step.execution.model) throw new InvalidDefinitionError(`step "${step.stepId}" has no model`)
    if (!step.execution.prompt) throw new InvalidDefinitionError(`step "${step.stepId}" has no prompt`)
    // input mappings must reference declared contract fields
    const placeholders = new Set<string>()
    for (const m of step.inputMappings) {
      if (!m.fieldId) throw new InvalidDefinitionError(`step "${step.stepId}" inputMapping has no fieldId`)
      if (!inputContract.fields.some((f) => f.fieldId === m.fieldId)) {
        throw new InvalidDefinitionError(`step "${step.stepId}" maps unknown input field "${m.fieldId}"`)
      }
      if (!m.placeholder) throw new InvalidDefinitionError(`step "${step.stepId}" inputMapping has no placeholder`)
      if (placeholders.has(m.placeholder)) throw new InvalidDefinitionError(`step "${step.stepId}" duplicate placeholder "${m.placeholder}"`)
      placeholders.add(m.placeholder)
    }
    // output mappings must have a key + path
    const outKeys = new Set<string>()
    for (const o of step.outputMappings) {
      if (!o.key) throw new InvalidDefinitionError(`step "${step.stepId}" outputMapping has no key`)
      if (outKeys.has(o.key)) throw new InvalidDefinitionError(`step "${step.stepId}" duplicate output key "${o.key}"`)
      outKeys.add(o.key)
      if (!o.path) throw new InvalidDefinitionError(`step "${step.stepId}" outputMapping has no path`)
    }
  }

  validateStepGraph(steps)

  // artifacts must reference known steps
  const artifactIds = new Set<string>()
  for (const art of definition.artifacts) {
    if (!art.artifactId) throw new InvalidDefinitionError("artifact has no artifactId")
    if (artifactIds.has(art.artifactId)) throw new InvalidDefinitionError(`duplicate artifactId "${art.artifactId}"`)
    artifactIds.add(art.artifactId)
    if (!stepIds.has(art.stepId)) throw new InvalidDefinitionError(`artifact "${art.artifactId}" references unknown step "${art.stepId}"`)
  }
  // approval context artifacts + delivery artifacts must reference known artifacts
  for (const id of definition.approval.contextArtifacts) {
    if (!artifactIds.has(id)) throw new InvalidDefinitionError(`approval context references unknown artifact "${id}"`)
  }
  for (const id of definition.delivery.artifactIds) {
    if (!artifactIds.has(id)) throw new InvalidDefinitionError(`delivery references unknown artifact "${id}"`)
  }
  if (!definition.approval.required && definition.approval.gateId) {
    throw new InvalidDefinitionError("approval gateId must not be set when approval is not required")
  }
  if (definition.approval.required && !definition.approval.gateId) {
    throw new InvalidDefinitionError("approval gateId is required when approval is required")
  }
}

/** Validate the step graph in isolation: duplicate step IDs, self/duplicate
 *  dependencies, missing dependency references, and cycles (Kahn topological
 *  sort). Exported so callers can validate a graph before building a full
 *  definition. */
export function validateStepGraph(steps: readonly AutomationStep[]): void {
  const stepIds = new Set<string>()
  for (const step of steps) {
    if (!step.stepId) throw new InvalidDefinitionError("stepId is required")
    if (stepIds.has(step.stepId)) throw new InvalidDefinitionError(`duplicate stepId "${step.stepId}"`)
    stepIds.add(step.stepId)
    const deps = new Set<string>()
    for (const dep of step.dependsOn) {
      if (dep === step.stepId) throw new InvalidDefinitionError(`step "${step.stepId}" depends on itself`)
      if (deps.has(dep)) throw new InvalidDefinitionError(`step "${step.stepId}" duplicate dependency "${dep}"`)
      deps.add(dep)
    }
  }
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of stepIds) {
    indeg.set(id, 0)
    adj.set(id, [])
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) throw new InvalidDefinitionError(`step "${step.stepId}" depends on unknown step "${dep}"`)
      adj.get(dep)!.push(step.stepId)
      indeg.set(step.stepId, (indeg.get(step.stepId) ?? 0) + 1)
    }
  }
  const queue: string[] = []
  for (const [id, d] of indeg) if (d === 0) queue.push(id)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    visited++
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1)
      if (indeg.get(next) === 0) queue.push(next)
    }
  }
  if (visited !== stepIds.size) throw new InvalidDefinitionError("step graph contains a cycle")
}

/** Build an immutable, validated, checksummed version. The caller supplies the
 *  next monotonic version number (enforced unique per template by the store). */
export function buildVersion(args: {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly templateId: string
  readonly version: number
  readonly definition: AutomationDefinition
  readonly inputContract: InputContract
  readonly createdBy: string
  readonly now?: number
}): AutomationVersion {
  validateDefinition(args.definition, args.inputContract)
  const checksum = definitionChecksum(args.definition, args.inputContract)
  const now = args.now ?? Date.now()
  return {
    versionId: newVersionId(),
    tenantId: args.tenantId,
    orgId: args.orgId,
    projectId: args.projectId,
    templateId: args.templateId,
    version: args.version,
    definition: args.definition,
    inputContract: args.inputContract,
    checksum,
    createdAt: now,
    createdBy: args.createdBy,
  }
}

/** Resolve the execution order of steps (topological). Stable: steps appear in
 *  declaration order among independent nodes. Used by the orchestrator. */
export function executionOrder(steps: readonly AutomationStep[]): string[] {
  const byId = new Map(steps.map((s) => [s.stepId, s]))
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const s of steps) {
    indeg.set(s.stepId, 0)
    adj.set(s.stepId, [])
  }
  for (const s of steps) {
    for (const dep of s.dependsOn) {
      adj.get(dep)!.push(s.stepId)
      indeg.set(s.stepId, (indeg.get(s.stepId) ?? 0) + 1)
    }
  }
  // Preserve declaration order among ready nodes for determinism.
  const ready = steps.filter((s) => (indeg.get(s.stepId) ?? 0) === 0).map((s) => s.stepId)
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1)
      if ((indeg.get(next) ?? 0) === 0) ready.push(next)
    }
  }
  // Defensive: caller has already validated (no cycle), so order is complete.
  void byId
  return order
}
