/**
 * Pure boot-context builder for `@guuey/host`.
 *
 * Extracted from `index.ts` so the credential-resolution logic is unit-testable
 * without importing the worker entrypoint (which calls `main()` as a top-level
 * side effect). `buildHostContext` is pure — no disk access, no I/O.
 *
 * Credential sources (guuey#2139):
 *  - Platform launch: the model capability arrives in the private launch
 *    envelope (`@guuey/worker`'s `readLaunchEnvelope`), never in the
 *    environment. When an envelope is present, no key-slot variable is read.
 *  - No envelope (local `guuey dev`, or a launcher that predates the
 *    envelope): the key-slot variables are read as before.
 * Base URLs are public and always come from the environment.
 *
 * OSS-legal: no guuey-private imports.
 */
import type { LaunchEnvelope } from "@guuey/worker";

/**
 * Parts of the worker boot context: the model credential and the provider base
 * URLs. Resolved once at worker startup; per-invoke context lives on the turn.
 */
export interface HostBootContext {
  /** OpenAI key, or the opaque scoped token in hosted mode. Applied with `setDefaultOpenAIKey`. */
  openaiKey?: string;
  /** Anthropic API key: the local-dev path, with no base URL. */
  anthropicApiKey?: string;
  /** The model-egress base URL in hosted mode (`ANTHROPIC_BASE_URL`). */
  anthropicBaseUrl?: string;
  /** The opaque scoped token for {@link anthropicBaseUrl}. */
  anthropicAuthToken?: string;
  /** The Gemini key, or the opaque scoped token in hosted mode. */
  geminiKey?: string;
}

/**
 * The graceful-legacy lane marker (guuey#2139). The
 * platform launcher sets it, with the value {@link BUILDER_KEY_LANE_LEGACY_ENV},
 * only for a graceful module on an image the platform stamped at deploy time
 * for the temporary legacy env lane; the token itself still arrives in the
 * launch envelope. The google-adk runner then lets a model client the
 * builder's own module constructs read the key from this process's
 * environment (see `frameworks/google-adk.ts`). Never decided by the host.
 */
export const BUILDER_KEY_LANE_ENV = "GUUEY_BUILDER_KEY_LANE";
/** The one marker value that selects the graceful-legacy lane. */
export const BUILDER_KEY_LANE_LEGACY_ENV = "legacy-env";
/** The variable a builder-constructed ADK model reads its key from on that lane (the Gemini key slot). */
export const LEGACY_GEMINI_KEY_ENV = "GEMINI_API_KEY";

/** What the boot hands every runner: the envelope it read, if any. */
export interface HostBoot {
  envelope?: LaunchEnvelope;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Build the host boot context. With an envelope, the credential is the
 * envelope's model token for its wire and the environment supplies only base
 * URLs; without one, the legacy key-slot variables apply. Pure.
 */
export function buildHostContext(env: NodeJS.ProcessEnv, envelope?: LaunchEnvelope): HostBootContext {
  const anthropicBaseUrl = nonEmpty(env.ANTHROPIC_BASE_URL);
  if (envelope !== undefined) {
    const model = envelope.model;
    if (model === undefined) return anthropicBaseUrl !== undefined ? { anthropicBaseUrl } : {};
    switch (model.wire) {
      case "anthropic":
        return { ...(anthropicBaseUrl !== undefined ? { anthropicBaseUrl } : {}), anthropicAuthToken: model.token };
      case "openai":
        return { openaiKey: model.token };
      case "gemini":
        return { geminiKey: model.token };
    }
  }
  const openaiKey = nonEmpty(env.OPENAI_API_KEY);
  const anthropicApiKey = nonEmpty(env.ANTHROPIC_API_KEY);
  const anthropicAuthToken = nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
  const geminiKey = nonEmpty(env.GEMINI_API_KEY);
  return {
    ...(openaiKey !== undefined ? { openaiKey } : {}),
    ...(anthropicApiKey !== undefined ? { anthropicApiKey } : {}),
    ...(anthropicBaseUrl !== undefined ? { anthropicBaseUrl } : {}),
    ...(anthropicAuthToken !== undefined ? { anthropicAuthToken } : {}),
    ...(geminiKey !== undefined ? { geminiKey } : {}),
  };
}

