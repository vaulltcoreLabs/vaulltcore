/**
 * Built-in model descriptor catalog (Phase 2C).
 *
 * Immutable {@link ModelDescriptor}s for known providers/models. Cost metadata
 * is pinned per descriptor and NEVER rewritten historically (Phase 1E billing
 * immutability): pricing changes ship a new descriptor version, not an in-
 * place mutation. A tenant may also register custom OpenAI-compatible
 * descriptors for self-hosted/gateway endpoints.
 */

import type { ModelDescriptor } from "./contracts"

export const OPENAI_GPT4O: ModelDescriptor = {
  provider: "openai", model: "gpt-4o", label: "GPT-4o",
  contextWindow: 128000, maxOutputTokens: 16384, supportsTools: true, supportsReasoning: false,
  pricing: { inputPerMillion: 2.5, outputPerMillion: 10 }, metadata: { family: "gpt-4o" },
}

export const ANTHROPIC_SONNET: ModelDescriptor = {
  provider: "anthropic", model: "claude-sonnet-4-20250514", label: "Claude Sonnet 4",
  contextWindow: 200000, maxOutputTokens: 64000, supportsTools: true, supportsReasoning: true,
  pricing: { inputPerMillion: 3, outputPerMillion: 15 }, metadata: { family: "claude" },
}

export const GOOGLE_GEMINI_PRO: ModelDescriptor = {
  provider: "google", model: "gemini-1.5-pro", label: "Gemini 1.5 Pro",
  contextWindow: 2000000, maxOutputTokens: 8192, supportsTools: true, supportsReasoning: false,
  pricing: { inputPerMillion: 1.25, outputPerMillion: 5 }, metadata: { family: "gemini" },
}

/** A custom OpenAI-compatible descriptor for self-hosted/gateway endpoints. */
export function customOpenAICompatibleDescriptor(provider: string, model: string, label: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    provider, model, label,
    contextWindow: null, maxOutputTokens: null, supportsTools: true, supportsReasoning: false,
    pricing: null, metadata: {},
    ...overrides,
  }
}

export const BUILTIN_DESCRIPTORS: readonly ModelDescriptor[] = [OPENAI_GPT4O, ANTHROPIC_SONNET, GOOGLE_GEMINI_PRO]
