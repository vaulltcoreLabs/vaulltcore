import { describe, it, expect } from "vitest"
import {
  ModelRegistry,
  openAICompatibleAdapter,
  anthropicAdapter,
  googleAdapter,
  OPENAI_GPT4O,
  ANTHROPIC_SONNET,
  GOOGLE_GEMINI_PRO,
  customOpenAICompatibleDescriptor,
  ModelNotAllowedError,
  type ModelStreamEvent,
} from "../src"
import type { ProviderHttpClient as ProviderHttpClientType, ProviderHttpResponse, ProviderHttpOptions } from "@vaulltcore/integration"
import type { ResolvedCredential } from "@vaulltcore/credentials"

class FakeHttp {
  readonly calls: Array<{ url: string; authHeader?: string; body?: unknown }> = []
  private responder: (o: ProviderHttpOptions) => ProviderHttpResponse = () => ({ status: 200, headers: {}, body: "" })
  respond(r: (o: ProviderHttpOptions) => ProviderHttpResponse): this { this.responder = r; return this }
  async request(options: ProviderHttpOptions): Promise<ProviderHttpResponse> {
    this.calls.push({ url: options.url, authHeader: options.authHeader, body: options.body })
    return this.responder(options)
  }
}

function modelCred(secret = "sk-fake-model-api-key-secret"): ResolvedCredential {
  return {
    connectionId: "conn_m", tenantId: "t1", orgId: "o1", projectId: "p1",
    family: "model", provider: "openai", secretRef: "mem:m", secretFingerprint: "sha256:m", secret,
    account: { externalId: "org-1", displayName: "acme", scopes: [] },
    capabilities: ["model:stream"],
  }
}

async function collect(it: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe("OpenAI-compatible adapter", () => {
  it("streams text + usage from SSE and sends Bearer key", async () => {
    const http = new FakeHttp().respond(() => ({
      status: 200, headers: { "content-type": "text/event-stream" },
      body: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: " world" }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}`,
        "data: [DONE]",
      ].join("\n"),
    }))
    const adapter = openAICompatibleAdapter(modelCred("sk-test-key-secret-value"), OPENAI_GPT4O, { apiBase: "https://api.openai.com/v1", http: http as unknown as ProviderHttpClientType })
    const events = await collect(adapter.stream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }, new AbortController().signal))
    expect(events.map((e) => e.type)).toEqual(["step-start", "text-delta", "text-delta", "usage", "step-finish", "finish"])
    expect(http.calls[0]!.authHeader).toBe("Bearer sk-test-key-secret-value")
    const body = http.calls[0]!.body as { stream: boolean; stream_options: { include_usage: boolean } }
    expect(body.stream).toBe(true)
    expect(body.stream_options.include_usage).toBe(true)
  })

  it("normalizes 401 to auth_config error event", async () => {
    const http = new FakeHttp().respond(() => ({ status: 401, headers: {}, body: '{"error":"bad key"}' }))
    const adapter = openAICompatibleAdapter(modelCred(), OPENAI_GPT4O, { apiBase: "https://api.openai.com/v1", http: http as unknown as ProviderHttpClientType })
    const events = await collect(adapter.stream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal))
    const err = events.find((e) => e.type === "error")
    expect(err?.type === "error" && err.error.retryClass).toBe("auth_config")
  })

  it("normalizes 429 to rate_limited", async () => {
    const http = new FakeHttp().respond(() => ({ status: 429, headers: {}, body: "" }))
    const adapter = openAICompatibleAdapter(modelCred(), OPENAI_GPT4O, { apiBase: "https://x/v1", http: http as unknown as ProviderHttpClientType })
    const events = await collect(adapter.stream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal))
    const err = events.find((e) => e.type === "error")
    expect(err?.type === "error" && err.error.retryClass).toBe("rate_limited")
  })

  it("emits tool_calls finish reason on tool-call deltas", async () => {
    const toolArgs = JSON.stringify({ x: 1 })
    const chunk1 = { choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "do", arguments: toolArgs } }] }, finish_reason: null }] }
    const chunk2 = { choices: [{ finish_reason: "tool_calls" }] }
    const sse = [
      "data: " + JSON.stringify(chunk1),
      "data: " + JSON.stringify(chunk2),
      "data: [DONE]",
    ].join("\n")
    const http = new FakeHttp().respond(() => ({ status: 200, headers: {}, body: sse }))
    const adapter = openAICompatibleAdapter(modelCred(), OPENAI_GPT4O, { apiBase: "https://x/v1", http: http as unknown as ProviderHttpClientType })
    const events = await collect(adapter.stream({ model: "gpt-4o", messages: [{ role: "user", content: "run" }], tools: [{ name: "do", description: "d", inputSchema: {} }] }, new AbortController().signal))
    const finish = events.find((e) => e.type === "finish")
    expect(finish?.type === "finish" && finish.reason).toBe("tool_calls")
  })
})

describe("Anthropic + Google adapter shapes", () => {
  it("anthropic streams text_delta + usage from message_start/message_delta", async () => {
    const http = new FakeHttp().respond(() => ({
      status: 200, headers: {}, body: [
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 12 } } })}`,
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } })}`,
        `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } })}`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
      ].join("\n"),
    }))
    const adapter = anthropicAdapter(modelCred("sk-ant-fake-key-secret"), ANTHROPIC_SONNET, { apiBase: "https://api.anthropic.com/v1", http: http as unknown as ProviderHttpClientType })
    const events = await collect(adapter.stream({ model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "hi" }], system: "be helpful" }, new AbortController().signal))
    const usage = events.filter((e) => e.type === "usage")
    expect(usage).toHaveLength(2)
    expect((http.calls[0]!.body as { system: string }).system).toBe("be helpful")
  })

  it("google streams parts + usageMetadata", async () => {
    const http = new FakeHttp().respond(() => ({
      status: 200, headers: {}, body: [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } })}`,
        `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}`,
      ].join("\n"),
    }))
    const adapter = googleAdapter(modelCred("AIza-fake-google-key-secret"), GOOGLE_GEMINI_PRO, { apiBase: "https://gen/v1beta", http: http as unknown as ProviderHttpClientType })
    const events = await collect(adapter.stream({ model: "gemini-1.5-pro", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal))
    expect(events.some((e) => e.type === "text-delta")).toBe(true)
    expect(http.calls[0]!.url).toContain("key=AIza-fake-google-key-secret")
  })
})

