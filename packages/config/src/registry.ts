/**
 * Model + framework registry — single source of truth per the model-release
 * playbook §8 item A; a release = one entry change here + rate-card row.
 */

export type ModelStatus = "ga" | "preview" | "announced" | "deprecated";

export interface ModelEntry {
  readonly id: string; // provider-native model id ("claude-sonnet-5")
  readonly provider: "anthropic" | "openai" | "google" | "openrouter";
  readonly label: string; // picker label ("Claude Sonnet 5")
  readonly status: ModelStatus; // 'announced' = known, NOT invocable on our org yet
  readonly isDefault?: true; // at most one per provider
  readonly sunset?: string; // ISO date, deprecated only
}

export interface FrameworkEntry {
  readonly framework: "claude-agent-sdk" | "openai-agents-sdk" | "google-adk" | "vanilla";
  readonly sdkPackage: string | null; // npm name; python pkg for adk; null for vanilla
  readonly platformPinnedVersion: string | null; // what the fat image ships
  readonly facetSupportedRange: string | null; // silverprotocol facet peer range
  readonly defaultProvider: "anthropic" | "openai" | "google";
}

/**
 * Array order is picker order AFTER `modelsForProvider` floats the default to
 * the front — the platform's app-behavior picker shows only `.slice(0, 2)` for
 * google + openai, so the second array entry per provider is a product-visible
 * choice, not incidental. Pinned by
 * `apps/platform/.../ModelSection/ModelSection.test.ts`.
 */
export const MODEL_REGISTRY: readonly ModelEntry[] = [
  { id: "claude-sonnet-5", provider: "anthropic", label: "Claude Sonnet 5", status: "ga", isDefault: true },
  // guuey#635 (2026-09-02 wave): id verified against
  // platform.claude.com/docs/en/models/overview — never hand-typed.
  { id: "claude-fable-5-1", provider: "anthropic", label: "Claude Fable 5.1", status: "ga" },
  // Stays `ga` on purpose: the deprecations page (read 2026-09-02) lists
  // claude-fable-5 as Active, Deprecated: N/A, tentative retirement "Not
  // sooner than June 9, 2027". `sunset` is an ISO date for DEPRECATED
  // entries; a not-sooner-than floor is not one. Flip only on a real
  // deprecation notice, quoting the page.
  { id: "claude-fable-5", provider: "anthropic", label: "Claude Fable 5", status: "ga" },
  { id: "claude-opus-5", provider: "anthropic", label: "Claude Opus 5", status: "ga" },
  { id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6", status: "ga" },
  { id: "claude-haiku-4-5", provider: "anthropic", label: "Claude Haiku 4.5", status: "ga" },
  { id: "claude-opus-4-8", provider: "anthropic", label: "Claude Opus 4.8", status: "ga" },
  // Terra — guuey's OpenAI default (founder call 2026-07-25). This DELIBERATELY
  // diverges from OpenAI's own `gpt-5.6` alias, which routes to Sol: Terra is
  // half Sol's price and the better cost/balance pick for hosted agent
  // workloads. The bare `gpt-5.6` alias is intentionally NOT a registry id
  // (never offered in a picker) — the rate card still rows it at Sol's price so
  // an alias call from BYO config can't under-meter.
  { id: "gpt-5.6-terra", provider: "openai", label: "GPT-5.6 Terra", status: "ga", isDefault: true },
  { id: "gpt-5.6-sol", provider: "openai", label: "GPT-5.6 Sol", status: "ga" },
  { id: "gpt-5.6-luna", provider: "openai", label: "GPT-5.6 Luna", status: "ga" },
  { id: "gpt-5.5", provider: "openai", label: "GPT-5.5", status: "ga" },
  { id: "gpt-5.4", provider: "openai", label: "GPT-5.4", status: "ga" },
  { id: "gpt-4o", provider: "openai", label: "GPT-4o", status: "ga" },
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o Mini", status: "ga" },
  { id: "gemini-3.6-flash", provider: "google", label: "Gemini 3.6 Flash", status: "ga", isDefault: true },
  { id: "gemini-3.5-flash-lite", provider: "google", label: "Gemini 3.5 Flash Lite", status: "ga" },
  { id: "gemini-3.5-flash", provider: "google", label: "Gemini 3.5 Flash", status: "ga" },
  { id: "gemini-3.1-pro", provider: "google", label: "Gemini 3.1 Pro", status: "ga" },
  { id: "gemini-2.5-flash", provider: "google", label: "Gemini 2.5 Flash", status: "ga" },
  { id: "gemini-2.5-pro", provider: "google", label: "Gemini 2.5 Pro", status: "ga" },
];

export const FRAMEWORK_REGISTRY: readonly FrameworkEntry[] = [
  {
    framework: "claude-agent-sdk",
    sdkPackage: "@anthropic-ai/claude-agent-sdk",
    // platformPinnedVersion = what the fat image ships. Guarded twice
    // (guuey#648/#653): scripts/check-pin-coherence.mjs (CI + pre-push,
    // the whole host-shared==registry==image==host==facet-peer chain) and
    // registry.pins.test.ts (always-on vs @guuey/host — the publish-time
    // belt that also runs where the root script does not exist).
    platformPinnedVersion: "0.3.247",
    facetSupportedRange: ">=0.2.76 <0.4",
    defaultProvider: "anthropic",
  },
  {
    framework: "openai-agents-sdk",
    sdkPackage: "@openai/agents",
    platformPinnedVersion: "0.17.0",
    facetSupportedRange: ">=0.2.0 <0.18",
    defaultProvider: "openai",
  },
  {
    framework: "google-adk",
    sdkPackage: "@google/adk", // the OFFICIAL JS ADK (the Python lane retired with guuey_adk_host)
    platformPinnedVersion: "1.3.0", // pinned in @guuey-private/host-shared
    facetSupportedRange: ">=1.0.0 <2", // @silverprotocol/google-adk peer range
    defaultProvider: "google",
  },
  {
    framework: "vanilla",
    sdkPackage: null,
    platformPinnedVersion: null,
    facetSupportedRange: null,
    defaultProvider: "anthropic",
  },
];

/**
 * Get all models for a provider, filtered to ga|preview only, with default first.
 */
export function modelsForProvider(p: ModelEntry["provider"]): readonly ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => m.provider === p && (m.status === "ga" || m.status === "preview")).sort(
    (a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return 0;
    },
  );
}

/**
 * Get the default model id for a framework's default provider.
 */
export function defaultModelFor(framework: FrameworkEntry["framework"]): string {
  const fw = FRAMEWORK_REGISTRY.find((f) => f.framework === framework);
  if (!fw) throw new Error(`Unknown framework: ${framework}`);
  const model = MODEL_REGISTRY.find((m) => m.provider === fw.defaultProvider && m.isDefault && m.status === "ga");
  if (!model) throw new Error(`No default ga model for provider: ${fw.defaultProvider}`);
  return model.id;
}

/**
 * Look up a model entry by id.
 */
export function modelEntry(id: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}
