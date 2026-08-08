/**
 * ggui asset leg — derive a project's asset state from its `ggui/` dir and
 * push it to the cliApi control plane (create-agentic-app T14/T15, rewritten
 * to the ratified #387 contract in guuey#121).
 *
 * Design doc `2026-07-03-guuey-create-agentic-app-design.md` §8: the deploy
 * orchestrator (`commands/deploy.ts`, Step 3 — after MCP legs, before the
 * agent leg) calls {@link buildGguiAssetPush} then {@link pushGguiAssetsLeg}.
 *
 * The push endpoint EXISTS on both sides now — ggui's ratified assets route
 * shipped and cliApi forwards to it. What remains per-environment is ARMING:
 * the handler is gated on its own `GGUI_ASSETS_PUSH_API_URL`, an operator
 * `addEnvironment` at a promotion sitting. Until an environment is armed the
 * route returns the flat `501 {code:'not-yet-supported'}` — the ONLY response
 * the CLI treats as warn-and-continue. Every other error, including any other
 * 501, aborts the deploy before the agent leg runs (§7 ordering).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuthTokens } from './auth';
import type { ResolvedConfig } from './config';
import { apiRequest, parseApiError } from './deploy-shared';
import { compileProjectBlueprints, type PushBlueprintRecord } from './ggui-blueprints';

/**
 * Wire contract for `POST /v1/apps/:id/ggui-assets/push` — the PROJECT-derived
 * slice of the app's asset state. Mirrors
 * `backend/amplify/functions/cliApi/handlers/ggui-assets.ts`'s
 * `GguiAssetPushBody` verbatim — duplicated here (not imported) because the
 * CLI is an OSS package (`@guuey/cli`) and cannot depend on the closed
 * backend (`@guuey-private/*`).
 *
 * The platform-composed fields are deliberately NOT on this wire: `ownerRef`
 * and the brand `theme` are facts cliApi owns, and `generation.keySource` is
 * a platform fact (guuey-managed federation runs on ggui-managed keys) — the
 * project declares only the model. A `ggui.json` that carries its own `theme`
 * block is therefore ignored HERE by design, not by omission.
 */
export interface GguiAssetPushBody {
  /** Project-declared generation model (`ggui.json#generation.model`). */
  generation?: { model: string };
  /** Passed through opaque when `ggui.json` declares them — ggui validates. */
  gadgets?: unknown[];
  publicEnv?: Record<string, string>;
  /** Client-side-compiled records from `<ggui dir>/blueprints`. */
  blueprints?: PushBlueprintRecord[];
}

/** Total payload cap (serialized bytes). Matches the backend's own cap. */
const MAX_PUSH_BYTES = 1024 * 1024; // 1 MiB

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Build the project-derived push body from a project's ggui assets.
 *
 * `configFile` is `guuey.json#ggui.configFile` (e.g. `./ggui/ggui.json`);
 * the asset dir is its directory. Only DECLARED fields ride: an absent
 * `generation`/`gadgets`/`publicEnv` in `ggui.json` is omitted from the body
 * rather than sent empty — the endpoint is full-state replace, so `{}` and
 * "absent" mean the same thing to ggui and the smaller body is the honest
 * one. Blueprints are compiled from `<ggui dir>/blueprints` and included
 * only when at least one compiled.
 *
 * Throws if `configFile` doesn't resolve to a real file, if it isn't valid
 * JSON, if a declared field has the wrong type, or if the serialized body
 * exceeds the 1 MiB cap the backend enforces (fail fast, client-side, before
 * the network call).
 */
