/**
 * OpenCodeEngine — the AgentEngine adapter wrapping the extracted OpenCode
 * kernel behind Vaulltcore's neutral seam.
 *
 * Translations performed here:
 *   Vaulltcore Job            → OpenCode-style execution/session
 *   durable Vaulltcore events → engine history (session projection)
 *   fine-grained LLM events   → runner-neutral EngineTurnEvents
 *   neutral tool definitions  → OpenCode wire tool definitions
 *
 * The runner owns durability, settlement, and cancellation; this engine owns
 * prompt/history assembly and one-provider-turn-per-step streaming.
 */

import type {
  AgentEngine,
  ChatMessage,
  EngineInit,
  EngineSession,
  EngineTurnEvent,
  JobEvent,
  ToolDefinition,
} from "@vaulltcore/runner"
import { projectHistoryFromEvents } from "@vaulltcore/runner"
import type { ModelProvider } from "./kernel/llm"
import type { SessionProviderResolver } from "./model-provider"
import { normalizeTurnEvent, toolWireDefinition } from "./kernel/normalize"

const ENGINE_ID = "opencode"
const ENGINE_VERSION = "1"

interface OpenCodeSessionHandle {
  provider: ModelProvider
  model: string
  system?: string
  history: ChatMessage[]
}

export class OpenCodeEngine implements AgentEngine {
  readonly id = ENGINE_ID
  readonly version = ENGINE_VERSION

  /**
   * @param resolveProvider Seam that yields the {@link ModelProvider} for a
   * session. Tests supply `ProviderRegistry.resolver()` (deterministic);
   * production supplies the models bridge resolver (`./models-bridge`). The
   * engine never hard-codes a provider source.
   */
  constructor(private readonly resolveProvider: SessionProviderResolver) {}

  async createSession(init: EngineInit): Promise<EngineSession> {
    const provider = await this.resolveProvider(init)
    const handle: OpenCodeSessionHandle = {
      provider,
      model: init.spec.model,
      system: typeof init.spec.engineOptions?.system === "string" ? init.spec.engineOptions.system : undefined,
      history: [{ role: "user", content: [{ type: "text", text: init.spec.input }] }],
    }
    return { handle }
  }

  async restoreSession(init: EngineInit, history: readonly ChatMessage[]): Promise<EngineSession> {
    const provider = await this.resolveProvider(init)
    const handle: OpenCodeSessionHandle = {
      provider,
      model: init.spec.model,
      system: typeof init.spec.engineOptions?.system === "string" ? init.spec.engineOptions.system : undefined,
      history: [...history],
    }
    return { handle }
  }

  async *runTurn(session: EngineSession, tools: readonly ToolDefinition[], signal: AbortSignal): AsyncIterable<EngineTurnEvent> {
    const handle = session.handle as OpenCodeSessionHandle
    const request = {
      model: handle.model,
      messages: this.toWireMessages(handle.history),
      ...(handle.system ? { system: handle.system } : {}),
      tools: tools.map(toolWireDefinition),
    }
    for await (const event of handle.provider.stream(request, signal)) {
      const normalized = normalizeTurnEvent(event)
      if (normalized) {
        if (Array.isArray(normalized)) for (const item of normalized) yield item
        else yield normalized
      }
    }
  }

  recordAssistantTurn(session: EngineSession, message: ChatMessage): void {
    ;(session.handle as OpenCodeSessionHandle).history.push(message)
  }

  recordToolResults(session: EngineSession, results: readonly ChatMessage[]): void {
    ;(session.handle as OpenCodeSessionHandle).history.push(...results)
  }

  recordUserInput(session: EngineSession, text: string): void {
    ;(session.handle as OpenCodeSessionHandle).history.push({ role: "user", content: [{ type: "text", text }] })
  }

  projectHistory(events: readonly JobEvent[]): ChatMessage[] {
    return projectHistoryFromEvents(events)
  }

  /** Convert neutral history into the wire shape sent to the provider. */
  private toWireMessages(history: readonly ChatMessage[]): unknown[] {
    return history.map((message) => {
      const parts: unknown[] = []
      for (const part of message.content) {
        switch (part.type) {
          case "text":
            parts.push({ type: "text", text: part.text })
            break
          case "tool_call":
            parts.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
            break
          case "tool_result":
            parts.push({
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
              isError: part.isError,
              ...(part.uncertain ? { uncertain: true } : {}),
            })
            break
        }
      }
      return { role: message.role, content: parts }
    })
  }
}
