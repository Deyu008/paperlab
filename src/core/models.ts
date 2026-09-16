/**
 * Role → Model resolution against the pi-ai built-in catalog.
 */
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRef, RoleKey } from "../config.ts";
import { modelRefForRole, type PaperlabConfig } from "../config.ts";

/**
 * Programmatic model injection (embedding/tests): models registered here are
 * resolved before the built-in catalog, enabling faux or custom providers.
 */
const extraModels = new Map<string, Model<any>>();

export function registerExtraModel(ref: ModelRef, model: Model<any>): void {
  extraModels.set(`${ref.provider}/${ref.model}`, model);
}

export function clearExtraModels(): void {
  extraModels.clear();
}

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

/** Resolve a ModelRef to a live Model, with a precise error when unknown. */
export function resolveModel(ref: ModelRef): Model<any> {
  const extra = extraModels.get(`${ref.provider}/${ref.model}`);
  if (extra) return extra;
  const providers = getBuiltinProviders() as string[];
  if (!providers.includes(ref.provider)) {
    throw new ModelResolutionError(
      `unknown provider "${ref.provider}". Available: ${providers.join(", ")}`,
    );
  }
  const known = getBuiltinModels(ref.provider as never) as unknown as Array<{ id: string }>;
  if (!known.some((m) => m.id === ref.model)) {
    const ids = known.map((m) => m.id).join(", ");
    throw new ModelResolutionError(
      `unknown model "${ref.model}" for provider "${ref.provider}". Available: ${ids}`,
    );
  }
  return getBuiltinModel(ref.provider as never, ref.model as never) as unknown as Model<any>;
}

/** Resolve the model configured for a role (falls back to `models.default`). */
export function resolveRoleModel(config: PaperlabConfig, role: RoleKey): Model<any> {
  return resolveModel(modelRefForRole(config, role));
}

/** Listing used by `paperlab models`. */
export function listCatalog(): Array<{ provider: string; models: string[] }> {
  return getBuiltinProviders().map((provider) => ({
    provider: provider as string,
    models: (getBuiltinModels(provider) as unknown as Array<{ id: string }>).map((m) => m.id),
  }));
}
