/**
 * Google-ADK runner — drives the OFFICIAL `@google/adk` (JS) per invoke and
 * emits every native ADK `Event` to fd-3 for the Router's
 * `createAdkNormalizer`. Replaces the Python ADK host (`guuey_adk_host`)
 * behavior-for-behavior: same hello handshake, same context preamble, same
 * per-invoke `InMemoryRunner` semantics, same final-text extraction.
 *
 * Deliberate mechanics (each one adversarially reviewed):
 *
 *  - **Lazy SDK load + single-copy rule.** `@google/adk` is an optional peer,
 *    imported at runner creation — never at module top. In graceful mode
 *    (`GUUEY_AGENT_ENTRY`, T3) the SDK is resolved from the AGENT ENTRY's own
 *    tree via `createRequire(entryUrl)` so the dev's agent and this runner
 *    share ONE copy (the dev's version wins in their lane); no-code resolves
 *    from the host's own tree (the platform pin in
 *    `@guuey-private/host-shared`).
 *  - **`role: "user"` pinned on `newMessage`.** Omitting it 400s on tool
 *    follow-ups (upstream adk-js#475); the pin is a mechanistically complete
 *    mitigation for arbitrary-depth tool loops.
 *  - **MCP = Streamable-HTTP only.** The JS `MCPToolset` speaks stdio +
 *    Streamable-HTTP; a `transport: "sse"` credential is REJECTED with an
 *    actionable error (the Python-era SSE arm has no JS mapping). Auth
 *    headers ride `transportOptions.requestInit.headers` (the non-deprecated
 *    channel).
 *  - **Gemini arming is the documented env pair.** `@google/genai` reads
 *    `GOOGLE_GEMINI_BASE_URL` (verified: getBaseUrl in genai 1.52) and the
 *    ADK's GoogleLlm reads `GOOGLE_GENAI_API_KEY || GEMINI_API_KEY` — the
 *    Router's `buildWorkerEnv` gemini arm injects exactly `GEMINI_API_KEY` +
 *    `GOOGLE_GEMINI_BASE_URL`. ADK 1.3.0 exposes no programmatic
 *    httpOptions path, so env IS the sanctioned channel here.
 *
 * NEVER rejects to the loop — every failure becomes a terminal `error` event
 * (the wire contract the Python host also kept).
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { GuueyContext } from "@guuey/config";
import type { Emitter, JsonValue } from "@guuey/worker";
import type { FrameworkRunner, HostSnapshot, HostTurn } from "../index.js";
import {
  AGENT_ENTRY_ENV,
  WORKER_ROOT_ENV,
  loadAgentEntry,
  materializeAgent,
  nativeLoad,
  resolveAgentEntry,
} from "../agent-entry.js";
import { listCredentials, type CredentialFile } from "../creds.js";
import { withContextPreamble } from "../preamble.js";
import { resolveSdkVersion } from "../sdk-version.js";

const ADK_FRAMEWORK = "google-adk";
const ADK_PACKAGE = "@google/adk";
const DEFAULT_MODEL = "gemini-3.5-flash";

/**
 * The narrow structural slice of `@google/adk`'s module surface this runner
 * consumes. Structural (not `import type` from the peer's d.ts) so the module
 * type-checks even where the optional peer is absent — the same posture as
 * silverprotocol's facet-side `AdkEvent` contract.
 */
interface AdkModule {
  LlmAgent: new (params: {
    name: string;
    model: string;
    instruction: string;
    tools: unknown[];
  }) => AdkAgent;
  InMemoryRunner: new (params: { agent: AdkAgent }) => AdkRunner;
  MCPToolset: new (connectionParams: {
    type: "StreamableHTTPConnectionParams";
    url: string;
    transportOptions?: { requestInit?: { headers?: Record<string, string> } };
  }) => unknown;
}

/** Opaque agent handle — constructed here (no-code) or by the dev (graceful). */
export type AdkAgent = object;

interface AdkRunner {
  readonly appName: string;
  readonly sessionService: {
    createSession(request: { appName: string; userId: string }): Promise<{ id: string }>;
  };
  runAsync(params: {
    userId: string;
    sessionId: string;
    newMessage: { role: "user"; parts: Array<{ text: string }> };
  }): AsyncGenerator<JsonValue, void, undefined>;
}

