/**
 * Bridge from a BYOK {@link ModelProviderAdapter} (`@vaulltcore/models`) to
 * the OpenCode wire {@link ModelProvider} seam (`./kernel/llm.ts`).
 *
 * The models plane is its own vendor-neutral vocabulary (`ModelRequest` /
 * `ModelStreamEvent`); the OpenCode kernel is a separate wire vocabulary
 * (`LLMRequest` / `LLMEvent`). This adapter translates the two so the real,
 * credential-backed adapters (OpenAI-compatible, Anthropic, Google) flow
 * through `OpenCodeEngine` -> `AgentEngine` -> `DurableAgentRunner` without
 * leaking either vocabulary into the neutral runner.
 *
 * Secrets: a resolved `ModelProviderAdapter` holds the credential material
 * transiently (from `CredentialResolver`); this bridge never serializes it
 * into any event, state, or error it produces. Provider failures are surfaced
 * as the wire `provider-error` event with a sanitized message.
 *
 * This is an adapter between two neutral planes; neither translates raw
 * provider SDK types. Dependency direction: runner-opencode -> models (no
 * cycle; models never imports the runner).
 */

import type {
  ModelMessage,
  ModelProviderAdapter,
  ModelRegistry,
  ModelRequest,
  ModelStreamEvent,
  ModelTool,
} from "@vaulltcore/models"
import type { EngineInit } from "@vaulltcore/runner"
import type { LLMEvent, LLMRequest, ModelProvider } from "./kernel/llm"
import type { SessionProviderResolver } from "./model-provider"

interface WireMessage {
  readonly role: string
  readonly content?: ReadonlyArray<Record<string, unknown>>
}

interface WireTextPart {
  readonly type: "text"
  readonly text: string
}
interface WireToolCallPart {
  readonly type: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}
interface WireToolResultPart {
  readonly type: "tool-result"
  readonly toolCallId: string
  readonly toolName: string
  readonly output: unknown
  readonly isError?: boolean
  readonly uncertain?: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

/** Content of a plain text part; refuse arbitrary shapes. */
function asText(part: Record<string, unknown>): string | null {
  const p = part as unknown as WireTextPart
  if (part.type === "text" && typeof p.text === "string") return p.text
  return null
}

function asToolCall(part: Record<string, unknown>): WireToolCallPart | null {
  const p = part as unknown as WireToolCallPart
  if (part.type === "tool-call" && typeof p.toolCallId === "string" && typeof p.toolName === "string") return p
  return null
}

function asToolResult(part: Record<string, unknown>): WireToolResultPart | null {
  const p = part as unknown as WireToolResultPart
  if (part.type === "tool-result" && typeof p.toolCallId === "string" && typeof p.toolName === "string") return p
  return null
}

/** Render an opaque tool output as a string for the model message. */
function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output
  try {
    const s = JSON.stringify(output)
    return s === undefined ? "[undefined]" : s
  } catch {
    return "[unserializable]"
  }
}

/**
 * Translate one OpenCode wire message (role + typed content parts) into the
 * models plane's flat `ModelMessage[]`. Assistant text and tool calls stay
 * together on one message; each tool result becomes its own `role: "tool"`
 * message (the models adapters require that shape).
 */
function wireMessagesToModel(wire: readonly unknown[]): ModelMessage[] {
  const out: ModelMessage[] = []
  for (const m of wire) {
    const msg = m as WireMessage
    if (typeof msg !== "object" || msg === null || typeof msg.role !== "string") {
      throw new Error("malformed model message")
    }
    const parts = Array.isArray(msg.content) ? msg.content : []
    if (msg.role === "tool") {
      for (const part of parts) {
        const result = asToolResult(part)
        if (!result) throw new Error("malformed tool result part")
        out.push({ role: "tool", toolCallId: result.toolCallId, content: toolOutputText(result.output) })
      }
      continue
    }
    const texts: string[] = []
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
    for (const part of parts) {
      const text = asText(part)
      if (text !== null) {
        texts.push(text)
        continue
      }
      const call = asToolCall(part)
      if (call) {
        toolCalls.push({ id: call.toolCallId, name: call.toolName, input: call.input })
        continue
      }
      throw new Error("malformed message part")
    }
    const content = texts.join("\n")
    const entry: ModelMessage = { role: msg.role as ModelMessage["role"], content, ...(toolCalls.length ? { toolCalls } : {}) }
    out.push(entry)
  }
  return out
}

