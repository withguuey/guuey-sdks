/**
 * Key binding for graceful google-adk agents (guuey#2139).
 *
 * A graceful agent module names its model as a string (`model: guuey.model`,
 * the scaffold's default), so the ADK constructs the client itself, through
 * its public model registry, and keys it from the environment
 * (`GOOGLE_GENAI_API_KEY || GOOGLE_API_KEY || GEMINI_API_KEY`). The platform no
 * longer puts the scoped token in any environment, so before the agent is
 * materialized the host registers a `Gemini` subclass that carries the token,
 * on the SAME ADK module instance the agent uses (`loadAdk(entryPath)`).
 *
 * Registering with the base class's own `supportedModels` (the same RegExp
 * objects) replaces `Gemini`'s registry entries in place, so every string model
 * anywhere in the tree resolves to the keyed client: the root, sub-agents, an
 * agent that inherits its parent's model and an agent wrapped in an
 * `AgentTool` (whose `agent` member is private, so no tree walk could reach
 * it). Afterwards `resolve(model)` must return the keyed class; anything else
 * (a stale resolve cache entry, an unknown model name) refuses the turn by
 * name before any model call. The token never reaches `process.env`.
 *
 * A model instance the builder constructed itself keeps its own key; the boot
 * counts those (`adkBuilderLlm`), never their values.
 */

/** An opaque ADK model handle. */
export type AdkModelHandle = object;

/** The ADK's `Gemini` class, structurally: constructible with a key, carrying its model patterns. */
export type AdkGeminiClass = (new (params: { model: string; apiKey: string }) => AdkModelHandle) & {
  readonly supportedModels: Array<string | RegExp>;
};

/** A registrable model class: constructible from a model name alone. */
export type AdkRegistrableClass = (new (params: { model: string }) => AdkModelHandle) & {
  readonly supportedModels: Array<string | RegExp>;
};

/** The ADK's public model registry (`LLMRegistry`), structurally. */
export interface AdkModelRegistry {
  register(cls: AdkRegistrableClass): void;
  resolve(model: string): object;
}

/** The slice of the ADK module the binding needs. */
export interface AdkKeyBindingModule {
  Gemini: AdkGeminiClass;
  LLMRegistry: AdkModelRegistry;
}

/** The binding was refused: the turn errors with this and makes no model call. */
export class AdkModelKeyError extends Error {
  constructor(model: string, reason: string) {
    super(`google-adk model "${model}" cannot be bound to the platform key: ${reason}`);
    this.name = "AdkModelKeyError";
  }
}

/**
 * One keyed class per registry, registered once. Its constructor reads the
 * current token from the binding, so a later bind (a new token in the same
 * process) updates the key without registering a second class: the registry's
 * resolve cache keeps answering with the one keyed class.
 */
const bound = new WeakMap<AdkModelRegistry, { key: { token: string }; cls: AdkRegistrableClass }>();

/**
 * Register the key-bound `Gemini` subclass on `adk`'s registry (once per
 * registry), point it at `token`, and assert that `model` resolves to it.
 */
export function bindAdkModelKey(adk: AdkKeyBindingModule, token: string, model: string): AdkRegistrableClass {
  let binding = bound.get(adk.LLMRegistry);
  if (binding === undefined) {
    const Base = adk.Gemini;
    const key = { token };
    class GuueyGemini extends Base {
      static readonly supportedModels = Base.supportedModels;
      constructor(params: { model: string }) {
        super({ model: params.model, apiKey: key.token });
      }
    }
    adk.LLMRegistry.register(GuueyGemini);
    binding = { key, cls: GuueyGemini };
    bound.set(adk.LLMRegistry, binding);
  }
  binding.key.token = token;
  let resolved: object;
  try {
    resolved = adk.LLMRegistry.resolve(model);
  } catch (err) {
    throw new AdkModelKeyError(model, err instanceof Error ? err.message : String(err));
  }
  if (resolved !== binding.cls) {
    throw new AdkModelKeyError(model, "the registry resolves it to another class (a stale resolve cache entry or a builder registration)");
  }
  return binding.cls;
}

/**
 * Count the agents in a materialized tree (the root and its `subAgents`,
 * recursively) whose `model` is a model instance the builder constructed.
 * Counted, never read: a builder-constructed client keeps its own key.
 */
export function countBuilderModels(agent: object, isModel: (value: unknown) => boolean, seen: Set<object> = new Set()): number {
  if (seen.has(agent)) return 0;
  seen.add(agent);
  let count = "model" in agent && isModel(agent.model) ? 1 : 0;
  if ("subAgents" in agent && Array.isArray(agent.subAgents)) {
    for (const child of agent.subAgents) {
      if (typeof child === "object" && child !== null) count += countBuilderModels(child, isModel, seen);
    }
  }
  return count;
}
