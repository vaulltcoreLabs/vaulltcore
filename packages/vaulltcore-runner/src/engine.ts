/**
 * Engine seam utilities for the neutral runner package.
 *
 * - {@link projectHistoryFromEvents}: shared projection of committed durable
 *   events into neutral chat history (used by engines on resume).
 * - {@link ScriptEngine}: deterministic engine used to prove the durable
 *   runner core without an external model. The OpenCode adapter lives in
 *   `@vaulltcore/runner-opencode`.
 */

import type {
  AgentEngine,
  ChatMessage,
  EngineInit,
  EngineSession,
  EngineTurnEvent,
  JobEvent,
  ToolDefinition,
} from "./contracts"

/**
 * Throwing this from an engine turn or tool simulates instantaneous worker
 * death: the runner performs no status mutation and persists nothing beyond
 * the last committed boundary. Test/simulation affordance only.
 */
export class SimulatedCrashError extends Error {
  constructor(message = "simulated worker crash") {
    super(message)
    this.name = "SimulatedCrashError"
  }
}

/** Project committed durable events into neutral chat history. */
export function projectHistoryFromEvents(events: readonly JobEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const event of events) {
    if (event.type === "message") {
      const data = event.data as {
        role: "user" | "assistant"
        text?: string
        toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>
      }
      const content: ChatMessage["content"][number][] = []
      if (data.text) content.push({ type: "text", text: data.text })
      for (const call of data.toolCalls ?? []) {
        content.push({ type: "tool_call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input })
      }
      messages.push({ role: data.role, content })
    }
    if (event.type === "tool_response") {
      const data = event.data as {
        toolCallId: string
        toolName: string
        output: unknown
        isError: boolean
        uncertain?: boolean
      }
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: data.toolCallId,
            toolName: data.toolName,
            output: data.output,
            isError: data.isError,
            ...(data.uncertain ? { uncertain: true } : {}),
          },
        ],
      })
    }
  }
  return messages
}

export interface ScriptTurn {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{ readonly toolName: string; readonly input?: unknown }>
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly reasoningTokens?: number }
}

interface ScriptSessionHandle {
  history: ChatMessage[]
  cursor: number
}

/**
 * Deterministic engine: each provider turn replays the next scripted turn.
 * Proves durability semantics (commit boundaries, idempotent settlement,
 * resume projection) without network calls.
 */
export class ScriptEngine implements AgentEngine {
  readonly id = "script"
  readonly version = "1"

  constructor(
    private readonly turns: readonly ScriptTurn[],
    private readonly hooks: {
      /** Runs at the start of each turn (stepIndex is 0-based). */
      readonly onTurnStart?: (stepIndex: number) => void | Promise<void>
      /** Runs after all turn events were yielded, before finish. */
      readonly onTurnEnd?: (stepIndex: number) => void | Promise<void>
    } = {},
  ) {}

  async createSession(init: EngineInit): Promise<EngineSession> {
    const handle: ScriptSessionHandle = {
      history: [{ role: "user", content: [{ type: "text", text: init.spec.input }] }],
      cursor: 0,
    }
    return { handle }
  }

  async restoreSession(_init: EngineInit, history: readonly ChatMessage[]): Promise<EngineSession> {
    const handle: ScriptSessionHandle = { history: [...history], cursor: 0 }
    // Cursor = number of assistant turns already committed.
    handle.cursor = history.filter((m) => m.role === "assistant").length
    return { handle }
  }

  async *runTurn(session: EngineSession, _tools: readonly ToolDefinition[], signal: AbortSignal): AsyncIterable<EngineTurnEvent> {
    const handle = session.handle as ScriptSessionHandle
    const stepIndex = handle.cursor
    await this.hooks.onTurnStart?.(stepIndex)
    if (signal.aborted) {
      yield { type: "finish", reason: "cancelled" }
      return
    }
    const turn = this.turns[stepIndex]
    if (!turn) {
      yield { type: "finish", reason: "stop" }
      return
    }
    if (turn.text) yield { type: "text", text: turn.text }
    const calls = turn.toolCalls ?? []
    for (const [index, call] of calls.entries()) {
      if (signal.aborted) {
        yield { type: "finish", reason: "cancelled" }
        return
      }
      yield {
        type: "tool_call",
        toolCallId: `call_${stepIndex}_${index}`,
        toolName: call.toolName,
        input: call.input ?? {},
      }
    }
    if (turn.usage) yield { type: "usage", usage: turn.usage }
    await this.hooks.onTurnEnd?.(stepIndex)
    yield { type: "finish", reason: calls.length > 0 ? "tool_calls" : "stop" }
    handle.cursor++
  }

  recordAssistantTurn(session: EngineSession, message: ChatMessage): void {
    ;(session.handle as ScriptSessionHandle).history.push(message)
  }

  recordToolResults(session: EngineSession, results: readonly ChatMessage[]): void {
    ;(session.handle as ScriptSessionHandle).history.push(...results)
  }

  recordUserInput(session: EngineSession, text: string): void {
    ;(session.handle as ScriptSessionHandle).history.push({ role: "user", content: [{ type: "text", text }] })
  }

  projectHistory(events: readonly JobEvent[]): ChatMessage[] {
    return projectHistoryFromEvents(events)
  }
}
