/**
 * Minimal OpenCode LLM kernel, extracted as dependency-free plain types.
 *
 * Source (MIT License, Copyright (c) 2025 opencode):
 * - https://github.com/anomalyco/opencode/tree/dev/packages/llm/src/schema/messages.ts
 * - https://github.com/anomalyco/opencode/tree/dev/packages/llm/src/schema/events.ts
 * - https://github.com/anomalyco/opencode/tree/dev/packages/llm/src/llm.ts
 *
 * The upstream pieces use effect Schema; here the same wire shapes are kept
 * as plain TypeScript so the adapter carries the schema-first design without
 * the runtime framework. Routines are wire-compatible subsets.
 */

// ---------------------------------------------------------------------------
// Usage (extracted shape from LLM.Usage)
// ---------------------------------------------------------------------------

export interface LLMUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

// ---------------------------------------------------------------------------
// Streaming event vocabulary (extracted from LLMEvent)
// ---------------------------------------------------------------------------

/** Exactly the fine-grained vocabulary of opencode's `LLMEvent`. */
export type LLMEvent =
  | { readonly type: "step-start" }
  | { readonly type: "text-start" }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "text-end" }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-input-start"; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: "tool-input-delta"; readonly toolCallId: string; readonly inputDelta: string }
  | { readonly type: "tool-input-end"; readonly toolCallId: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly input: unknown }
  | { readonly type: "usage"; readonly usage: LLMUsage }
  | { readonly type: "step-finish" }
  | { readonly type: "finish"; readonly reason: "stop" | "tool_calls" | "max_tokens" }
  | { readonly type: "provider-error"; readonly message: string }

export type LLMFinishReason = "stop" | "tool_calls" | "max_tokens"

// ---------------------------------------------------------------------------
// Request (extracted shape from LLMRequest)
// ---------------------------------------------------------------------------

export interface LLMRequest {
  readonly model: string
  readonly messages: readonly unknown[]
  readonly tools?: readonly unknown[]
  readonly system?: string
  readonly options?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Model boundary (extracted concept: `llm.stream(request)` = one provider turn)
// ---------------------------------------------------------------------------

export interface ModelProvider {
  readonly id: string
  /** Stream exactly one provider turn. Cancellation must be honored. */
  stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent>
}

export function isProviderError(event: LLMEvent): event is Extract<LLMEvent, { type: "provider-error" }> {
  return event.type === "provider-error"
}
