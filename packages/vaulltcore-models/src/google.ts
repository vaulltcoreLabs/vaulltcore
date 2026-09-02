/**
 * Google (Gemini) model adapter (Phase 2C).
 *
 * Streams one turn from the Google Generative Language API (Gemini) over the
 * SSRF-guarded HTTP seam. No Google SDK is a dependency. Same neutral
 * {@link ModelProviderAdapter} surface; Gemini-specific wire shapes
 * (streamGenerateContent, candidates/parts, functionCall) isolated here. The
 * API key is supplied via the BYOK credential (transient, never logged).
 */

import { ProviderHttpClient, classifyResponse, IntegrationError, type ProviderHttpOptions, type ProviderHttpClient as ProviderHttpClientType } from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"
import type { ModelDescriptor, ModelProviderAdapter, ModelRequest, ModelStreamEvent, ModelMessage } from "./contracts"

export interface GoogleOptions {
  readonly http?: ProviderHttpClientType
  readonly apiBase?: string
}

export function googleAdapter(credential: ResolvedCredential, descriptor: ModelDescriptor, options: GoogleOptions = {}): ModelProviderAdapter {
  const http = options.http ?? new ProviderHttpClient({ allowHttp: true })
  const base = (options.apiBase ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "")
  return {
    descriptor,
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      yield { type: "step-start" }
      if (signal.aborted) { yield { type: "finish", reason: "stop" }; return }
      const body = toGeminiRequest(request)
      let res
      try {
        res = await http.request({
          method: "POST",
          url: `${base}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(credential.secret)}`,
          headers: { "content-type": "application/json" },
          body,
        } as ProviderHttpOptions)
      } catch {
        yield { type: "error", error: new IntegrationError("MODEL_HTTP_ERROR", "google request failed", "transient", 502) }
        yield { type: "finish", reason: "stop" }
        return
      }
      if (res.status === 401 || res.status === 403) { yield { type: "error", error: new IntegrationError("MODEL_UNAUTHORIZED", "google unauthorized", "auth_config", 401) }; yield { type: "finish", reason: "stop" }; return }
      if (res.status === 429) { yield { type: "error", error: new IntegrationError("MODEL_RATE_LIMITED", "google rate limited", "rate_limited", 429) }; yield { type: "finish", reason: "stop" }; return }
      if (res.status < 200 || res.status >= 300) {
        yield { type: "error", error: classifyResponse(res.status, `google request failed: ${res.status}`) }
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
        const cand = chunk.candidates?.[0]
        const parts = cand?.content?.parts ?? []
        for (const p of parts) {
          if (p.text) yield { type: "text-delta", text: p.text }
          if (p.functionCall) yield { type: "tool-call", toolCallId: p.functionCall.name ?? "", name: p.functionCall.name ?? "", input: p.functionCall.args ?? {} }
        }
        if (chunk.usageMetadata) yield { type: "usage", usage: { inputTokens: chunk.usageMetadata.promptTokenCount, outputTokens: chunk.usageMetadata.candidatesTokenCount } }
        if (cand?.finishReason) yield { type: "finish", reason: cand.finishReason === "MAX_TOKENS" ? "max_tokens" : "stop" }
      }
      yield { type: "step-finish" }
    },
  }
}

function toGeminiRequest(request: ModelRequest): Record<string, unknown> {
  const contents: any[] = []
  for (const m of request.messages) {
    if (m.role === "system") continue
    const role = m.role === "assistant" ? "model" : "user"
    if (m.role === "tool") {
      const tid = m.toolCallId ?? ""
      contents.push({ role: "function", parts: [{ functionResponse: { name: tid, response: { content: m.content } } }] })
      continue
    }
    contents.push({ role, parts: [{ text: m.content }] })
  }
  const body: Record<string, unknown> = { contents }
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] }
  if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }]
  const genConfig: Record<string, unknown> = {}
  if (request.maxTokens) genConfig.maxOutputTokens = request.maxTokens
  if (request.temperature !== undefined) genConfig.temperature = request.temperature
  if (Object.keys(genConfig).length) body.generationConfig = genConfig
  return body
}
