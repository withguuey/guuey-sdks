/**
 * Pure boot-context builder for `@guuey/host`.
 *
 * Extracted from `index.ts` so the env-reading logic is unit-testable without
 * importing the worker entrypoint (which calls `main()` as a top-level side
 * effect). `buildHostContext` is pure — no disk access, no I/O.
 *
 * OSS-legal: no guuey-private imports — only Node built-ins.
 */

/**
 * Parts of the worker boot context derived from the process environment.
 * Resolved once at worker startup by the entrypoint (`index.ts`); per-invoke
 * context lives on `HostInvoke` + `HostRuntime` in `run.ts`.
 */
export interface HostBootContext {
  /**
   * OpenAI API key — or the opaque broker token in hosted mode (the Task 8
   * `buildWorkerEnv` injects it as `OPENAI_API_KEY`). Applied globally to the
   * SDK via `setDefaultOpenAIKey` before the first invoke. `undefined` means
   * no OpenAI credentials are available.
   */
  openaiKey?: string;
  /**
   * Anthropic API key — the local-dev fallback when the managed-LLM broker is
   * NOT configured. Absent in hosted (broker) mode; present for `guuey dev`
   * and local testing.
   */
  anthropicApiKey?: string;
  /**
   * Loopback proxy base URL — hosted/broker mode. Task 8 injects this as
   * `ANTHROPIC_BASE_URL` into the worker's env via `buildWorkerEnv`. When
   * present together with `anthropicAuthToken`, the Claude CLI subprocess is
   * routed through the managed-LLM broker; the real API key is intentionally
   * absent so it cannot leak to agent code.
   */
  anthropicBaseUrl?: string;
  /**
   * Opaque session token for the loopback proxy — hosted/broker mode. Task 8
   * injects this as `ANTHROPIC_AUTH_TOKEN`. Required when `anthropicBaseUrl`
   * is set; ignored when only `anthropicApiKey` is present.
   */
  anthropicAuthToken?: string;
}

/**
 * Build the host boot context from the process environment. Pure — no side
 * effects, no disk access. Takes `env` as a parameter (rather than reading
 * `process.env` directly) so the function is straightforward to unit-test.
 */
export function buildHostContext(env: NodeJS.ProcessEnv): HostBootContext {
  return {
    openaiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
    anthropicAuthToken: env.ANTHROPIC_AUTH_TOKEN,
  };
}
