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

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  { id: "claude-sonnet-5", provider: "anthropic", label: "Claude Sonnet 5", status: "ga", isDefault: true },
  { id: "claude-fable-5", provider: "anthropic", label: "Claude Fable 5", status: "ga" },
  { id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6", status: "ga" },
  { id: "claude-haiku-4-5", provider: "anthropic", label: "Claude Haiku 4.5", status: "ga" },
  { id: "claude-opus-4-8", provider: "anthropic", label: "Claude Opus 4.8", status: "ga" },
  { id: "gpt-5.5", provider: "openai", label: "GPT-5.5", status: "ga", isDefault: true },
  { id: "gpt-5.4", provider: "openai", label: "GPT-5.4", status: "ga" },
  { id: "gpt-4o", provider: "openai", label: "GPT-4o", status: "ga" },
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o Mini", status: "ga" },
  { id: "gpt-5.6", provider: "openai", label: "GPT-5.6", status: "announced" },
  { id: "gemini-3.5-flash", provider: "google", label: "Gemini 3.5 Flash", status: "ga", isDefault: true },
  { id: "gemini-3.1-pro", provider: "google", label: "Gemini 3.1 Pro", status: "ga" },
  { id: "gemini-2.5-flash", provider: "google", label: "Gemini 2.5 Flash", status: "ga" },
  { id: "gemini-2.5-pro", provider: "google", label: "Gemini 2.5 Pro", status: "ga" },
];

export const FRAMEWORK_REGISTRY: readonly FrameworkEntry[] = [
  {
    framework: "claude-agent-sdk",
    sdkPackage: "@anthropic-ai/claude-agent-sdk",
    platformPinnedVersion: "0.3.199",
    facetSupportedRange: ">=0.2.76 <0.4",
    defaultProvider: "anthropic",
  },
  {
    framework: "openai-agents-sdk",
    sdkPackage: "@openai/agents",
    platformPinnedVersion: "0.12.0",
    facetSupportedRange: ">=0.2.0 <0.13",
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
