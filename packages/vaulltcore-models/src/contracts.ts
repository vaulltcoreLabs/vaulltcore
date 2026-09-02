/**
 * Neutral BYOK model plane contracts (Phase 2C).
 *
 * Provider-neutral model credential + adapter surface. A BYOK "model
 * connection" is a credential (family "model") whose secret is a provider API
 * key. The {@link ModelRegistry} resolves a (tenant, modelId) to a
 * {@link ModelProviderAdapter} that streams a single provider turn as neutral
 * {@link ModelStreamEvent}s. The existing runner `AgentEngine`/`ModelProvider`
 * seam remains authoritative; the agent layer bridges neutral events → runner
 * events. This package does NOT depend on the runner.
 *
 * Security: secrets flow only through the resolved credential; never logged,
 * never returned by list/get. Cost metadata is immutable per
 * {@link ModelDescriptor}; usage attribution is compatible with Phase 1E
 * metering (inputTokens/outputTokens → UsageEvent). Rate-limit/auth/transient
 * errors normalized via the shared {@link IntegrationError} + retry
 * classification.
 */

import type { ResolvedCredential } from "@vaulltcore/credentials"
import type { IntegrationError } from "@vaulltcore/integration"

/** A model message (neutral; provider-agnostic). */
export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content: string
  readonly toolCallId?: string
  readonly toolCalls?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: unknown }>
}

/** A tool definition (neutral). */
export interface ModelTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

/** A request to stream one provider turn. */
export interface ModelRequest {
  readonly model: string
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly ModelTool[]
  readonly system?: string
  readonly maxTokens?: number
  readonly temperature?: number
  readonly options?: Readonly<Record<string, unknown>>
}

/** Neutral streaming event vocabulary (mirrors the runner's fine-grained
 *  shape, but owned here so this package is runner-free). */
export type ModelStreamEvent =
  | { readonly type: "step-start" }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-input-delta"; readonly toolCallId: string; readonly inputDelta: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly name: string; readonly input: unknown }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "step-finish" }
  | { readonly type: "finish"; readonly reason: "stop" | "tool_calls" | "max_tokens" }
  | { readonly type: "error"; readonly error: IntegrationError }

export interface ModelUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly reasoningTokens?: number
}

/** Immutable provider/model cost + capability metadata. */
export interface ModelDescriptor {
  readonly provider: string
  readonly model: string
  readonly label: string
  readonly contextWindow: number | null
  readonly maxOutputTokens: number | null
  readonly supportsTools: boolean
  readonly supportsReasoning: boolean
  /** Cost per 1M tokens (USD); immutable per descriptor version. */
  readonly pricing: { readonly inputPerMillion: number; readonly outputPerMillion: number } | null
  readonly metadata: Readonly<Record<string, unknown>>
}

/** A neutral model provider adapter: stream one turn. */
export interface ModelProviderAdapter {
  readonly descriptor: ModelDescriptor
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>
}

/** Tenant/project model restrictions (enforced by the registry). */
export interface ModelRestrictions {
  readonly allowedProviders?: readonly string[]
  readonly allowedModels?: readonly string[]
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
}

/** Result of resolving a model for a tenant. */
export interface ResolvedModel {
  readonly adapter: ModelProviderAdapter
  readonly descriptor: ModelDescriptor
  readonly credential: ResolvedCredential
}

/** Error thrown when a model is not allowed for a tenant. */
export class ModelNotAllowedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelNotAllowedError"
  }
}
