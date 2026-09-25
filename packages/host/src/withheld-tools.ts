/**
 * The Router's per-turn tool withholds (`Invoke.withheldTools`), applied the
 * same way by every framework adapter: a withhold names an MCP server by its
 * key (the credential file's name) and a tool on it, and the adapter removes
 * that tool from the catalog it hands the model this turn. Claude folds the
 * names into `disallowedTools`, OpenAI into the server's `toolFilter`, ADK
 * into the toolset's predicate. A withhold naming a server that is not
 * attached this turn changes nothing.
 */
import type { WithheldTool } from "@guuey/worker";

/** The tool names withheld on `server` this turn (empty when none). */
export function withheldToolNamesFor(server: string, withheld: readonly WithheldTool[] | undefined): string[] {
  if (withheld === undefined) return [];
  return [...new Set(withheld.filter((w) => w.server === server).map((w) => w.tool))];
}
