/**
 * ModelRegistry (Phase 2C).
 *
 * Resolves a (tenant, modelId) to a {@link ModelProviderAdapter} backed by a
 * resolved BYOK credential, enforcing tenant/project {@link ModelRestrictions}.
 * Provider adapters are registered by provider id; a credential of that
 * provider supplies the secret. Rotation changes the credential secret
 * without changing the registered adapter (the registry holds adapter
 * factories, not secrets).
 *
 * The registry is the ONLY boundary through which BYOK credentials reach a
 * model adapter. Usage attribution (input/output tokens) is emitted as
 * {@link ModelStreamEvent} usage events, compatible with Phase 1E metering.
 */

import type { ResolvedCredential } from "@vaulltcore/credentials"
import type { CredentialResolver } from "@vaulltcore/credentials"
import { ModelNotAllowedError, type ModelDescriptor, type ModelProviderAdapter, type ModelRequest, type ModelRestrictions, type ModelStreamEvent, type ResolvedModel } from "./contracts"

export type ModelAdapterFactory = (credential: ResolvedCredential, descriptor: ModelDescriptor) => ModelProviderAdapter

export interface ModelRegistryOptions {
  readonly credentialResolver: CredentialResolver
}

export class ModelRegistry {
  private readonly factories = new Map<string, { readonly descriptor: ModelDescriptor; readonly factory: ModelAdapterFactory }>()
  private readonly restrictions = new Map<string, ModelRestrictions>() // key: tenantId
  private readonly credentialResolver: CredentialResolver

  constructor(options: ModelRegistryOptions) {
    this.credentialResolver = options.credentialResolver
  }

  /** Register a model adapter factory under (provider, model). */
  register(provider: string, model: string, descriptor: ModelDescriptor, factory: ModelAdapterFactory): void {
    if (descriptor.provider !== provider || descriptor.model !== model) {
      throw new Error(`descriptor/provider/model mismatch: ${provider}/${model}`)
    }
    this.factories.set(`${provider}:${model}`, { descriptor, factory })
  }

  /** Set tenant model restrictions. */
  setRestrictions(tenantId: string, restrictions: ModelRestrictions): void {
    this.restrictions.set(tenantId, restrictions)
  }

  /** List registered descriptors (does NOT expose credentials). */
  listDescriptors(): readonly ModelDescriptor[] {
    return Array.from(this.factories.values()).map((e) => e.descriptor)
  }

  /** Resolve a model for a tenant + connectionId, enforcing restrictions. */
  async resolve(args: { readonly tenantId: string; readonly orgId: string; readonly projectId: string; readonly connectionId: string; readonly provider: string; readonly model: string }): Promise<ResolvedModel> {
    const r = this.restrictions.get(args.tenantId)
    if (r) {
      if (r.allowedProviders && !r.allowedProviders.includes(args.provider)) throw new ModelNotAllowedError(`provider ${args.provider} not allowed for tenant ${args.tenantId}`)
      if (r.allowedModels && !r.allowedModels.includes(args.model)) throw new ModelNotAllowedError(`model ${args.model} not allowed for tenant ${args.tenantId}`)
    }
    const entry = this.factories.get(`${args.provider}:${args.model}`)
    if (!entry) throw new ModelNotAllowedError(`no adapter registered for ${args.provider}:${args.model}`)
    const credential = await this.credentialResolver.resolve(args.tenantId, args.connectionId)
    if (!credential) throw new ModelNotAllowedError(`credential not resolvable for connection ${args.connectionId}`)
    const adapter = entry.factory(credential, entry.descriptor)
    return { adapter, descriptor: entry.descriptor, credential }
  }

  /** Enforce output-token restriction on a request (best-effort, pre-flight). */
  enforceRestrictions(tenantId: string, request: ModelRequest): void {
    const r = this.restrictions.get(tenantId)
    if (!r) return
    if (r.maxOutputTokens && request.maxTokens && request.maxTokens > r.maxOutputTokens) {
      throw new ModelNotAllowedError(`maxTokens ${request.maxTokens} exceeds tenant limit ${r.maxOutputTokens}`)
    }
  }
}

/** Re-export the contracts for callers. */
export type { ModelRequest, ModelStreamEvent, ModelRestrictions, ResolvedModel, ModelProviderAdapter, ModelDescriptor } from "./contracts"