function translateTools(wire: readonly unknown[] | undefined): ModelTool[] | undefined {
  if (!Array.isArray(wire) || wire.length === 0) return undefined
  const tools: ModelTool[] = []
  for (const t of wire) {
    if (!isRecord(t) || typeof t.name !== "string") throw new Error("malformed tool definition")
    tools.push({ name: t.name, description: typeof t.description === "string" ? t.description : "", inputSchema: t.parameters })
  }
  return tools
}

function llmRequestToModel(request: LLMRequest): ModelRequest {
  const ret: ModelRequest = { model: request.model, messages: wireMessagesToModel(request.messages) }
  const tools = translateTools(request.tools)
  const opts = request.options as Record<string, unknown> | undefined
  return {
    ...ret,
    ...(tools ? { tools } : {}),
    ...(typeof request.system === "string" ? { system: request.system } : {}),
    ...(opts && typeof opts.maxTokens === "number" ? { maxTokens: opts.maxTokens } : {}),
    ...(opts && typeof opts.temperature === "number" ? { temperature: opts.temperature } : {}),
  }
}

/** Adapt a models stream event to the OpenCode wire vocabulary. */
export function modelStreamEventToWire(event: ModelStreamEvent): LLMEvent {
  switch (event.type) {
    case "step-start":
      return { type: "step-start" }
    case "text-delta":
      return { type: "text-delta", text: event.text }
    case "reasoning-delta":
      return { type: "reasoning-delta", text: event.text }
    case "tool-input-delta":
      return { type: "tool-input-delta", toolCallId: event.toolCallId, inputDelta: event.inputDelta }
    case "tool-call":
      return { type: "tool-call", toolCallId: event.toolCallId, toolName: event.name, input: event.input }
    case "usage":
      return { type: "usage", usage: event.usage }
    case "step-finish":
      return { type: "step-finish" }
    case "finish":
      return { type: "finish", reason: event.reason }
    case "error":
      // Sanitized: models error messages are classification strings, never
      // credential material. Preserve the retry class in the message.
      return { type: "provider-error", message: `[${event.error.retryClass}] ${event.error.message}` }
  }
}

/**
 * Wrap a credential-backed {@link ModelProviderAdapter} as the OpenCode wire
 * {@link ModelProvider}. Bounded by the adapter's own streaming; one provider
 * turn maps to one turn of the runner.
 */
export function modelsAdapterToProvider(adapter: ModelProviderAdapter): ModelProvider {
  return {
    id: `models:${adapter.descriptor.provider}`,
    async *stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
      const modelRequest = llmRequestToModel(request)
      for await (const event of adapter.stream(modelRequest, signal)) {
        yield modelStreamEventToWire(event)
      }
    },
  }
}

/**
 * Build a {@link SessionProviderResolver} against the BYOK {@link ModelRegistry}.
 *
 * Public identifiers (`connectionId`, `provider`) are read from
 * `spec.engineOptions` — never a secret. The registry resolves the tenant's
 * credential-backed adapter through `CredentialResolver` (the authorized
 * secret boundary); this function never sees serialized credential material.
 *
 * @param options.connectionKey    engineOptions key for the connection id
 * @param options.providerKey      engineOptions key for the provider id
 */
export function modelsProviderResolver(registry: ModelRegistry, options?: { readonly connectionKey?: string; readonly providerKey?: string }): SessionProviderResolver {
  const connectionKey = options?.connectionKey ?? "connectionId"
  const providerKey = options?.providerKey ?? "provider"
  return async (init: EngineInit): Promise<ModelProvider> => {
    const spec = init.spec
    const opts = (spec.engineOptions ?? {}) as Record<string, unknown>
    const connectionId = opts[connectionKey]
    const provider = opts[providerKey]
    if (typeof connectionId !== "string" || connectionId.length === 0) {
      throw new Error(`engineOptions.${connectionKey} (model connection) is required to run engine "opencode"`)
    }
    if (typeof provider !== "string" || provider.length === 0) {
      throw new Error(`engineOptions.${providerKey} (model provider) is required to run engine "opencode"`)
    }
    const resolved = await registry.resolve({
      tenantId: init.identity.tenantId,
      orgId: init.identity.orgId,
      projectId: init.identity.projectId,
      connectionId,
      provider,
      model: spec.model,
    })
    return modelsAdapterToProvider(resolved.adapter)
  }
}