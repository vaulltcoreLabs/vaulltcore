/**
 * OpenAI-compatible model adapter (Phase 2C).
 *
 * Streams one provider turn from any OpenAI-compatible Chat Completions
 * endpoint (OpenAI, OpenRouter, Azure OpenAI-compatible, vLLM, Ollama's
 * OpenAI shim, etc.) over the SSRF-guarded HTTP seam. No OpenAI SDK is a
 * dependency. The BYOK credential supplies the API key; the endpoint base is
 * part of the connection metadata, not hard-coded. Anthropic and Google have
 * their own adapter shapes (see anthropic.ts / google.ts) but the neutral
 * {@link ModelProviderAdapter} surface is identical.
 *
 * Error normalization: 401→auth_config, 429→rate_limited, 5xx/timeout→
 * transient, 4xx validation→permanent_validation. Usage events are emitted
 * for Phase 1E metering attribution. Secrets are transient, never logged.
 */

import { ProviderHttpClient, classifyResponse, IntegrationError, type ProviderHttpOptions, type ProviderHttpClient as ProviderHttpClientType } from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"
import type { ModelDescriptor, ModelProviderAdapter, ModelRequest, ModelStreamEvent, ModelMessage } from "./contracts"

export interface OpenAICompatibleOptions {
  readonly http?: ProviderHttpClientType
  /** Endpoint base, e.g. https://api.openai.com/v1 (from connection metadata). */
  readonly apiBase: string
  /** Optional header name/value overrides (e.g. Azure api-key header). */
  readonly headers?: Readonly<Record<string, string>>
}

/** Build the neutral adapter for an OpenAI-compatible endpoint. */
export function openAICompatibleAdapter(credential: ResolvedCredential, descriptor: ModelDescriptor, options: OpenAICompatibleOptions): ModelProviderAdapter {
  const http = options.http ?? new ProviderHttpClient({ allowHttp: true })
  const base = options.apiBase.replace(/\/$/, "")
  return {
    descriptor,
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
      yield { type: "step-start" }
      if (signal.aborted) { yield { type: "finish", reason: "stop" }; return }
      const body = toOpenAIRequest(request)
      let res
      try {
        res = await http.request({
          method: "POST",
          url: `${base}/chat/completions`,
          authHeader: `Bearer ${credential.secret}`,
          headers: { "content-type": "application/json", ...(options.headers ?? {}) },
          body,
        } as ProviderHttpOptions)
      } catch {
        yield { type: "error", error: new IntegrationError("MODEL_HTTP_ERROR", "model request failed", "transient", 502) }
        yield { type: "finish", reason: "stop" }
        return
      }
      if (res.status === 401) { yield { type: "error", error: new IntegrationError("MODEL_UNAUTHORIZED", "model unauthorized", "auth_config", 401) }; yield { type: "finish", reason: "stop" }; return }
      if (res.status === 429) { yield { type: "error", error: new IntegrationError("MODEL_RATE_LIMITED", "model rate limited", "rate_limited", 429) }; yield { type: "finish", reason: "stop" }; return }
      if (res.status < 200 || res.status >= 300) {
        yield { type: "error", error: classifyResponse(res.status, `model request failed: ${res.status}`) }
        yield { type: "finish", reason: "stop" }
        return
      }
      // Parse SSE stream (data: lines). Minimal, robust parser.
      const text = res.body
      let finishReason: "stop" | "tool_calls" | "max_tokens" = "stop"
      let usage: { inputTokens?: number; outputTokens?: number } | undefined
      for (const line of text.split("\n")) {
        if (signal.aborted) break
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const payload = trimmed.slice("data:".length).trim()
        if (payload === "[DONE]") break
        let chunk: any
        try { chunk = JSON.parse(payload) } catch { continue }
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens }
        const choice = chunk.choices?.[0]
        if (!choice) continue
        const delta = choice.delta
        if (delta?.content) yield { type: "text-delta", text: delta.content }
        if (delta?.reasoning_content) yield { type: "reasoning-delta", text: delta.reasoning_content }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc?.function?.arguments) yield { type: "tool-input-delta", toolCallId: tc.id ?? "", inputDelta: tc.function.arguments }
          }
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason === "tool_calls" ? "tool_calls" : choice.finish_reason === "max_tokens" ? "max_tokens" : "stop"
        }
      }
      if (usage) yield { type: "usage", usage }
      yield { type: "step-finish" }
      yield { type: "finish", reason: finishReason }
    },
  }
}

function toOpenAIRequest(request: ModelRequest): Record<string, unknown> {
  const messages: any[] = []
  if (request.system) messages.push({ role: "system", content: request.system })
  for (const m of request.messages) messages.push(toOpenAIMessage(m))
  const body: Record<string, unknown> = { model: request.model, messages, stream: true, stream_options: { include_usage: true } }
  if (request.maxTokens) body.max_tokens = request.maxTokens
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
  return body
}

function toOpenAIMessage(m: ModelMessage): any {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content }
  if (m.role === "assistant" && m.toolCalls?.length) {
    return { role: "assistant", content: m.content, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: typeof c.input === "string" ? c.input : JSON.stringify(c.input) } })) }
  }
  return { role: m.role, content: m.content }
}
