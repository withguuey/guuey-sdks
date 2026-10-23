/**
 * The builder's tool gates (`agent.tools.allowlist` / `agent.tools.denylist`,
 * the grammar parsed by {@link parseToolGateEntry}) applied at turn time. This
 * is the ONE implementation: `@guuey/host` and the code-mode scaffolds
 * (`@guuey/create-agentic-app`) both call it. It is pure and imports no agent
 * SDK, so any worker can use it.
 *
 * Two shapes of the same contract:
 *   - {@link toolGatePredicate}: a per-server predicate, for the frameworks
 *     that filter one MCP server's listing at a time (OpenAI's `toolFilter`,
 *     ADK's toolset predicate).
 *   - {@link claudeToolRules}: the Claude Agent SDK's allow and deny rules
 *     (`mcp__<server>[__<tool>]` spelling) plus a permission check. The check
 *     is typed structurally ({@link ToolPermissionCheck}); it is assignable to
 *     the SDK's `CanUseTool`.
 *
 * The contract, per server S:
 *   1. `["@none"]` ({@link NO_TOOLS_ENTRY}) keeps no MCP tool.
 *   2. Otherwise the allowlist narrows (the model may call ONLY these), then
 *      the denylist subtracts, then this turn's withholds subtract. Deny wins.
 *   3. An empty list (`[]`) reads exactly like an absent one.
 *   4. Entries: `S.tool` is that tool on S; `S.*` is every tool on S; a bare
 *      `tool` is that tool on EVERY server. An entry naming another server
 *      says nothing about S, so under an allowlist that never names S (and has
 *      no bare entry), S keeps nothing.
 *   5. A malformed entry (the deploy gate rejects them; a stale snapshot could
 *      still carry one) is dropped, never matched verbatim.
 *   6. `"@none"` mixed with real entries counts for nothing; only the real
 *      entries count. In a denylist it subtracts nothing.
 *   7. A stored `"*"` (the deploy gate does not accept it as a wildcard;
 *      an older definition could still carry one): in an allowlist it means
 *      every tool, the same as an absent list; in a denylist it denies
 *      everything, the same as `["@none"]`.
 *
 * The same rules as a table (the contract suite in `tool-gates.test.ts` runs
 * every row against both shapes):
 *
 * | allowlist          | denylist      | tools kept on server S                         |
 * | ------------------ | ------------- | ---------------------------------------------- |
 * | absent or `[]`     | absent or `[]`| every tool (no filter)                         |
 * | `["S.a"]`          |               | `a`                                            |
 * | `["S.*"]`          |               | every tool                                     |
 * | `["a"]` (bare)     |               | `a`, on every server                           |
 * | `["T.a"]`          |               | nothing (the list never names S)               |
 * |                    | `["S.a"]`     | every tool but `a`                             |
 * |                    | `["a"]`       | every tool but `a`, on every server            |
 * |                    | `["S.*"]`     | nothing                                        |
 * | `["S.*"]`          | `["S.a"]`     | every tool but `a` (deny wins)                 |
 * | `["@none"]`        | any           | nothing                                        |
 * | `["*"]`            |               | every tool                                     |
 * |                    | `["*"]`       | nothing                                        |
 * | `["mcp__S__a"]`    |               | nothing (malformed entry dropped)              |
 * | any                | `["mcp__S__a"]`| as if the entry were absent                   |
 *
 * This turn's withholds then subtract from whatever the table keeps.
 *
 * Built-ins: only the Claude host has built-in tools (its file tools and
 * `Bash`, bound with GuueyFS). The predicate frameworks carry none, so a bare
 * built-in name there gates only an MCP tool of that name.
 */
import {
  NO_TOOLS_ENTRY,
  declaresNoTools,
  parseToolGateEntry,
  type GuueyAgentToolGates,
} from './agent.js';

/** The snapshot's gate block (`agent.tools`), absent when the agent declares none. */
export type ToolGates = GuueyAgentToolGates | undefined;

/**
 * One tool the Router withholds this turn: an MCP server by its key (the
 * credential file's name) and a tool on it. Structurally the same as
 * `@guuey/worker`'s `WithheldTool`; restated here so this package stays
 * free of that dependency.
 */
export interface ToolGateWithhold {
  readonly server: string;
  readonly tool: string;
}

/** The tool names withheld on `server` this turn. */
function withheldOn(server: string, withheld: readonly ToolGateWithhold[] | undefined): string[] {
  if (withheld === undefined) return [];
  return [...new Set(withheld.filter((w) => w.server === server).map((w) => w.tool))];
}

