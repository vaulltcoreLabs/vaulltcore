/**
 * ModelProvider registry + a deterministic scripted provider.
 *
 * The registry is the deterministic/test path: `ScriptModelProvider` replays
 * fine-grained OpenCode LLM events so the durable pipeline — including the
 * fine→neutral event normalization — is exercised without network calls. It is
 * NOT the production engine path. The production path resolves a credential-
 * backed {@link ModelProviderAdapter} from `@vaulltcore/models` via the
 * `modelsProviderResolver` bridge (`./models-bridge.ts`) and selects the
 * {@link OpenCodeEngine} via `buildOpenCodeEngine` (`./compose.ts`).
 *
 * `SessionProviderResolver` is the seam between engine construction and
 * provider source: tests use `ProviderRegistry.resolver()`, production uses
 * `modelsProviderResolver`. The engine never hard-codes a provider source.
 */

import type { EngineInit } from "@vaulltcore/runner"
import type { LLMEvent, LLMRequest, ModelProvider } from "./kernel/llm"

export interface ProviderEntry {
  readonly model: string
  readonly provider: ModelProvider
}

/**
 * Resolves the {@link ModelProvider} for a job session from its
 * {@link EngineInit}. May be async because the production resolver hits the
 * credential-backed {@link ModelRegistry}. `ProviderRegistry.resolver()` and
 * the models bridge in `./models-bridge` both produce this seam;
 * `OpenCodeEngine` consumes it so the engine never hard-codes a provider
 * source.
 */
export type SessionProviderResolver = (init: EngineInit) => ModelProvider | Promise<ModelProvider>

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>()

  constructor(entries: readonly ProviderEntry[]) {
    for (const entry of entries) this.providers.set(entry.model, entry.provider)
  }

  resolve(model: string): ModelProvider {
    const provider = this.providers.get(model)
    if (!provider) throw new Error(`No model provider registered for "${model}"`)
    return provider
  }

  /** Adapt this registry to the engine's session resolver (deterministic path). */
  resolver(): SessionProviderResolver {
    return (init) => this.resolve(init.spec.model)
  }
}

export interface ScriptedTurn {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{ readonly toolName: string; readonly input?: unknown }>
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly reasoningTokens?: number }
}

/**
 * Deterministic ModelProvider that replays scripted provider turns.
 *
 * Stateless like a real provider: the turn index is derived from the number
 * of assistant messages in the request history, so a fresh provider instance
 * resumes correctly from a restored session.
 */
export class ScriptModelProvider implements ModelProvider {
  readonly id = "script"

  constructor(
    private readonly turns: readonly ScriptedTurn[],
    private readonly hooks: {
      readonly onTurnStart?: (stepIndex: number) => void
    } = {},
  ) {}

  async *stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    const stepIndex = (request.messages as ReadonlyArray<{ role?: string }>).filter((m) => m?.role === "assistant").length
    this.hooks.onTurnStart?.(stepIndex)
    const turn = this.turns[stepIndex]
    yield { type: "step-start" }
    if (!turn || signal.aborted) {
      yield { type: "finish", reason: signal.aborted ? "stop" : "stop" }
      return
    }
    if (turn.text) {
      yield { type: "text-start" }
      yield { type: "text-delta", text: turn.text }
      yield { type: "text-end" }
    }
    const calls = turn.toolCalls ?? []
    for (const [index, call] of calls.entries()) {
      const toolCallId = `call_${stepIndex}_${index}`
      const input = JSON.stringify(call.input ?? {})
      yield { type: "tool-input-start", toolCallId, toolName: call.toolName }
      yield { type: "tool-input-delta", toolCallId, inputDelta: input }
      yield { type: "tool-input-end", toolCallId }
      if (signal.aborted) break
      yield { type: "tool-call", toolCallId, toolName: call.toolName, input: call.input ?? {} }
    }
    if (turn.usage) yield { type: "usage", usage: turn.usage }
    yield { type: "step-finish" }
    yield { type: "finish", reason: calls.length > 0 ? "tool_calls" : "stop" }
  }
}
