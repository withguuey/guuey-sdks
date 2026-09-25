/**
 * The builder's tool gates (`agent.tools.allowlist` / `agent.tools.denylist`,
 * the `@guuey/config` grammar) as a per-server predicate, for the frameworks
 * that filter an MCP server's tools one server at a time: OpenAI (the
 * server's `toolFilter`) and ADK (the toolset's predicate). The Claude host
 * translates the same grammar into its SDK's allow and deny rules
 * (`frameworks/claude-options.ts`, `resolveToolGates`). Both follow one
 * contract: the allowlist first (the model may call ONLY these), then the
 * denylist subtracts, then this turn's withholds (`Invoke.withheldTools`).
 *
 * The grammar, per server S:
 *   - `S.tool`: that tool on S;
 *   - `S.*`: every tool on S;
 *   - a bare `tool`: that tool on EVERY server.
 * An entry naming another server says nothing about S; so under an allowlist
 * that never names S (and has no bare entry it matches), S keeps nothing. A
 * malformed entry (the deploy gate rejects them; a stale snapshot could still
 * carry one) is dropped, never matched verbatim.
 *
 * Built-ins: OpenAI and ADK agents carry no built-in tools (the Claude host's
 * file tools and `Bash` exist only there), so a bare built-in name gates only
 * an MCP tool of that name. Denying `Bash` is a no-op for everything else; an
 * allowlist of built-ins alone narrows each server to tools of those names.
 */
import { parseToolGateEntry, type GuueyAgent } from "@guuey/config";
import type { WithheldTool } from "@guuey/worker";
import { withheldToolNamesFor } from "./withheld-tools.js";

/** The snapshot's gate block. */
export type ToolGates = GuueyAgent["tools"];

/** One gate list read for one server: whether it names the server whole, and the tool names it names there. */
function namesOn(server: string, entries: readonly string[]): { whole: boolean; tools: Set<string> } {
  let whole = false;
  const tools = new Set<string>();
  for (const raw of entries) {
    const parsed = parseToolGateEntry(raw);
    if ("error" in parsed) continue;
    if (parsed.kind === "bare") tools.add(parsed.tool);
    else if (parsed.server !== server) continue;
    else if (parsed.kind === "server-all") whole = true;
    else tools.add(parsed.tool);
  }
  return { whole, tools };
}

/**
 * The predicate that keeps a tool on `server` this turn, or `undefined` when
 * nothing is filtered (no allowlist narrowing, nothing denied or withheld):
 * the framework then builds the server exactly as before.
 */
export function mcpToolPredicateFor(
  server: string,
  gates: ToolGates,
  withheld?: readonly WithheldTool[],
): ((tool: string) => boolean) | undefined {
  const allowEntries = gates?.allowlist ?? [];
  const allow = allowEntries.length > 0 ? namesOn(server, allowEntries) : undefined;
  const deny = namesOn(server, gates?.denylist ?? []);
  const blocked = new Set([...deny.tools, ...withheldToolNamesFor(server, withheld)]);
  const narrowed = allow !== undefined && !allow.whole;
  if (!narrowed && !deny.whole && blocked.size === 0) return undefined;
  return (tool) => {
    if (deny.whole || blocked.has(tool)) return false;
    return !narrowed || (allow !== undefined && allow.tools.has(tool));
  };
}