/** Is `entry` a real gate entry (not the "no tools" sentinel)? */
function isRealEntry(entry: string): boolean {
  return entry.trim() !== NO_TOOLS_ENTRY;
}

/** A stored `"*"` entry: not grammar (the parser would read a tool named `*`), read by rule 7. */
const EVERYTHING_ENTRY = '*';

function isEverything(entry: string): boolean {
  return entry.trim() === EVERYTHING_ENTRY;
}

/**
 * Does this gate block keep no MCP tool at all? `["@none"]`, or a denylist
 * carrying a stored `"*"` (rule 7).
 */
function keepsNoTools(gates: ToolGates): boolean {
  return declaresNoTools(gates) || (gates?.denylist ?? []).some(isEverything);
}

/**
 * The allowlist's real entries, or `[]` when it allows every tool: absent,
 * empty, or carrying a stored `"*"` (rule 7).
 */
function narrowingAllowEntries(gates: ToolGates): string[] {
  const entries = (gates?.allowlist ?? []).filter(isRealEntry);
  return entries.some(isEverything) ? [] : entries;
}

/** One gate list read for one server: whether it names the server whole, and the tool names it names there. */
function namesOn(server: string, entries: readonly string[]): { whole: boolean; tools: Set<string> } {
  let whole = false;
  const tools = new Set<string>();
  for (const raw of entries) {
    if (!isRealEntry(raw)) continue;
    const parsed = parseToolGateEntry(raw);
    if ('error' in parsed) continue;
    if (parsed.kind === 'bare') tools.add(parsed.tool);
    else if (parsed.server !== server) continue;
    else if (parsed.kind === 'server-all') whole = true;
    else tools.add(parsed.tool);
  }
  return { whole, tools };
}

/**
 * The predicate that keeps a tool on `server` this turn, or `undefined` when
 * nothing is filtered there (no allowlist narrowing, nothing denied or
 * withheld): the framework then builds the server exactly as it would with no
 * gates.
 */
export function toolGatePredicate(
  gates: ToolGates,
  server: string,
  withheld?: readonly ToolGateWithhold[],
): ((tool: string) => boolean) | undefined {
  if (keepsNoTools(gates)) return () => false;
  const allowEntries = narrowingAllowEntries(gates);
  const allow = allowEntries.length > 0 ? namesOn(server, allowEntries) : undefined;
  const deny = namesOn(server, gates?.denylist ?? []);
  const blocked = new Set([...deny.tools, ...withheldOn(server, withheld)]);
  const narrowed = allow !== undefined && !allow.whole;
  if (!narrowed && !deny.whole && blocked.size === 0) return undefined;
  return (tool) => {
    if (deny.whole || blocked.has(tool)) return false;
    return !narrowed || (allow !== undefined && allow.tools.has(tool));
  };
}

// ── Claude Agent SDK rules ──────────────────────────────────────────────────

/** A permission verdict, structurally the Claude Agent SDK's `PermissionResult` (allow or deny arm). */
export type ToolPermissionVerdict<I> =
  | { behavior: 'allow'; updatedInput: I }
  | { behavior: 'deny'; message: string };

/**
 * A call-time permission check over a tool name and its input. Structurally
 * assignable to the Claude Agent SDK's `CanUseTool`; this package never
 * imports that SDK.
 */
export type ToolPermissionCheck = <I>(toolName: string, input: I) => Promise<ToolPermissionVerdict<I>>;

/** Allows every tool, passing its input through. */
export const allowEveryTool: ToolPermissionCheck = (_toolName, input) =>
  Promise.resolve({ behavior: 'allow', updatedInput: input });

/**
 * Denies every tool not in `allowedSet`, with a message the model can read.
 * Under an explicit allowlist the listed tools are SDK allow rules and never
 * reach a callback, so what arrives here is unlisted by construction;
 * `allowedSet` is consulted anyway in case an SDK routes a listed name here.
 * Never an ask: a headless worker has no one to answer one.
 */
export function denyUnlistedTools(allowedSet: ReadonlySet<string>): ToolPermissionCheck {
  return (toolName, input) =>
    Promise.resolve(
      allowedSet.has(toolName)
        ? { behavior: 'allow', updatedInput: input }
        : {
            behavior: 'deny',
            message: `Tool "${toolName}" is not in this agent's tools.allowlist. Allowed: ${[...allowedSet].join(', ') || '(none)'}.`,
          },
    );
}

