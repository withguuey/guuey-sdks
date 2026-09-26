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
 * builds its own `MCPServerStreamableHttp` (the code-mode template does):
 * `new MCPServerStreamableHttp({ url, name, toolFilter: modelVisibleToolFilter })`.
 * The SDK awaits it for each listed tool, `_meta` included.
 */
export async function modelVisibleToolFilter(_context: object, tool: object): Promise<boolean> {
  return modelMayCallTool(tool);
}
