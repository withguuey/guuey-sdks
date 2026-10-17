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