describe("ModelRegistry — tenant restrictions + credential resolution", () => {
  it("rejects disallowed providers/models (tenant isolation)", async () => {
    const resolver = { async resolve() { return modelCred() } } as never
    const reg = new ModelRegistry({ credentialResolver: resolver })
    reg.register("openai", "gpt-4o", OPENAI_GPT4O, (c) => openAICompatibleAdapter(c, OPENAI_GPT4O, { apiBase: "https://x/v1" }))
    reg.setRestrictions("t1", { allowedProviders: ["anthropic"] })
    await expect(reg.resolve({ tenantId: "t1", orgId: "o1", projectId: "p1", connectionId: "c", provider: "openai", model: "gpt-4o" })).rejects.toBeInstanceOf(ModelNotAllowedError)
  })

  it("enforces maxOutputTokens pre-flight", () => {
    const resolver = { async resolve() { return modelCred() } } as never
    const reg = new ModelRegistry({ credentialResolver: resolver })
    reg.setRestrictions("t1", { maxOutputTokens: 1000 })
    expect(() => reg.enforceRestrictions("t1", { model: "x", messages: [], maxTokens: 5000 })).toThrow(ModelNotAllowedError)
  })

  it("listDescriptors does NOT expose credentials", () => {
    const resolver = { async resolve() { return modelCred() } } as never
    const reg = new ModelRegistry({ credentialResolver: resolver })
    reg.register("openai", "gpt-4o", OPENAI_GPT4O, (c) => openAICompatibleAdapter(c, OPENAI_GPT4O, { apiBase: "https://x/v1" }))
    const list = reg.listDescriptors()
    expect(list[0]!.model).toBe("gpt-4o")
    expect(JSON.stringify(list)).not.toContain("sk-fake")
  })

  it("custom OpenAI-compatible descriptor for self-hosted gateway", () => {
    const d = customOpenAICompatibleDescriptor("acme-gw", "acme-llama", "Acme Llama", { contextWindow: 32000 })
    expect(d.provider).toBe("acme-gw")
    expect(d.contextWindow).toBe(32000)
    expect(d.pricing).toBeNull()
  })
})