/**
 * Load `@google/adk`, honoring the single-copy rule: when `entryPath` (the
 * graceful agent module) is given, resolve the SDK from THAT tree so the
 * runner drives the same copy the dev's agent was built with; otherwise
 * import from the host's own tree. A resolution failure surfaces as the
 * actionable missing-peer error.
 */
export async function loadAdk(entryPath?: string): Promise<AdkModule> {
  try {
    if (entryPath !== undefined) {
      const entryRequire = createRequire(pathToFileURL(entryPath).href);
      const resolved = entryRequire.resolve(ADK_PACKAGE);
      return nativeLoad(resolved) as AdkModule;
    }
    return (await import(ADK_PACKAGE)) as AdkModule;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(
        `@guuey/host: cannot load the "${ADK_FRAMEWORK}" runner — its runtime is an optional peer. ` +
          `Install ${ADK_PACKAGE} ${entryPath !== undefined ? `next to the agent entry (${entryPath})` : "next to @guuey/host"} ` +
          `to run this framework. (${String(err)})`,
      );
    }
    throw err;
  }
}

/**
 * Map the broker's credential files to ADK MCP toolsets. Throws on an `sse`
 * credential — the JS toolset has no SSE transport (unlike the Python-era
 * host); the error names the server and the supported path.
 */
export function buildToolsets(
  adk: Pick<AdkModule, "MCPToolset">,
  creds: Array<{ name: string; cred: CredentialFile }>,
): unknown[] {
  return creds.map(({ name, cred }) => {
    if (cred.transport === "sse") {
      throw new Error(
        `@guuey/host: MCP server "${name}" uses transport "sse", which @google/adk's MCPToolset does not support ` +
          `(Streamable-HTTP only). Point the server at a Streamable-HTTP endpoint or use a different framework for this agent.`,
      );
    }
    return new adk.MCPToolset({
      type: "StreamableHTTPConnectionParams",
      url: cred.url,
      transportOptions: { requestInit: { headers: cred.headers } },
    });
  });
}

/**
 * Extract a native event's last non-thought text part ("" when none).
 * Structural narrowing from `JsonValue` — the event stays untyped JSON on its
 * way to the normalizer; only this thin slice is inspected.
 */
export function finalTextOf(event: JsonValue): string {
  let finalText = "";
  if (typeof event !== "object" || event === null || Array.isArray(event)) return finalText;
  const content = (event as { content?: JsonValue }).content;
  if (typeof content !== "object" || content === null || Array.isArray(content)) return finalText;
  const parts = (content as { parts?: JsonValue }).parts;
  if (!Array.isArray(parts)) return finalText;
  for (const part of parts) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
    const { text, thought } = part as { text?: JsonValue; thought?: JsonValue };
    if (typeof text === "string" && text !== "" && thought !== true) finalText = text;
  }
  return finalText;
}

/**
 * One turn against a caller-supplied agent + module (the seam graceful mode
 * (T3) and the unit tests share). Emits hello → native* → done|error.
 */