/** Options for {@link claudeToolRules}. */
export interface ClaudeToolRulesOptions {
  /**
   * The built-in tools this turn exposes (the Claude host's file tools and
   * `Bash` when GuueyFS is bound); `[]` when there are none, as in a
   * code-mode scaffold that runs with `tools: []`. They join the allow rules,
   * and a bare gate entry naming one also names that built-in.
   */
  builtins: readonly string[];
  /** This turn's withholds (`Invoke.withheldTools`). */
  withheld?: readonly ToolGateWithhold[];
}

/** The Claude Agent SDK's tool rules for one turn. */
export interface ClaudeToolRules {
  /** SDK allow rules: MCP names in `mcp__<server>[__<tool>]` spelling, plus the built-ins. */
  allowedTools: string[];
  /** SDK `disallowedTools`: removed from the model's catalog outright. */
  disallowedTools: string[];
  /** Whether the snapshot carried a non-empty allowlist, `["@none"]` included (→ the deny-unlisted posture). */
  explicitAllowlist: boolean;
  /** `allowedTools` as a set. */
  allowedSet: ReadonlySet<string>;
  /** The ask-stage check: deny-unlisted under an explicit allowlist, else allow every tool. */
  canUseTool: ToolPermissionCheck;
}

/**
 * Translate one gate entry into the SDK's tool-name spelling(s). A bare name
 * fans out to every declared server (a server's tools are not known before it
 * connects) and, when it names one of this turn's built-ins, to that built-in.
 * A malformed entry yields nothing: an unknown allow rule is inert, and an
 * unknown name reaching the ask stage is a headless hang.
 */
function toSdkToolNames(raw: string, servers: readonly string[], builtins: readonly string[]): string[] {
  const parsed = parseToolGateEntry(raw);
  if ('error' in parsed) return [];
  switch (parsed.kind) {
    case 'server-tool':
      return [`mcp__${parsed.server}__${parsed.tool}`];
    case 'server-all':
      return [`mcp__${parsed.server}`];
    case 'bare':
      return [
        ...servers.map((s) => `mcp__${s}__${parsed.tool}`),
        ...(builtins.includes(parsed.tool) ? [parsed.tool] : []),
      ];
  }
}

function dedupe(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * The Claude Agent SDK rules for one turn, over the servers attached this turn.
 *
 * - `allowedTools`: an explicit allowlist translated into SDK names; absent or
 *   `[]` → every tool of every server (`mcp__<server>`). The built-ins always
 *   join, so a builder's MCP-only allowlist never switches them off; only the
 *   denylist removes them.
 * - `disallowedTools`: the translated denylist, plus this turn's withholds.
 *   An allow rule only pre-approves, so subtraction rides here.
 * - `["@none"]` (and a stored denylist `"*"`): no MCP allow rule, the
 *   deny-unlisted posture, and `mcp__<server>` disallowed for every server,
 *   so it holds even where no `canUseTool` is installed. The built-ins stay;
 *   only a denylist entry naming one removes it.
 */
export function claudeToolRules(
  gates: ToolGates,
  servers: readonly string[],
  opts: ClaudeToolRulesOptions,
): ClaudeToolRules {
  const { builtins, withheld } = opts;
  const noTools = keepsNoTools(gates);
  const explicit = narrowingAllowEntries(gates);
  const explicitAllowlist = noTools || explicit.length > 0;
  const mcpAllowed = noTools
    ? []
    : explicitAllowlist
      ? explicit.flatMap((e) => toSdkToolNames(e, servers, builtins))
      : servers.map((s) => `mcp__${s}`);
  const allowedTools = dedupe([...mcpAllowed, ...builtins]);
  const disallowedTools = dedupe([
    ...(noTools ? servers.map((s) => `mcp__${s}`) : []),
    ...(gates?.denylist ?? [])
      .filter((e) => isRealEntry(e) && !isEverything(e))
      .flatMap((e) => toSdkToolNames(e, servers, builtins)),
    ...servers.flatMap((server) => withheldOn(server, withheld).map((tool) => `mcp__${server}__${tool}`)),
  ]);
  const allowedSet = new Set(allowedTools);
  return {
    allowedTools,
    disallowedTools,
    explicitAllowlist,
    allowedSet,
    canUseTool: explicitAllowlist ? denyUnlistedTools(allowedSet) : allowEveryTool,
  };
}
