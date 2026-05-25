/**
 * `guuey.json` v1 — the merged platform config.
 *
 * Single source of truth for a guuey-deployed project. Composed of:
 *
 * - `agent` (required for agent deploys) — declarative runtime + deploy config
 * - `app`   (optional) — App Store / Portal listing metadata
 * - `ggui`  (optional) — cross-protocol integration if the agent uses ggui rendering
 *
 * Plus top-level platform identity (`appId`, `workspaceId`) populated by
 * the CLI after `guuey create` / `guuey link`.
 *
 * **Filename convention** (filename = artifact kind, see design doc §3):
 * ```
 * guuey.json       ← agent deploy (this file's schema)
 * guuey.mcp.json   ← MCP server deploy (separate schema — see guuey-mcp.ts when added)
 * ```
 *
 * **History.** Pre-2026-05-25 the repo carried two separate files:
 *   - `agent.json` — runtime contract (slice 2.0)
 *   - `guuey.json` — hosted overlay (project, deploy, deployments, mcpProxies, mcpServers)
 *
 * Slice 7.2 (2026-05-25) merged them per platform-architecture design doc §3.1
 * + §14.2 field-by-field migration table. Pre-launch no-backcompat rule —
 * the old shape is GONE, not deprecated.
 *
 * **Minimum valid `guuey.json`** (every other field defaults):
 *
 * ```jsonc
 * {
 *   "schema": "1",
 *   "agent": {
 *     "framework": "claude-agent-sdk",
 *     "model": "claude-sonnet-4-6",
 *     "systemPrompt": { "file": "prompts/system.md" }
 *   }
 * }
 * ```
 */
import { z } from 'zod';
import { AgentSectionV1, type GuueyAgent } from './agent.js';
import { AppSectionV1, type GuueyApp } from './app.js';
import { GguiSectionV1, type GuueyGguiSection } from './ggui.js';

/**
 * Top-level guuey.json v1 schema.
 *
 * `agent` is required — there's no "empty" guuey.json. A repo that hosts
 * only an MCP server uses `guuey.mcp.json` instead (separate schema).
 *
 * `appId` and `workspaceId` are platform-resolved identifiers stamped by
 * the CLI after `guuey create` / `guuey link`. A fresh project has neither.
 * After first `guuey create`, both may be present.
 *
 * Re-exports the sub-section types for consumer convenience.
 */
export const GuueyJsonV1 = z.strictObject({
  schema: z.literal('1'),

  /** Stable agent identifier minted by the control plane on first `guuey create`. */
  appId: z.string().min(1).max(128).optional(),
  /** Workspace the project lives under. Optional — personal apps + freshly-linked apps. */
  workspaceId: z.string().min(1).max(128).optional(),

  /** The deployable agent definition + deploy config. */
  agent: AgentSectionV1,

  /** App Store / Portal listing metadata. Optional. */
  app: AppSectionV1.optional(),

  /** Cross-protocol integration (ggui.ai rendering). Optional. */
  ggui: GguiSectionV1.optional(),
});

/** Static TypeScript type for `guuey.json` v1. */
export type GuueyJsonV1 = z.infer<typeof GuueyJsonV1>;

// Re-export sub-section types so consumers can import everything from `@guuey/config`.
export type { GuueyAgent, GuueyApp, GuueyGguiSection };

/**
 * Canonical filename — always at the project root, always this name.
 * Exported so tooling uses the same constant instead of hard-coding.
 */
export const GUUEY_JSON_FILENAME = 'guuey.json';

/**
 * Parse a raw JSON value into a validated {@link GuueyJsonV1}.
 * Throws a `ZodError` with human-readable issues on invalid input.
 *
 * Callers must have already JSON-decoded the source. Does NOT resolve
 * `agent.systemPrompt.file` references — that's the loader's job (see
 * `./loader.ts#loadGuueyJson`). Pure parse is safe to run anywhere;
 * file resolution requires a base directory and is Node-only.
 */
export function parseGuueyJson(raw: unknown): GuueyJsonV1 {
  return GuueyJsonV1.parse(raw);
}

/**
 * Safe-parse variant — returns a discriminated `z.safeParse` result.
 * Prefer this inside CLI tooling where you want to render the issue
 * list without try/catch.
 */
export function safeParseGuueyJson(
  raw: unknown,
): ReturnType<typeof GuueyJsonV1.safeParse> {
  return GuueyJsonV1.safeParse(raw);
}
