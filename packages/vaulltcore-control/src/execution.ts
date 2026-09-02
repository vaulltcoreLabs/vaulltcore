/**
 * Explicit production execution composition (Phase 3A.1).
 *
 * Assembles the faithful production engine path for the platform:
 *
 *     DurableAgentRunner → AgentEngine(OpenCodeEngine) → ModelProvider →
 *         ModelProviderAdapter (models/BYOK credential boundary)
 *
 * `DurableAgentRunner` remains the sole execution authority; the OpenCode
 * engine is an adapter behind the neutral `AgentEngine` seam. The BYOK
 * `ModelRegistry` supplies credential-backed real adapters; public model
 * connection identifiers (`connectionId`, `provider`) are carried in
 * `JobSpec.engineOptions` — never secrets. Secrets cross only the
 * `CredentialResolver` boundary inside the registry/adapter and are never
 * serialized into events, state, errors, or logs.
 *
 * Deterministic tests keep using `ProviderRegistry.resolver()` + a scripted
 * provider (see `@vaulltcore/runner-opencode`); this module is the production
 * alternative and is not hard-coded into the neutral runner.
 */

import type { DurableJobStore, ExecutionEnvironment, RunnerDeps, SnapshotPolicy, Tool, WorkspaceProvider } from "@vaulltcore/runner"
import { DurableAgentRunner } from "@vaulltcore/runner"
import type { ModelRegistry } from "@vaulltcore/models"
import { buildOpenCodeEngine, type OpenCodeEngineComposeOptions } from "@vaulltcore/runner-opencode"

export interface OpenCodeExecutionOptions {
  readonly store: DurableJobStore
  readonly registry: ModelRegistry
  readonly tools?: readonly Tool[]
  readonly workspace?: WorkspaceProvider | null
  readonly environment?: ExecutionEnvironment | null
  readonly snapshotPolicy?: SnapshotPolicy
  /** OpenCode engineOptions key names for connectionId/provider. */
  readonly providerKeys?: OpenCodeEngineComposeOptions
}

/**
 * Build a production `DurableAgentRunner` whose engine is `OpenCodeEngine`
 * backed by the BYOK model registry. Callers (a future worker/daemon) own the
 * store and tool set; this factory selects the engine once.
 */
export function buildOpenCodeRunner(options: OpenCodeExecutionOptions): DurableAgentRunner {
  const engine = buildOpenCodeEngine(options.registry, options.providerKeys)
  const deps: RunnerDeps = {
    store: options.store,
    engines: [engine],
    tools: options.tools ?? [],
    workspace: options.workspace ?? null,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.snapshotPolicy ? { snapshotPolicy: options.snapshotPolicy } : {}),
  }
  return new DurableAgentRunner(deps)
}