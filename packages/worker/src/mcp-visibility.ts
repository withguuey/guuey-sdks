import type { WithheldTool } from "./protocol.js";
import { withheldToolNamesFor } from "./withheld-tools.js";

/**
 * MCP Apps (SEP-1865) tool visibility. A tool whose `_meta.ui.visibility` does
 * not include `"model"` is for the app (the rendered view) and is never offered
 * to the model; neither is one whose visibility is present but cannot be read.
 * No `_meta`, no `ui`, or no `visibility` is the spec's default (the model and
 * the app).
 *
 * `listed` is the tool as its MCP listing carried it. The agent SDKs' own tool
 * types do not declare `_meta`, so it is read structurally.
 */
export function modelMayCallTool(listed: object): boolean {
  const meta = "_meta" in listed ? listed._meta : undefined;
  if (typeof meta !== "object" || meta === null || !("ui" in meta)) return true;
  const ui = meta.ui;
  if (ui === undefined) return true;
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) return false; // cannot be read
  if (!("visibility" in ui) || ui.visibility === undefined) return true;
  const visibility = ui.visibility;
  if (!Array.isArray(visibility) || !visibility.every((v: unknown) => typeof v === "string")) return false; // cannot be read
  return visibility.includes("model");
}

/**
 * The same rule as an OpenAI Agents SDK `toolFilter` callable, for a worker that
 * builds its own `MCPServerStreamableHttp`:
 * `new MCPServerStreamableHttp({ url, name, toolFilter: modelVisibleToolFilter })`.
 * The SDK awaits it for each listed tool, `_meta` included. It does not read the
 * turn's withholds; {@link modelVisibleToolFilterFor} does, and the code-mode
 * template uses that one.
 */
export async function modelVisibleToolFilter(_context: object, tool: object): Promise<boolean> {
  return modelMayCallTool(tool);
}

/**
 * {@link modelVisibleToolFilter} for one server on one turn: the same
 * visibility rule, and then the tools the Router withholds on `server` this
 * turn (`Invoke.withheldTools`, see `withheldToolNamesFor`) are dropped too.
 * `server` is the key the worker built the server under, the credential file's
 * name. Build one per server, per invoke:
 * `new MCPServerStreamableHttp({ url, name, toolFilter: modelVisibleToolFilterFor(name, invoke.withheldTools) })`.
 */
export function modelVisibleToolFilterFor(
  server: string,
  withheld: readonly WithheldTool[] | undefined
): (context: object, tool: { readonly name: string }) => Promise<boolean> {
  const blocked = new Set(withheldToolNamesFor(server, withheld));
  return async (_context, tool) => modelMayCallTool(tool) && !blocked.has(tool.name);
}
