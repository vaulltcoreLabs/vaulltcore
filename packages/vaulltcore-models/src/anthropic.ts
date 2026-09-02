/**
 * Anthropic model adapter (Phase 2C).
 *
 * Streams one turn from the Anthropic Messages API over the SSRF-guarded HTTP
 * seam. No Anthropic SDK is a dependency. Same neutral
 * {@link ModelProviderAdapter} surface as the OpenAI-compatible adapter;
 * Anthropic-specific wire shapes (system as top-level param, content blocks,
 * tool_use blocks, usage.input_tokens/output_tokens) are isolated here.
 */

import { ProviderHttpClient, classifyResponse, IntegrationError, type ProviderHttpOptions, type ProviderHttpClient as ProviderHttpClientType } from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"
import type { ModelDescriptor, ModelProviderAdapter, ModelRequest, ModelStreamEvent, ModelMessage } from "./contracts"

export interface AnthropicOptions {
  readonly http?: ProviderHttpClientType
  readonly apiBase?: string
  /** Anthropic API version header. */
  readonly anthropicVersion?: string
}

export function anthropicAdapter(credential: ResolvedCredential, descriptor: ModelDescriptor, options: AnthropicOptions = {}): ModelProviderAdapter {
  const http = options.http ?? new ProviderHttpClient({ allowHttp: true })
  const base = (options.apiBase ?? "https://api.anthropic.com/v1").replace(/\/$/, "")
  const version = options.anthropicVersion ?? "2023-06-01"
  return {
    descriptor,
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      yield { type: "step-start" }
      if (signal.aborted) { yield { type: "finish", reason: "stop" }; return }
      const body = toAnthropicRequest(request)
      let res
      try {
        res = await http.request({
          method: "POST", url: `${base}/messages`,
          authHeader: `Bearer ${credential.secret}`,
          headers: { "content-type": "application/json", "anthropic-version": version },
          body,
        } as ProviderHttpOptions)
      } catch {
        yield { type: "error", error: new IntegrationError("MODEL_HTTP_ERROR", "anthropic request failed", "transient", 502) }
        yield { type: "finish", reason: "stop" }
        return
      }
      if (res.status === 401) { yield { type: "error", error: new IntegrationError("MODEL_UNAUTHORIZED", "anthropic unauthorized", "auth_config", 401) }; yield { type: "finish", reason: "stop" }; return }
      if (res.status === 429) { yield { type: "error", error: new IntegrationError("MODEL_RATE_LIMITED", "anthropic rate limited", "rate_limited", 429) }; yield { type: "finish", reason: "stop" }; return }
      if (res.status < 200 || res.status >= 300) {
        yield { type: "error", error: classifyResponse(res.status, `anthropic request failed: ${res.status}`) }
        yield { type: "finish", reason: "stop" }
        return
      }
      for (const line of res.body.split("\n")) {
        if (signal.aborted) break
        const t = line.trim()
        if (!t.startsWith("data:")) continue
        const payload = t.slice("data:".length).trim()
        let chunk: any
        try { chunk = JSON.parse(payload) } catch { continue }
        if (chunk.type === "content_block_delta") {
          const d = chunk.delta
          if (d?.type === "text_delta" && d.text) yield { type: "text-delta", text: d.text }
          if (d?.type === "thinking_delta" && d.thinking) yield { type: "reasoning-delta", text: d.thinking }
          if (d?.type === "input_json_delta" && d.partial_json) yield { type: "tool-input-delta", toolCallId: chunk.index != null ? String(chunk.index) : "", inputDelta: d.partial_json }
        } else if (chunk.type === "message_start" && chunk.message?.usage) {
          yield { type: "usage", usage: { inputTokens: chunk.message.usage.input_tokens } }
        } else if (chunk.type === "message_delta" && chunk.usage) {
          yield { type: "usage", usage: { outputTokens: chunk.usage.output_tokens } }
        } else if (chunk.type === "message_stop") {
          yield { type: "finish", reason: "stop" }
        }
      }
      yield { type: "step-finish" }
    },
  }
}

function toAnthropicRequest(request: ModelRequest): Record<string, unknown> {
  const messages: any[] = []
  for (const m of request.messages) {
    if (m.role === "system") continue // system is top-level for Anthropic
    if (m.role === "tool") { messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] }); continue }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: any[] = []
      if (m.content) content.push({ type: "text", text: m.content })
      for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input })
      messages.push({ role: "assistant", content })
      continue
    }
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })
  }
  const body: Record<string, unknown> = { model: request.model, messages, max_tokens: request.maxTokens ?? 4096, stream: true }
  const system = request.system ?? messages.find((m) => m.role === "system")?.content
  if (system) body.system = system
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.tools?.length) body.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
  return body
}
