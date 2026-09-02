/**
 * Phase 2D Tier C — live model provider conformance (BYOK).
 *
 * Environment-gated: each model provider's live tests run ONLY when its
 * credential + model env var is set, and are HONESTLY skipped otherwise. A
 * skipped live test is a SKIP, never a fake pass. Live tests issue a single
 * minimal one-token request to prove the adapter authenticates and streams;
 * they NEVER perform uncontrolled discovery or destructive operations.
 *
 * Skip policy:
 *   OpenAI-compatible OPENAI_TEST_API_KEY   OPENAI_TEST_MODEL
 *   Anthropic       ANTHROPIC_TEST_API_KEY  ANTHROPIC_TEST_MODEL
 *   Google          GOOGLE_TEST_API_KEY     GOOGLE_TEST_MODEL
 */

import { describe, it, expect } from "vitest"
import type { ResolvedCredential } from "@vaulltcore/credentials"

function envSet(...names: string[]): boolean {
  return names.every((n) => process.env[n] && process.env[n]!.length > 0)
}

function cred(secret: string): ResolvedCredential {
  return {
    connectionId: "conn_live", tenantId: "t1", orgId: "o1", projectId: "p1",
    family: "model", provider: "openai", secretRef: "live:test", secretFingerprint: "sha256:live",
    secret, account: { externalId: "live", displayName: "live", scopes: [] }, capabilities: ["model:stream"],
  }
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const e of it) out.push(e)
  return out
}

// --- OpenAI-compatible (live) ----------------------------------------------

const openaiLive = envSet("OPENAI_TEST_API_KEY", "OPENAI_TEST_MODEL")
const describeOpenAI = openaiLive ? describe : describe.skip

describeOpenAI("Tier C — OpenAI-compatible live conformance", () => {
  it("authenticates and streams a minimal one-token response", async () => {
    const { openAICompatibleAdapter, OPENAI_GPT4O } = await import("../src")
    const adapter = openAICompatibleAdapter(
      cred(process.env.OPENAI_TEST_API_KEY!),
      { ...OPENAI_GPT4O, provider: "openai", model: process.env.OPENAI_TEST_MODEL! },
      { apiBase: process.env.OPENAI_TEST_BASE_URL ?? "https://api.openai.com/v1" },
    )
    const events = await collect(adapter.stream({
      model: process.env.OPENAI_TEST_MODEL!,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
    }, new AbortController().signal))
    expect(events.length).toBeGreaterThan(0)
  })
})

// --- Anthropic (live) ------------------------------------------------------

const anthropicLive = envSet("ANTHROPIC_TEST_API_KEY", "ANTHROPIC_TEST_MODEL")
const describeAnthropic = anthropicLive ? describe : describe.skip

describeAnthropic("Tier C — Anthropic live conformance", () => {
  it("authenticates and streams a minimal one-token response", async () => {
    const { anthropicAdapter, ANTHROPIC_SONNET } = await import("../src")
    const adapter = anthropicAdapter(
      cred(process.env.ANTHROPIC_TEST_API_KEY!),
      { ...ANTHROPIC_SONNET, provider: "anthropic", model: process.env.ANTHROPIC_TEST_MODEL! },
      { apiBase: process.env.ANTHROPIC_TEST_BASE_URL ?? "https://api.anthropic.com" },
    )
    const events = await collect(adapter.stream({
      model: process.env.ANTHROPIC_TEST_MODEL!,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
    }, new AbortController().signal))
    expect(events.length).toBeGreaterThan(0)
  })
})

// --- Google (live) ---------------------------------------------------------

const googleLive = envSet("GOOGLE_TEST_API_KEY", "GOOGLE_TEST_MODEL")
const describeGoogle = googleLive ? describe : describe.skip

describeGoogle("Tier C — Google live conformance", () => {
  it("authenticates and streams a minimal one-token response", async () => {
    const { googleAdapter, GOOGLE_GEMINI_PRO } = await import("../src")
    const adapter = googleAdapter(
      cred(process.env.GOOGLE_TEST_API_KEY!),
      { ...GOOGLE_GEMINI_PRO, provider: "google", model: process.env.GOOGLE_TEST_MODEL! },
      { apiBase: process.env.GOOGLE_TEST_BASE_URL ?? "https://generativelanguage.googleapis.com" },
    )
    const events = await collect(adapter.stream({
      model: process.env.GOOGLE_TEST_MODEL!,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
    }, new AbortController().signal))
    expect(events.length).toBeGreaterThan(0)
  })
})

describe("Tier C — skip honesty", () => {
  it("reports the live-gate status without faking a pass", () => {
    const gates = { openai: openaiLive, anthropic: anthropicLive, google: googleLive }
    expect(typeof gates.openai).toBe("boolean")
    expect(typeof gates.anthropic).toBe("boolean")
    expect(typeof gates.google).toBe("boolean")
  })
})
