/**
 * The Router's per-turn tool withholds (`Invoke.withheldTools`), applied the
 * same way by every worker that hands a model an MCP catalog: a withhold names
 * an MCP server by its key (the credential file's name) and a tool on it, and
 * the worker removes that tool from the catalog it hands the model this turn.
 * `@guuey/host` folds the names into Claude's `disallowedTools`, an OpenAI
 * server's `toolFilter` and an ADK toolset's predicate. A code-mode worker that
 * builds its own MCP connections applies them itself; for an OpenAI Agents SDK
 * worker, `modelVisibleToolFilterFor` is that `toolFilter`. A withhold naming a
 * server that is not attached this turn changes nothing.
 */
import type { WithheldTool } from "./protocol.js";

/** The tool names withheld on `server` this turn (empty when none). */
export function withheldToolNamesFor(
  server: string,
  withheld: readonly WithheldTool[] | undefined
): string[] {
  if (withheld === undefined) return [];
  return [...new Set(withheld.filter((w) => w.server === server).map((w) => w.tool))];
}
