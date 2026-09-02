/**
 * Vaulltcore BYOK Model Plane (Phase 2C).
 *
 * Provider-neutral model credential + adapter system. BYOK credentials flow
 * only through the {@link ModelRegistry} → {@link ModelProviderAdapter}
 * boundary. The existing runner `AgentEngine`/`ModelProvider` seam remains
 * authoritative; the agent layer bridges neutral {@link ModelStreamEvent}s →
 * runner events. This package never depends on the runner.
 *
 * Adapters: OpenAI-compatible (OpenAI, OpenRouter, Azure-compatible, generic),
 * Anthropic, Google (Gemini). No provider SDK is a dependency of core.
 *
 * Dependency direction: models → {credentials, integration}. Never depends on
 * the runner, a provider SDK, or the control plane. No single LLM provider is
 * a dependency.
 */

export type {
  ModelMessage,
  ModelTool,
  ModelRequest,
  ModelStreamEvent,
  ModelUsage,
  ModelDescriptor,
  ModelProviderAdapter,
  ModelRestrictions,
  ResolvedModel,
} from "./contracts"
export { ModelNotAllowedError } from "./contracts"
export { ModelRegistry, type ModelAdapterFactory, type ModelRegistryOptions } from "./registry"
export { openAICompatibleAdapter, type OpenAICompatibleOptions } from "./openai-compatible"
export { anthropicAdapter, type AnthropicOptions } from "./anthropic"
export { googleAdapter, type GoogleOptions } from "./google"
export {
  OPENAI_GPT4O,
  ANTHROPIC_SONNET,
  GOOGLE_GEMINI_PRO,
  customOpenAICompatibleDescriptor,
  BUILTIN_DESCRIPTORS,
} from "./catalog"
// Phase 2D: model connection activation service (BYOK verify/activate/health).
export {
  ModelConnectionService,
  type ModelConnectionServiceOptions,
  type ModelConnectionView,
  type RegisterModelConnectionInput,
  type VerifyConnectivityResult,
} from "./connection-service"
