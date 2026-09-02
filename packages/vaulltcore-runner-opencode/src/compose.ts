/**
 * Explicit production composition for the OpenCode engine.
 *
 * `buildOpenCodeEngine` selects {@link OpenCodeEngine} as the production
 * {@link AgentEngine}, wired to the BYOK {@link ModelRegistry} for
 * credential-backed model adapters. It is the narrow, explicit seam the
 * platform (control-plane worker/daemon) uses to construct the real engine
 * path:
 *
 *     DurableAgentRunner → AgentEngine(OpenCodeEngine) → ModelProvider →
 *         ModelProviderAdapter (models/BYOK credential boundary)
 *
 * Deterministic tests keep using `ProviderRegistry.resolver()` (scripted
 * provider); this factory is the production alternative and is never hard-coded
 * into the neutral runner.
 */

import type { AgentEngine } from "@vaulltcore/runner"
import type { ModelRegistry } from "@vaulltcore/models"
import { OpenCodeEngine } from "./opencode-engine"
import { modelsProviderResolver } from "./models-bridge"

export interface OpenCodeEngineComposeOptions {
  /** engineOptions key for the model connection id (default `connectionId`). */
  readonly connectionKey?: string
  /** engineOptions key for the provider id (default `provider`). */
  readonly providerKey?: string
}

/** Construct the production {@link OpenCodeEngine} over a BYOK registry. */
export function buildOpenCodeEngine(registry: ModelRegistry, options?: OpenCodeEngineComposeOptions): AgentEngine {
  return new OpenCodeEngine(modelsProviderResolver(registry, options))
}