export async function runAdkTurn(
  adk: Pick<AdkModule, "InMemoryRunner">,
  agent: AdkAgent,
  turn: HostTurn,
  emit: Emitter,
  sdkVersion: string | null,
): Promise<void> {
  emit.hello(ADK_FRAMEWORK, ADK_PACKAGE, sdkVersion);
  try {
    const runner = new adk.InMemoryRunner({ agent });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: turn.identity.userId,
    });
    let finalText = "";
    for await (const event of runner.runAsync({
      userId: turn.identity.userId,
      sessionId: session.id,
      // `role` pinned — see the module header (adk-js#475).
      newMessage: { role: "user", parts: [{ text: turn.input }] },
    })) {
      // The full native event passes to the normalizer untouched; JS events
      // are already the camelCase shapes the AdkEvent contract expects.
      emit.native(ADK_FRAMEWORK, event);
      finalText = finalTextOf(event) || finalText;
    }
    emit.done(finalText, "end_turn");
  } catch (err) {
    // never propagate to the wire
    emit.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

/**
 * Assemble the per-turn {@link GuueyContext} — the ONE discoverable object a
 * graceful factory receives (spec §2.2). `instruction` carries the standard
 * context preamble already prepended; the raw fields ride alongside for
 * factories that render context themselves.
 */
export function buildGuueyContext(
  snapshot: HostSnapshot,
  turn: HostTurn,
  instruction: string,
  mcpToolsets: unknown[],
): GuueyContext {
  return {
    model: snapshot.model ?? DEFAULT_MODEL,
    instruction,
    mcpToolsets,
    user: { id: turn.identity.userId, authMode: turn.identity.authMode },
    files: { app: turn.fs.app, home: turn.fs.home, session: turn.fs.session },
    history: turn.history.map((m) => ({ role: m.role, text: m.text })),
    memory: (turn.priorMemory ?? []).map((m) => (m.key !== undefined ? { key: m.key, value: m.value } : { value: m.value })),
    workingState: turn.priorState,
  };
}

export function createRunner(): FrameworkRunner {
  // Graceful mode: guuey.json#agent.entry → GUUEY_AGENT_ENTRY (relative),
  // resolved strictly under the worker root. Read once at runner creation —
  // the pod runs one agent module for its whole life.
  const entryRel = process.env[AGENT_ENTRY_ENV];
  const workerRoot = process.env[WORKER_ROOT_ENV];
  let boot: Promise<{ adk: AdkModule; exported: unknown; entryPath?: string }> | undefined;

  return {
    async runTurn(snapshot: HostSnapshot, turn: HostTurn, emit: Emitter): Promise<void> {
      boot ??= (async () => {
        if (entryRel !== undefined && entryRel !== "") {
          const entryPath = resolveAgentEntry(entryRel, workerRoot);
          // Single-copy rule: the SDK comes from the AGENT's own tree.
          const adk = await loadAdk(entryPath);
          const exported = await loadAgentEntry(entryPath);
          return { adk, exported, entryPath };
        }
        return { adk: await loadAdk(), exported: undefined };
      })();
      let adk: AdkModule;
      let exported: unknown;
      let entryPath: string | undefined;
      try {
        ({ adk, exported, entryPath } = await boot);
      } catch (err) {
        emit.hello(ADK_FRAMEWORK, ADK_PACKAGE, null);
        emit.error(err instanceof Error ? err.message : String(err));
        return;
      }
      const sdkVersion = resolveSdkVersion(ADK_PACKAGE, entryPath);
      // Snapshots reach the worker fully resolved — a `{file}` systemPrompt
      // here means an un-resolved snapshot hit the API directly; reject loudly
      // (same posture as the claude path).
      if (snapshot.systemPrompt !== undefined && typeof snapshot.systemPrompt !== "string") {
        emit.hello(ADK_FRAMEWORK, ADK_PACKAGE, sdkVersion);
        emit.error(
          `@guuey/host: snapshot.systemPrompt must be a resolved string (got ${JSON.stringify(snapshot.systemPrompt)}).`,
        );
        return;
      }
      const instruction = withContextPreamble(
        snapshot.systemPrompt ?? "",
        turn.history,
        turn.priorMemory,
        turn.priorState,
      );
      let agent: AdkAgent;
      try {
        const toolsets = buildToolsets(adk, listCredentials(turn.fs)());
        if (exported !== undefined) {
          // Graceful: the dev's export (plain agent or factory(GuueyContext)).
          const ctx = buildGuueyContext(snapshot, turn, instruction, toolsets);
          agent = await materializeAgent(exported, ctx, (message) => process.stderr.write(`${message}\n`));
        } else {
          // No-code: construct from the snapshot.
          agent = new adk.LlmAgent({
            name: "guuey",
            model: snapshot.model ?? DEFAULT_MODEL,
            instruction,
            tools: toolsets,
          });
        }
      } catch (err) {
        emit.hello(ADK_FRAMEWORK, ADK_PACKAGE, sdkVersion);
        emit.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        return;
      }
      await runAdkTurn(adk, agent, turn, emit, sdkVersion);
    },
  };
}
