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
 * the CLI after `guuey create` / `guuey pull --app-id`.
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
 * The ONE `guuey.json` `schema` value this package understands — the
 * schema-version stance (guuey#248 b2):
 *
 * - The root `schema` is a decimal integer string (`"1"`, `"2"`, …), bumped
 *   only on a change that an older reader cannot interpret correctly.
 * - A document declaring a NEWER schema than this constant is refused
 *   everywhere: the CLI (`SCHEMA_TOO_NEW` — upgrade `@guuey/cli`) and the
 *   reconcile / deploy-trigger APIs (`400 SCHEMA_UNSUPPORTED`). Never
 *   "best-effort parse what we recognize" — the unknown half is precisely
 *   the half that matters.
 * - A document declaring an OLDER schema is accepted only when a migration
 *   to this version exists. Today there is exactly one version and no
 *   migrations, so the rule collapses to equal-or-refuse; when `"2"` ships,
 *   the `1 → 2` migration lands in this package and BOTH sides (CLI + API)
 *   pick it up through {@link classifyGuueyJsonSchema}.
 *
 * The CLI and the platform API compare against the SAME constant (both
 * consume this package), so "the CLI accepted it but the API refused it"
 * can only ever mean a version skew between the two — which is exactly the
 * message the API's refusal names.
 */
export const SUPPORTED_GUUEY_JSON_SCHEMA = '1';

/**
 * Where a raw `guuey.json` document's `schema` sits relative to
 * {@link SUPPORTED_GUUEY_JSON_SCHEMA}:
 *
 * - `supported` — equal (or an older version a migration exists for; none
 *   today).
 * - `newer` — a later version than this reader knows: refuse + upgrade.
 * - `older` — an earlier version with NO migration: refuse.
 * - `invalid` — absent, not a string, or not a decimal integer string; the
 *   full schema parse reports the precise issue, this verdict only says the
 *   version-gate cannot even compare.
 */
export type GuueyJsonSchemaVerdict =
  | { kind: 'supported'; found: string }
  | { kind: 'newer'; found: string }
  | { kind: 'older'; found: string }
  | { kind: 'invalid'; found: string | undefined };

/**
 * Classify a raw (JSON-decoded, NOT yet schema-parsed) document's root
 * `schema` against {@link SUPPORTED_GUUEY_JSON_SCHEMA}. Pure; never throws.
 * Run it BEFORE `parseGuueyJson` so a too-new document gets the "upgrade
 * your CLI" face instead of zod's `expected "1"` at the first field.
 */
export function classifyGuueyJsonSchema(raw: unknown): GuueyJsonSchemaVerdict {
  const found =
    raw !== null && typeof raw === 'object' && 'schema' in raw
      ? (raw as { schema: unknown }).schema
      : undefined;
  if (typeof found !== 'string' || !/^[1-9][0-9]*$/.test(found)) {
    return { kind: 'invalid', found: typeof found === 'string' ? found : undefined };
  }
  const have = Number.parseInt(SUPPORTED_GUUEY_JSON_SCHEMA, 10);
  const got = Number.parseInt(found, 10);
  if (got === have) return { kind: 'supported', found };
  return got > have ? { kind: 'newer', found } : { kind: 'older', found };
}

/**
 * Thrown by {@link assertSupportedGuueyJsonSchema} — carries the code the
 * CLI prints and the API maps to its 400 (`SCHEMA_TOO_NEW` = upgrade the
 * reader; `SCHEMA_UNSUPPORTED` = an older version no migration exists for).
 * The message already names the found + supported versions and the remedy.
 */
export class GuueyJsonSchemaError extends Error {
  constructor(
    public readonly code: 'SCHEMA_TOO_NEW' | 'SCHEMA_UNSUPPORTED',
    public readonly found: string,
    message: string,
  ) {
    super(message);
    this.name = 'GuueyJsonSchemaError';
  }
}

/**
 * Refuse a document whose `schema` this reader cannot honor. `invalid`
 * verdicts pass through untouched — the schema parse that follows reports
 * the precise issue (`at "schema": expected "1"`), which is the right face
 * for a typo; this gate exists for the version SKEW cases only.
 *
 * Runs inside `readGuueyJsonFile` / `loadGuueyJson` (every CLI read of a
 * checked-in file — `deploy`, `dev`, `agent apply`, …) and in the platform's
 * reconcile + deploy-trigger handlers, so both ends of the wire refuse the
 * same documents for the same reason. The message names the remedy for the
 * only reader outside the platform: the CLI.
 */
export function assertSupportedGuueyJsonSchema(raw: unknown): void {
  const verdict = classifyGuueyJsonSchema(raw);
  if (verdict.kind === 'newer') {
    throw new GuueyJsonSchemaError(
      'SCHEMA_TOO_NEW',
      verdict.found,
      `guuey.json declares schema "${verdict.found}", but this reader understands schema "${SUPPORTED_GUUEY_JSON_SCHEMA}" only. ` +
        'Upgrade the tool reading it — for the CLI: npm i -g @guuey/cli@latest — and re-run.',
    );
  }
  if (verdict.kind === 'older') {
    throw new GuueyJsonSchemaError(
      'SCHEMA_UNSUPPORTED',
      verdict.found,
      `guuey.json declares schema "${verdict.found}", but no migration to schema "${SUPPORTED_GUUEY_JSON_SCHEMA}" exists — ` +
        `set "schema": "${SUPPORTED_GUUEY_JSON_SCHEMA}" and update the document to the current shape.`,
    );
  }
}

/**
 * Top-level guuey.json v1 schema.
 *
 * `agent` is required — there's no "empty" guuey.json. A repo that hosts
 * only an MCP server uses `guuey.mcp.json` instead (separate schema).
 *
 * `appId` and `workspaceId` are platform-resolved identifiers stamped by
 * the CLI after `guuey create` / `guuey pull --app-id`. A fresh project has
 * neither. After first `guuey create`, both may be present.
 *
 * Re-exports the sub-section types for consumer convenience.
 */
export const GuueyJsonV1 = z.strictObject({
  schema: z.literal(SUPPORTED_GUUEY_JSON_SCHEMA),

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

  /**
   * Worker entry override — path to the built worker bundle, relative to the
   * project root. Absence means the default build output, `guuey.worker.js`.
   *
   * This is the template-authored escape hatch `guuey dev` (`commands/
   * dev.ts`) and `guuey deploy` (`commands/deploy.ts`) resolve for a
   * non-default build output path; without this field in the schema the
   * strict parse rejected any document that used it, contradicting both
   * consumers' documented contract.
   */
  worker: z.string().min(1).optional(),

  /**
   * Transport selector — which AgJSON protocol leg the pod uses when
   * streaming responses to the client.
   *
   * - `'silver'` (default) — SilverProtocol / AgJSON streaming (native guuey).
   * - `'bypass'` — raw pass-through; the agent pod writes directly to the SSE
   *   stream without AgJSON framing. Useful for agents that produce their own
   *   structured output or during protocol migration.
   *
   * No `'ag-ui'` value — AgJSON has no AG-UI output leg.
   */
  protocol: z.enum(['silver', 'bypass']).default('silver'),

  /**
   * Platform runtime pin — lets a code-mode agent declare which Guuey Router
   * version its worker is built against. Absence means v1 (the default and
   * currently only supported version).
   */
  runtime: z.strictObject({
    /** Guuey Router version this agent's worker is built against. */
    router: z.enum(['v1']).default('v1'),
  }).optional(),
});

/** Static TypeScript type for `guuey.json` v1. */
export type GuueyJsonV1 = z.infer<typeof GuueyJsonV1>;

/**
 * Author-side shape for `guuey.json` v1 — what a writer may construct before
 * `parseGuueyJson` applies schema defaults (e.g. `protocol` → `'silver'`).
 * Fields with defaults are optional here and required on {@link GuueyJsonV1}.
 */
export type GuueyJsonV1Input = z.input<typeof GuueyJsonV1>;

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
