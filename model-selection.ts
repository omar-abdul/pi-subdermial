import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The provider and model id needed by a child pi process. */
export interface AgentModelSelection {
  provider: string;
  model: string;
  apiKey?: string;
}

type ModelRef = {
  provider: string;
  id: string;
  name?: string;
};

/**
 * Resolve a subagent model without depending on a hard-coded provider.
 *
 * Selection order:
 *  1. An explicitly requested model.
 *  2. The orchestrator's current model when it is configured.
 *  3. The first configured/available model (respecting scoped models first).
 *
 * A child process has its own model registry, so we return the provider as well
 * as the model id and let the child resolve stored credentials for that
 * provider. API keys are passed when available; OAuth/subscription and
 * environment-based credentials continue to work in the child.
 */
export async function resolveAgentModel(
  ctx: ExtensionContext,
  requestedModel?: string,
): Promise<AgentModelSelection> {
  const registry = ctx.modelRegistry;
  const available = registry.getAvailable();
  const availableKeys = new Set(available.map((model) => `${model.provider}\0${model.id}`));
  const scoped = (ctx.scopedModels ?? [])
    .map((entry) => entry.model)
    .filter((model) => availableKeys.has(`${model.provider}\0${model.id}`));
  const candidates = uniqueModels([...scoped, ...available]);
  const current = ctx.model;

  let selected: ModelRef | undefined;

  if (requestedModel?.trim()) {
    selected = findRequestedModel(registry, candidates, requestedModel.trim(), current);
    if (!selected) {
      // Let pi resolve aliases/custom model ids in the child process. A bare
      // reference is associated with the orchestrator provider when possible.
      selected = {
        provider: current?.provider || "",
        id: requestedModel.trim(),
      };
    }
  } else {
    // Prefer the active model when it is configured: it is known to work for
    // the current account. Otherwise select from the configured model pool,
    // then use the active model as a final fallback.
    selected = current && candidates.some(
      (model) => model.provider === current.provider && model.id === current.id,
    )
      ? current
      : candidates[0] || current;
  }

  if (!selected?.id) {
    throw new Error(
      "No configured model is available for subagents and the orchestrator model is unavailable. " +
      "Sign in to a provider or pass an explicit model.",
    );
  }
  if (!selected.provider) {
    throw new Error(
      `Unable to determine a provider for model "${selected.id}". Pass a provider/model reference.`,
    );
  }

  let apiKey: string | undefined;
  try {
    const resolved = registry.find(selected.provider, selected.id);
    if (resolved) {
      // OAuth/subscription providers need their provider-specific headers and
      // refresh flow. Let the child read the stored OAuth credential instead
      // of downgrading it to a plain --api-key request.
      if (!registry.isUsingOAuth(resolved)) {
        const auth = await registry.getApiKeyAndHeaders(resolved);
        if (auth.ok) apiKey = auth.apiKey;
      }
    }
  } catch {
    // The child can still use auth.json, environment variables, or OAuth.
  }

  return { provider: selected.provider, model: selected.id, apiKey };
}

function findRequestedModel(
  registry: ExtensionContext["modelRegistry"],
  candidates: readonly ModelRef[],
  requested: string,
  current: ModelRef | undefined,
): ModelRef | undefined {
  // Match a complete model id first. This is important for OpenRouter ids,
  // which commonly contain a slash themselves (for example foo/bar).
  const exactId = candidates.find((model) => model.id === requested);
  if (exactId) return exactId;

  const explicitSeparator = requested.indexOf("/");
  if (explicitSeparator > 0) {
    const provider = requested.slice(0, explicitSeparator);
    const id = requested.slice(explicitSeparator + 1);
    const exact = registry.find(provider, id);
    if (exact) return exact;
    return { provider, id };
  }

  const exactBare = candidates.find((model) => model.id === requested);
  if (exactBare) return exactBare;

  // Preserve the convenient short names accepted by Pi's model picker (for
  // example "haiku") when the registry has an unambiguous matching model.
  const needle = requested.toLowerCase();
  const named = candidates.filter((model) =>
    model.id.toLowerCase().includes(needle) || model.name?.toLowerCase().includes(needle),
  );
  if (named.length === 1) return named[0];

  if (current) return { provider: current.provider, id: requested };
  return undefined;
}

function uniqueModels<T extends ModelRef>(models: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const model of models) {
    const key = `${model.provider}\0${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}
