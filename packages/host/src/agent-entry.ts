/**
 * Graceful-mode agent-entry loading: resolve the dev's module STRICTLY under
 * the worker root, import it, and materialize the agent from its default
 * export (plain agent object or `(GuueyContext) => agent` factory).
 *
 * Security posture: `GUUEY_AGENT_ENTRY` originates from customer-controlled
 * `guuey.json#agent.entry`, so the resolved path MUST stay inside the worker
 * root — traversal (`../…`, absolute escapes) is rejected before any import
 * happens. The boundary this protects is tidiness, not secrecy (the sandbox
 * is the real boundary; the host process holds nothing a full worker would
 * not), but containment is cheap and closes the path-injection class.
 */
import { createRequire } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { GuueyContext } from "@guuey/config";

/**
 * Load a module by absolute path with NODE's own resolution — opaque to
 * bundlers/test transformers (vitest's SSR runner rewrites literal `import()`
 * into its own resolver, which cannot load arbitrary runtime paths under
 * /worker). `createRequire` + Node ≥22.12 `require(esm)` handles both CJS and
 * ESM customer modules synchronously; a module using top-level await is the
 * one unsupported shape (pathological for a per-invoke-loaded agent) and
 * surfaces as Node's own ERR_REQUIRE_ASYNC_MODULE.
 */
export function nativeLoad(modulePath: string): unknown {
  return createRequire(pathToFileURL(modulePath).href)(modulePath);
}

/** Env var carrying the entry path (relative to the worker root). */
export const AGENT_ENTRY_ENV = "GUUEY_AGENT_ENTRY";
/** Env var overriding the worker root (defaults to the sandbox mount). */
export const WORKER_ROOT_ENV = "GUUEY_WORKER_ROOT";
/** The sandbox's worker mount — where builder-mode code lives. */
export const DEFAULT_WORKER_ROOT = "/worker";

/**
 * Resolve `entry` (from guuey.json, customer-controlled) against the worker
 * root, rejecting anything that escapes it. Returns the absolute entry path.
 */
export function resolveAgentEntry(entry: string, workerRoot: string = DEFAULT_WORKER_ROOT): string {
  if (isAbsolute(entry)) {
    throw new Error(
      `@guuey/host: agent.entry must be a path relative to the worker root (got absolute "${entry}").`,
    );
  }
  const root = resolve(workerRoot);
  const resolved = resolve(root, entry);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(
      `@guuey/host: agent.entry "${entry}" escapes the worker root (${root}) — traversal is not allowed.`,
    );
  }
  return resolved;
}

/**
 * Import the entry module and return its default export. A module without a
 * default export is a contract error with an actionable message.
 */
export async function loadAgentEntry(entryPath: string): Promise<unknown> {
  const mod = nativeLoad(entryPath) as { default?: unknown };
  if (mod.default === undefined) {
    throw new Error(
      `@guuey/host: the agent entry (${entryPath}) has no default export. ` +
        `Export your framework-native agent object, or a factory (guuey: GuueyContext) => agent.`,
    );
  }
  return mod.default;
}

/**
 * Materialize the agent from the entry's default export:
 *  - a FUNCTION is the factory form — invoked (and awaited) with the
 *    {@link GuueyContext};
 *  - anything else is the plain-agent form, used as-is. Platform MCP toolsets
 *    are NOT silently injected into a dev-constructed agent (no mutation
 *    magic) — when servers are configured but the export is plain, `warn` is
 *    called once with the factory-form hint.
 */
export async function materializeAgent<TToolset>(
  exported: unknown,
  ctx: GuueyContext<TToolset>,
  warn: (message: string) => void,
): Promise<object> {
  if (typeof exported === "function") {
    const agent: unknown = await (exported as (g: GuueyContext<TToolset>) => unknown)(ctx);
    if (typeof agent !== "object" || agent === null) {
      throw new Error(
        `@guuey/host: the agent factory returned ${agent === null ? "null" : typeof agent} — expected the framework-native agent object.`,
      );
    }
    return agent;
  }
  if (typeof exported !== "object" || exported === null) {
    throw new Error(
      `@guuey/host: the agent entry's default export is ${exported === null ? "null" : typeof exported} — ` +
        `expected an agent object or a factory function.`,
    );
  }
  if (ctx.mcpToolsets.length > 0) {
    warn(
      `@guuey/host: guuey.json declares ${ctx.mcpToolsets.length} MCP server(s), but the agent entry exports a plain agent — ` +
        `platform MCP toolsets are NOT auto-injected. Export a factory ((guuey) => agent) and spread guuey.mcpToolsets into your tools to use them.`,
    );
  }
  return exported;
}
