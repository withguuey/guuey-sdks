/**
 * `GuueyContext` — everything the platform resolved for one turn, handed to a
 * graceful-mode agent factory. THE import channel for graceful devs:
 *
 * ```ts
 * import type { GuueyContext } from "@guuey/config";
 * export default (guuey: GuueyContext) => new LlmAgent({
 *   model: guuey.model,
 *   // Function form — safe for every framework; required for ADK, which
 *   // applies `{var}` substitution to a plain-string instruction.
 *   instruction: () => guuey.instruction,
 *   tools: [myTool, ...guuey.mcpToolsets],
 * });
 * ```
 *
 * Types-only and dependency-free by design (`@guuey/config` is already a
 * template dependency; the host — which ASSEMBLES the context — is not). The
 * tiny shapes below are structurally identical to `@guuey/worker`'s protocol
 * types; duplicating them here keeps config free of a runtime package
 * dependency for what is purely a type channel.
 *
 * The factory runs PER INVOKE (matching the per-invoke agent construction the
 * platform host has always done), so per-turn surfaces — the user, this
 * turn's state — are first-class, not bolted on.
 */

/** Router-vouched end-user identity for this turn (multi-tenant). */
export interface GuueyContextUser {
  id: string;
  authMode: "anonymous" | "authenticated";
}

/**
 * The three GuueyFS layer mounts (absolute paths):
 *  - `app` — read-only app assets,
 *  - `home` — per-USER durable storage,
 *  - `session` — per-session scratch.
 */
export interface GuueyContextFiles {
  app: string;
  home: string;
  session: string;
}

/** One prior message from the recent history window. */
export interface GuueyContextMessage {
  role: "user" | "agent";
  text: string;
}

/** One thread-memory record folded from prior turns. */
export interface GuueyContextMemoryRecord {
  key?: string;
  value: unknown;
}

/**
 * The full per-turn platform context. `TToolset` is the framework's MCP
 * toolset type (e.g. `MCPToolset` from `@google/adk`) — defaults to `unknown`
 * so the type stays framework-neutral.
 *
 * History, memory, and working state are ALSO auto-injected: the platform
 * leads each turn's user message with a `<turn_context>` block that carries
 * them, so a factory that ignores them still yields a conversational agent.
 * They appear here read-only for a factory that wants them in its own logic.
 * `instruction` carries none of them: it is the same for every turn of one
 * class of caller, so the model provider can cache it.
 */
export interface GuueyContext<TToolset = unknown> {
  /** Resolved model id (from guuey.json / registry default). */
  model: string;
  /**
   * The assembled system prompt: your prompt plus the platform's standing
   * sections. It holds no per-turn data (history, thread memory and working
   * state lead the turn's user message instead), so feed it to the agent
   * as-is.
   */
  instruction: string;
  /** Ready-to-use MCP toolsets for every server declared in guuey.json. */
  mcpToolsets: TToolset[];
  /** The end user this turn serves. */
  user: GuueyContextUser;
  /** The three-tier file storage paths. */
  files: GuueyContextFiles;
  /** Recent conversation window (read side; also in the turn's `<turn_context>`). */
  history: GuueyContextMessage[];
  /** Thread memory records (read side; also in the turn's `<turn_context>`). */
  memory: GuueyContextMemoryRecord[];
  /** Prior working state carried from the previous turn (read side). */
  workingState: unknown | undefined;
}

/**
 * What a graceful agent module's default export may be: the framework-native
 * agent object itself, or a factory receiving the {@link GuueyContext}.
 * Factories may be async.
 */
export type GuueyAgentExport<TAgent = object, TToolset = unknown> =
  | TAgent
  | ((guuey: GuueyContext<TToolset>) => TAgent | Promise<TAgent>);
