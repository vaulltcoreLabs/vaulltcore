/**
 * Job attribution provider (Phase 2F).
 *
 * Resolves public provider/model identifiers for a job from the job spec
 * (engine/model), NEVER from credentials. The runner's {@link JobSpec} carries
 * a `model` identifier and an `engine`; the BYOK model plane maps a model
 * identifier to a {@link ModelDescriptor.provider}. This provider is the
 * attribution boundary: it returns public identifiers or `null` (honestly
 * unavailable) — it never guesses a provider/model, and it never reads
 * credentials or secret material.
 *
 * Usage: wire this into the metering pipeline (eventsToUsageAttributed) and
 * the reconciliation service (AttributionProvider) so usage events carry
 * provider/model attribution without storing secrets.
 */

import type { UsageAttribution } from "@vaulltcore/metering"

/**
 * Resolves public provider/model attribution for a job. Structurally
 * compatible with {@link @vaulltcore/reconcile.AttributionProvider} — the
 * reconcile service accepts this function shape without a package dependency.
 * Returns `null` when attribution is unavailable (honest, never fabricated).
 */
export type JobAttributionProvider = (job: { jobId: string; tenantId: string; orgId: string; projectId: string }) => UsageAttribution | null

/**
 * A model→provider resolver. Implementations consult the BYOK model registry
 * (ModelRegistry → ModelDescriptor.provider) or a static map. Returns the
 * public provider string for a model identifier, or `null` when unknown
 * (attribution unavailable — never fabricated).
 */
export interface ModelProviderResolver {
  resolveProvider(model: string): string | null
}

/** A job→model lookup. The model identifier lives in the job spec, which the
 *  runner contract exposes only at creation/admission time; the caller wires a
 *  lookup backed by the job store or the admission record. Returns the public
 *  model string or `null` when the job/model is unknown (never guessed). */
export interface JobModelLookup {
  resolveModel(jobId: string): string | null
}

/** Build an attribution provider from a job→model lookup + a model→provider
 *  resolver. Reads NO credentials — only public identifiers. Returns `null`
 *  when the job or model is unknown or the provider cannot be resolved (honest
 *  unavailable, never fabricated). */
export function jobAttributionProvider(lookup: JobModelLookup, resolver: ModelProviderResolver): JobAttributionProvider {
  return (job) => {
    const model = lookup.resolveModel(job.jobId)
    if (!model) return null
    const provider = resolver.resolveProvider(model)
    if (!provider) return null
    return { provider, model }
  }
}

/** A constant attribution (e.g. for a deterministic engine where every job uses
 *  the same known model). Returns the same attribution for every job. */
export function staticAttribution(provider: string, model: string): JobAttributionProvider {
  return () => ({ provider, model })
}

/** A static model→provider map (useful for tests and deterministic engines
 *  like the ScriptEngine whose model is "script-model"). */
export class StaticModelProviderResolver implements ModelProviderResolver {
  private readonly map: ReadonlyMap<string, string>
  constructor(entries: ReadonlyArray<{ model: string; provider: string }> = []) {
    const m = new Map<string, string>()
    for (const e of entries) m.set(e.model, e.provider)
    this.map = m
  }
  resolveProvider(model: string): string | null {
    return this.map.get(model) ?? null
  }
}