export async function buildGguiAssetPush(
  projectRoot: string,
  configFile: string,
): Promise<GguiAssetPushBody> {
  const gguiJsonPath = join(projectRoot, configFile);
  if (!existsSync(gguiJsonPath) || !statSync(gguiJsonPath).isFile()) {
    throw new Error(`ggui config file not found: ${configFile} (resolved to ${gguiJsonPath})`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(gguiJsonPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `ggui config file ${configFile} is not valid JSON: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(doc)) {
    throw new Error(`ggui config file ${configFile} must contain a JSON object`);
  }

  const body: GguiAssetPushBody = {};

  // `generation.keySource` is never lifted — see the GguiAssetPushBody doc.
  const generation = doc['generation'];
  if (generation !== undefined) {
    if (!isPlainObject(generation)) {
      throw new Error(`${configFile}#generation must be an object`);
    }
    const model = generation['model'];
    if (typeof model !== 'string' || model.length === 0) {
      // Fail fast, never drop: the endpoint is FULL-STATE REPLACE, so a
      // silently-omitted generation would REMOVE the app's pushed model
      // override on a green deploy. Same message shape as cliApi's own
      // validation of this wire slice.
      throw new Error(`${configFile}#generation.model must be a non-empty string`);
    }
    const extraKeys = Object.keys(generation).filter((k) => k !== 'model');
    if (extraKeys.length > 0) {
      throw new Error(
        `${configFile}#generation has unsupported field(s) ${extraKeys.join(', ')} — ` +
          'only {model} is project-declared (keySource is platform-composed)',
      );
    }
    body.generation = { model };
  }

  const gadgets = doc['gadgets'];
  if (gadgets !== undefined) {
    if (!Array.isArray(gadgets)) {
      throw new Error(`${configFile}#gadgets must be an array of gadget descriptors`);
    }
    body.gadgets = gadgets;
  }

  const publicEnv = doc['publicEnv'];
  if (publicEnv !== undefined) {
    if (!isPlainObject(publicEnv) || Object.values(publicEnv).some((v) => typeof v !== 'string')) {
      throw new Error(`${configFile}#publicEnv must be an object of string values`);
    }
    // Narrowed by the guard above — every value is a string.
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(publicEnv)) {
      if (typeof v === 'string') entries[k] = v;
    }
    body.publicEnv = entries;
  }

  const blueprints = await compileProjectBlueprints(join(dirname(gguiJsonPath), 'blueprints'));
  if (blueprints.length > 0) {
    body.blueprints = blueprints;
  }

  const totalBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (totalBytes > MAX_PUSH_BYTES) {
    throw new Error(`ggui asset payload exceeds 1 MiB limit (got ${totalBytes} bytes)`);
  }

  return body;
}

/**
 * The exact dormancy-501 shape the backend returns
 * (`httpJson(501, {code:'not-yet-supported', message})` in
 * `ggui-assets.ts`'s `handleGguiAssetsPush`) — a deliberate non-error
 * signal, distinct from a real 501 `GuueyError` (which serializes nested,
 * `{error:{code,message}}`, per `httpError`).
 */
function isDormancy501(data: unknown): data is { code: string; message?: string } {
  if (data === null || typeof data !== 'object') return false;
  const rec = data as Record<string, unknown>;
  return (
    rec.code === 'not-yet-supported' &&
    (rec.message === undefined || typeof rec.message === 'string')
  );
}

/**
 * Push a {@link GguiAssetPushBody} to `POST /v1/apps/:id/ggui-assets/push`.
 *
 * - `200` → `{ pushed: true }`, plus whatever the handler echoed back about
 *   what landed (`configFields` / `blueprintsPushed` / `blueprintsDeleted`).
 * - `501 {code:'not-yet-supported'}` (the route not yet armed on this
 *   environment) → `{ pushed: false, reason }`, NOT a throw — this is the
 *   warn-and-continue leg, distinct from a real error.
 * - Any other non-2xx, INCLUDING a 501 that isn't the exact dormancy shape
 *   above → throws. A 501 is only ever a signal we've defined ourselves;
 *   any other code on that status is unexpected and must abort the deploy
 *   rather than silently continue.
 *
 * `deps.api` defaults to the real `apiRequest` and exists purely for test
 * injection — network stubbing without a live backend (mirrors
 * `deployMcpFromSource`'s `deps.api` seam in `commands/mcp.ts`).
 */
export async function pushGguiAssetsLeg(
  opts: {
    appId: string;
    body: GguiAssetPushBody;
    auth: AuthTokens;
    config: ResolvedConfig;
  },
  deps?: { api?: typeof apiRequest },
): Promise<{
  pushed: boolean;
  reason?: string;
  configFields?: string[];
  blueprintsPushed?: number;
  blueprintsDeleted?: number;
}> {
  const api = deps?.api ?? apiRequest;
  const { appId, body, auth, config } = opts;

  const res = await api(auth.pat, config, 'POST', `/apps/${appId}/ggui-assets/push`, body);

  if (res.ok) {
    // The echo is diagnostics, not the contract — a 2xx already means the
    // push landed, so an unparseable body must not turn success into a throw.
    const echo: unknown = await res.json().catch(() => ({}));
    if (!isPlainObject(echo)) return { pushed: true };
    return {
      pushed: true,
      ...(Array.isArray(echo.configFields)
        ? { configFields: echo.configFields.filter((f): f is string => typeof f === 'string') }
        : {}),
      ...(typeof echo.blueprintsPushed === 'number'
        ? { blueprintsPushed: echo.blueprintsPushed }
        : {}),
      ...(typeof echo.blueprintsDeleted === 'number'
        ? { blueprintsDeleted: echo.blueprintsDeleted }
        : {}),
    };
  }

  const data: unknown = await res.json().catch(() => ({}));

  if (res.status === 501 && isDormancy501(data)) {
    return {
      pushed: false,
      reason: data.message ?? 'ggui asset push is not yet enabled on this environment.',
    };
  }

  throw new Error(parseApiError(data, `ggui asset push failed: HTTP ${res.status}`));
}
