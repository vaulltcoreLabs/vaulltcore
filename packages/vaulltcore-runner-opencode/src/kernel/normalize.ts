/**
 * Normalization of fine-grained OpenCode LLM events into the runner's
 * neutral EngineTurnEvent vocabulary.
 *
 * Keeps the OpenCode-internal event names (step-start, text-delta, tool-call,
 * step-finish, usage, finish, provider-error) from leaking into Vaulltcore's
 * public JobEvent vocabulary — the runner only ever sees the normalized
 * text / tool_call / usage / finish variants.
 */

import type { EngineTurnEvent, ToolDefinition } from "@vaulltcore/runner"
import type { LLMEvent } from "./llm"

export function normalizeTurnEvent(event: LLMEvent): EngineTurnEvent | EngineTurnEvent[] | null {
  switch (event.type) {
    case "text-delta":
      return { type: "text", text: event.text }
    case "tool-call":
      return { type: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }
    case "usage":
      return { type: "usage", usage: event.usage }
    case "finish":
      return { type: "finish", reason: event.reason }
    case "provider-error":
      throw new Error(`provider error: ${event.message}`)
    // Fine-grained markers that carry no durable payload.
    case "step-start":
    case "text-start":
    case "text-end":
    case "reasoning-delta":
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-end":
    case "step-finish":
      return null
  }
  return null
}

export function toolWireDefinition(tool: ToolDefinition): Record<string, unknown> {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}
