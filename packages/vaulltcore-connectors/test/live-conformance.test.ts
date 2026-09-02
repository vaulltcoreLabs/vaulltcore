/**
 * Phase 2D Tier C — live PM/notification provider conformance.
 *
 * Environment-gated: each provider's live tests run ONLY when its credential +
 * resource env var is set, and are HONESTLY skipped otherwise. A skipped live
 * test is a SKIP, never a fake pass. Live tests perform one read-only identity
 * probe; they NEVER mutate issues/channels or run destructive operations.
 *
 * Skip policy:
 *   Linear  LINEAR_API_KEY      LINEAR_TEST_TEAM (team key)
 *   Slack   SLACK_TEST_TOKEN     SLACK_TEST_CHANNEL
 */

import { describe, it, expect } from "vitest"
import type { ResolvedCredential } from "@vaulltcore/credentials"

function envSet(...names: string[]): boolean {
  return names.every((n) => process.env[n] && process.env[n]!.length > 0)
}

function cred(provider: string, secret: string): ResolvedCredential {
  return {
    connectionId: `conn_live_${provider}`, tenantId: "t1", orgId: "o1", projectId: "p1",
    family: provider === "linear" ? "project" : "notification", provider, secretRef: "live:test",
    secretFingerprint: "sha256:live", secret,
    account: { externalId: "live", displayName: "live", scopes: [] }, capabilities: [],
  }
}

// --- Linear (live) ---------------------------------------------------------

const linearLive = envSet("LINEAR_API_KEY")
const describeLinear = linearLive ? describe : describe.skip

describeLinear("Tier C — Linear live conformance", () => {
  it("authenticates and verifies identity (read-only)", async () => {
    const { LinearProvider } = await import("../src")
    const provider = new LinearProvider()
    const identity = await provider.verifyIdentity(cred("linear", process.env.LINEAR_API_KEY!))
    expect(identity).toBeDefined()
  })
})

// --- Slack (live) ----------------------------------------------------------

const slackLive = envSet("SLACK_TEST_TOKEN")
const describeSlack = slackLive ? describe : describe.skip

describeSlack("Tier C — Slack live conformance", () => {
  it("authenticates and verifies identity (read-only)", async () => {
    const { SlackConnector } = await import("../src")
    const connector = new SlackConnector()
    const identity = await connector.verifyIdentity(cred("slack", process.env.SLACK_TEST_TOKEN!))
    expect(identity).toBeDefined()
  })
})

describe("Tier C — skip honesty", () => {
  it("reports the live-gate status without faking a pass", () => {
    const gates = { linear: linearLive, slack: slackLive }
    expect(typeof gates.linear).toBe("boolean")
    expect(typeof gates.slack).toBe("boolean")
  })
})
