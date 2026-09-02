/**
 * Provider-neutral cost attribution (Phase 2F).
 *
 * A {@link CostCatalog} resolves a unit rate for a (provider, model, kind) at a
 * pricing version. Cost is DERIVED metadata — the usage quantity remains
 * authoritative independently of cost. Unknown pricing resolves to `null`
 * (honestly unknown, never a guess). A future price change ships a NEW pricing
 * version; it never rewrites a historical attribution persisted under an
 * earlier version.
 *
 * The {@link VersionedCostCatalog} wraps a billing {@link PricingVersion}
 * (per-kind micro rates) and optionally overlays provider/model-specific rates
 * from versioned configuration. It never scrapes provider websites at runtime;
 * rates come from immutable versioned configuration supplied by the operator.
 */

import type { PricingVersion } from "@vaulltcore/billing"
import type { UsageKind } from "@vaulltcore/metering"
import type { CostCatalog, CostRate } from "./contracts"

/** A provider/model/kind-specific override rate (micro per unit). */
export interface CostOverride {
  readonly provider: string
  readonly model: string
  readonly kind: UsageKind
  readonly rateMicro: number
}

/**
 * A cost catalog backed by an immutable {@link PricingVersion} with optional
 * provider/model-specific overrides. The pricing identity (pricingId + version)
 * is traceable on any persisted attribution. Resolving an unknown (provider,
 * model, kind) returns `null` — never a fabricated estimate.
 */
export class VersionedCostCatalog implements CostCatalog {
  private readonly pricing: PricingVersion
  private readonly overrides: ReadonlyMap<string, number>
  readonly pricingId: string
  readonly version: string

  constructor(pricing: PricingVersion, overrides: ReadonlyArray<CostOverride> = []) {
    this.pricing = pricing
    this.pricingId = pricing.pricingId
    this.version = pricing.version
    const map = new Map<string, number>()
    for (const o of overrides) {
      map.set(`${o.provider}|${o.model}|${o.kind}`, o.rateMicro)
    }
    this.overrides = map
  }

  resolveRate(provider: string | null, model: string | null, kind: UsageKind): CostRate | null {
    // Provider/model-specific override first (most specific).
    if (provider && model) {
      const ov = this.overrides.get(`${provider}|${model}|${kind}`)
      if (ov !== undefined) {
        return { pricingId: this.pricingId, version: this.version, rateMicro: ov, effectiveAt: this.pricing.effectiveAt }
      }
    }
    // Per-kind fallback from the versioned price table.
    const rate = this.pricing.unitPrices[kind]
    if (rate === undefined || rate === null) return null
    return { pricingId: this.pricingId, version: this.version, rateMicro: rate, effectiveAt: this.pricing.effectiveAt }
  }
}

/**
 * Attribute a cost to a usage quantity using a catalog. Returns derived cost
 * metadata; the quantity stays authoritative. When the catalog has no rate
 * (`null`), the attribution is honestly unpriced (`priced: false`,
 * `amountMicro: null`) — never a guess. Amount is integer micro-currency
 * (rate × quantity); no floating-point arithmetic for authoritative values.
 */
export function attributeCost(catalog: CostCatalog, input: {
  provider: string | null
  model: string | null
  kind: UsageKind
  quantity: number
}): { rate: CostRate | null; amountMicro: number | null; priced: boolean } {
  const rate = catalog.resolveRate(input.provider, input.model, input.kind)
  if (!rate) return { rate: null, amountMicro: null, priced: false }
  return { rate, amountMicro: rate.rateMicro * input.quantity, priced: true }
}
