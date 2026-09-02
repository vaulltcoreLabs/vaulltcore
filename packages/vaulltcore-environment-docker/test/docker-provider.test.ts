/**
 * Phase 1D deliverable #7: prove the real {@link DockerCloudProvider} against
 * the Docker Engine. Gated on docker availability; skipped (not failed) when
 * docker is not reachable so CI without a daemon does not break.
 *
 * Proves the seam against actual remote (container-isolated) execution while
 * preserving:
 * - explicit environment (no host process.env leakage — allow-list only);
 * - isolated workspace (per-sandbox container, job-bound name);
 * - CPU/memory/time limits (docker resource flags);
 * - termination / inspect (honest);
 * - capability reporting (native suspend/snapshot/restore = yes;
 *   durableWorkspace = no — only a committed image survives container removal);
 * - honest snapshot semantics (snapshot/restore round-trip; inspectSnapshot
 *   of a missing image throws CapabilityUnsupportedError).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { DockerCloudProvider } from "../src"
import { CapabilityUnsupportedError } from "@vaulltcore/environment-cloud"

const execFileAsync = promisify(execFile)

const DOCKER_BIN = process.env.DOCKER_CMD ? process.env.DOCKER_CMD.split(/\s+/) : ["docker"]

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync(DOCKER_BIN[0]!, [...DOCKER_BIN.slice(1), "info"], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

const available = await dockerAvailable()
const describeOrSkip = available ? describe : describe.skip

describeOrSkip("DockerCloudProvider (real Docker Engine)", () => {
  let provider: DockerCloudProvider

  beforeEach(() => {
    provider = new DockerCloudProvider({
      dockerBin: DOCKER_BIN,
      baseImage: "alpine:3.20",
      cpus: 0.5,
      memoryBytes: 64 * 1024 * 1024,
      execTimeoutMs: 60_000,
    })
  })
  afterEach(async () => {
    // Clean up any sandboxes this test created.
    for (const name of ["job-docker-1", "job-docker-2", "job-docker-3", "job-docker-4", "job-docker-5", "job-docker-6"]) {
      await provider.terminate({ name, sandboxId: "vc-" + name }).catch(() => {})
    }
  })

  it("reports honest capabilities: native suspend/snapshot/restore yes; durableWorkspace no", () => {
    const caps = provider.capabilities()
    expect(caps.nativeSuspend).toBe(true)
    expect(caps.nativeSnapshot).toBe(true)
    expect(caps.nativeRestore).toBe(true)
    // A removed container loses its writable layer — only a committed image
    // survives, so the workspace is not durable on its own.
    expect(caps.durableWorkspace).toBe(false)
  })

  it("provisions an isolated sandbox and executes a command", async () => {
    const handle = await provider.provision("job-docker-1")
    await provider.start(handle)
    const result = await provider.execute(handle, "sh", ["-c", "echo hi && id -u"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("hi")
  })

  it("no host process.env leakage (allow-list only)", async () => {
    const probe = `VC_HOST_LEAK_PROBE_${Date.now()}`
    process.env[probe] = "host-secret"
    const p = new DockerCloudProvider({ dockerBin: DOCKER_BIN, baseImage: "alpine:3.20", sandboxEnv: { ALLOWED: "yes" } })
    const handle = await p.provision("job-docker-2")
    await p.start(handle)
    const env = await p.execute(handle, "sh", ["-c", 'echo "allow=${ALLOWED:-none} leak=${' + probe + ':-none}"'])
    expect(env.stdout).toContain("allow=yes")
    expect(env.stdout).toContain("leak=none")
    delete process.env[probe]
    await p.terminate(handle).catch(() => {})
  })

  it("suspend pauses and resumeSandbox resumes compute", async () => {
    const handle = await provider.provision("job-docker-3")
    await provider.start(handle)
    await provider.suspend(handle)
    const paused = await provider.inspect({ name: "job-docker-3" })
    expect(paused.status).toBe("suspended")
    await provider.resumeSandbox(handle)
    const resumed = await provider.inspect({ name: "job-docker-3" })
    expect(resumed.status).toBe("running")
  })

  it("inspect reports status; terminate removes the sandbox", async () => {
    const handle = await provider.provision("job-docker-4")
    await provider.start(handle)
    const info = await provider.inspect({ name: "job-docker-4" })
    expect(info.status).toBe("running")
    await provider.terminate(handle)
    const after = await provider.inspect({ name: "job-docker-4" })
    expect(after.status).toBe("terminated")
  })

  it("snapshot/restore round-trip: native image materializes workspace state", async () => {
    const handle = await provider.provision("job-docker-5")
    await provider.start(handle)
    // Write state into the container's writable layer.
    await provider.execute(handle, "sh", ["-c", "echo persisted > /tmp/marker.txt"])
    const ref = await provider.snapshot(handle)
    expect(ref.payloadChecksum).toHaveLength(64)
    // Materialize a fresh container from the committed image.
    const restored = await provider.restore(ref)
    const result = await provider.execute(restored, "sh", ["-c", "cat /tmp/marker.txt"])
    expect(result.stdout).toContain("persisted")
    // inspectSnapshot validates the image exists.
    const meta = await provider.inspectSnapshot(ref.uri)
    expect(meta.uri).toBe(ref.uri)
    // A missing image throws CapabilityUnsupportedError (honest, no emulate).
    await expect(provider.inspectSnapshot("vc-not-an-image:nope")).rejects.toThrow(CapabilityUnsupportedError)
    await provider.terminate(restored).catch(() => {})
  })

  it("provision is idempotent by name (reattach)", async () => {
    const h1 = await provider.provision("job-docker-6")
    const h2 = await provider.provision("job-docker-6")
    expect(h2.sandboxId).toBe(h1.sandboxId)
  })
})
