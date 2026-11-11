/**
 * The OpenAI (`@openai/agents`) arm of the universal host loop. Mirrors
 * `run.ts`'s `runInvoke` shape: one invoke → an `@openai/agents` `Agent` built
 * from the snapshot, run streamed, each raw `RunStreamEvent` emitted to fd-3 as
 * a `native('openai-agents-sdk', …)` WorkerEvent (the Router dispatches them to
 * the `@silverprotocol/openai-agents` normalizer). On clean completion it emits
 * `done`; on `MaxTurnsExceededError` it emits the `__host_error__` sentinel the
 * normalizer maps to `turn.error` (code `max_turns`), THEN `done(..,"max_turns")`;
 * on any other failure it emits `error`. Never throws — every failure path is a
 * terminal event so the Router always sees one. Emits `hello` FIRST (§8 item B)
 * — the SDK-version handshake.
 *
 * `run` (the `@openai/agents` runner) is injected so the loop is unit-testable
 * without a live model — the entrypoint (`index.ts`) passes the real SDK `run`.
 *
 * Snapshot → Agent mapping:
 *  - `model`        → `snapshot.model`, or (when absent) guuey's own
 *                     `defaultModelFor("openai-agents-sdk")` — NOT the
 *                     `@openai/agents` SDK's own built-in fallback. Mirrors
 *                     `claude-options.ts`'s `DEFAULT_MODEL` idiom.
 *  - `instructions` → `buildSystemPrompt` over the turn's class (A1: the
 *                     same assembler as the Claude path); the turn's context
 *                     blocks lead the run input (`withTurnContext`).
 *  - `mcpServers`   → the framework-neutral `resolveMcpServers` output (same
 *                     federation/env-substitution as Claude), each `http`/`sse`
 *                     entry → an `MCPServerStreamableHttp` carrying its
 *                     `Authorization` (and any other) header via `requestInit`.
 *  - `maxTurns`     → `snapshot.runtime?.maxTurns` (passed to `run(...)`; the SDK
 *                     THROWS `MaxTurnsExceededError` from `stream.completed`).
 *  - API key        → `OPENAI_API_KEY` (the Router sets it at pod boot), applied
 *                     globally via `setDefaultOpenAIKey` by the entrypoint.
 */
import {
  Agent,
  MaxTurnsExceededError,
  MCPServerStreamableHttp,
  type MCPServer,
  type MCPToolFilterCallable,
  type AgentInputItem,
  type RunStreamEvent,
} from "@openai/agents";
import { MODEL_TEXT_INPUT_KIND_CAPABILITIES, invokeImagesCapabilities, mcpToolCustomData, openaiTurnInput, storeTurnImages } from "@guuey/worker";
import { modelToolFilterFor, reportToolGateErrors, type ToolGates } from "../mcp-tool-gates.js";
import type { Emitter, JsonValue } from "@guuey/worker";
import {
  resolveMcpServers,
  type BuildOptionsContext,
  type SdkMcpServer,
} from "./claude-options.js";
import { buildSystemPrompt, buildTurnContextBlocks, promptClassOf } from "../preamble.js";
import type { HostInvoke, HostRuntime } from "./claude.js";
import { GUUEY_DEFAULT_SYSTEM_PROMPT, declaresNoTools, defaultModelFor, type GuueyAgent } from "@guuey/config";
import { resolveSdkVersion } from "../sdk-version.js";

/** The framework tag this arm runs — matches the `AgentFramework` enum value. */
const OPENAI_FRAMEWORK = "openai-agents-sdk";
/** The npm package whose installed version is this framework's `hello.sdkVersion`. */
const OPENAI_SDK_PACKAGE = "@openai/agents";

/**
 * Default OpenAI model — only used when the snapshot omits `model`. Derived
 * from the `@guuey/config` registry (single source of truth per the
 * model-release playbook §8 item A) rather than a bare literal, so a registry
 * default change propagates here automatically — the same idiom
 * `claude-options.ts`'s `DEFAULT_MODEL` / `google-adk.ts`'s `DEFAULT_MODEL`
 * use. Before this constant existed, a model-less snapshot silently fell
 * through to `@openai/agents`' OWN built-in default (verified
 * `gpt-5.4-mini`) — not a registry id, so it escaped the rate-card
 * exact-match guard and shadow-resolved through the `gpt-5.4` row,
 * over-metering a mini model (playbook run 2026-07-25, finding M7).
 */
const DEFAULT_MODEL = defaultModelFor(OPENAI_FRAMEWORK);

/**
 * The streamed-result surface the loop CONSUMES — exactly the three members it
 * reads off the `@openai/agents` `StreamedRunResult`: async iteration over raw
 * events, `completed` (which THROWS `MaxTurnsExceededError`), and the resolved
 * `finalOutput`. A minimal structural interface (NOT the full `StreamedRunResult`
 * class) so the real runner result AND a test fake both satisfy it without a cast
 * — `StreamedRunResult` has private fields, so a plain object could never match
 * the class, but it DOES match this read-only projection.
 */
export interface OpenaiRunResult extends AsyncIterable<RunStreamEvent> {
  readonly completed: Promise<void>;
  /** Resolved text output for the default text-output Agent (or `undefined`). */
  readonly finalOutput?: string | undefined;
}

/**
 * The `run` surface the loop needs — the real `@openai/agents` `run` (streamed
 * overload) satisfies it (its `StreamedRunResult` is assignable to
 * {@link OpenaiRunResult}). Injected so the loop is testable without a live model.
 */
export type OpenaiRunFn = (
  agent: Agent,
  input: string | AgentInputItem[],
  options: { stream: true; maxTurns?: number },
) => Promise<OpenaiRunResult>;

/**
 * The `__host_error__` sentinel the host feeds the OpenAI normalizer for a
 * terminal failure the SDK surfaces as a thrown error (not a native event) —
 * canonically `max_turns` (`MaxTurnsExceededError` from `await stream.completed`).
 * Shape is BINDING (plan §"Spike Findings"): the normalizer maps it to
 * `closeTurnError(turnId, { message, code, usage })`. A plain typed literal — it
 * crosses the wire as the `native` event's `event` payload (a `JsonValue`).
 */
type HostErrorSentinel = {
  type: "__host_error__";
  code: "max_turns";
  message: string;
};

/**
 * Run one invoke through `@openai/agents`. Emits `native` per `RunStreamEvent`,
 * `done` on completion (with the `max_turns` sentinel + reason on a turn-cap),
 * `error` on a build failure or any non-max-turns throw. Never throws.
 */
export async function runInvokeOpenai(
  snapshot: GuueyAgent & { framework?: string },
  invoke: HostInvoke,
  runtime: HostRuntime,
  emit: Emitter,
  run: OpenaiRunFn,
): Promise<void> {
  // The SDK-version handshake (§8 item B, additive-optional) — ALWAYS the
  // first event of this invoke's fd-3 stream, before any native/turn event.
  // `sdkVersion` is resolved at runtime, never hardcoded; `null` (SDK not
  // resolvable) is tolerated by the Router.
  // guuey#2293: an invoke carrying images announces that this run path hands them to the model.
  emit.hello(OPENAI_FRAMEWORK, OPENAI_SDK_PACKAGE, resolveSdkVersion(OPENAI_SDK_PACKAGE), [
    ...MODEL_TEXT_INPUT_KIND_CAPABILITIES,
    ...invokeImagesCapabilities(invoke),
  ]);
  // guuey#2293: the turn's images are also stored in its session storage
  // (@guuey/worker storeTurnImages); a refusal is the person's face, and the
  // turn does not run.
  const imagesFace = storeTurnImages(invoke);
  if (imagesFace !== undefined) {
    emit.error(imagesFace);
    return;
  }

  // The host runs inside the Router's bubblewrap jail with NO IRSA; a federated
  // MCP server reads its Router-written credential file. `resolveMcpServers`
  // needs the same per-invoke context the Claude path builds.
  const ctx: BuildOptionsContext = {
    input: invoke.input,
    identity: invoke.identity,
    fs: invoke.fs,
    listCredentials: runtime.listCredentials,
    ...(runtime.apiKey !== undefined ? { apiKey: runtime.apiKey } : {}),
    // The Router's per-turn tool withholds → the named servers' `toolFilter` (with the snapshot's tool gates).
    ...(invoke.withheldTools !== undefined ? { withheldTools: invoke.withheldTools } : {}),
  };

  // Build the Agent (+ connect its MCP servers). A build failure (e.g. an
  // unresolved {file} system prompt, or an unsupported MCP arm) is a terminal
  // `error` — never a throw out of this function.
  let instructions: string;
  let turnContext: string[];
  let mcpServers: MCPServerStreamableHttp[];
  try {
    // Snapshots reach the worker fully resolved — the CLI inlines any `{file}`
    // system prompt before upload. A non-string reaching the worker means a
    // direct API hit with an un-resolved snapshot; reject loudly (same as Claude).
    if (snapshot.systemPrompt !== undefined && typeof snapshot.systemPrompt !== "string") {
      throw new Error(
        `@guuey/host: snapshot.systemPrompt must be a resolved string (got ${JSON.stringify(
          snapshot.systemPrompt,
        )}). The CLI inlines {file} references before upload; workers never read the filesystem.`,
      );
    }
    // A1: `instructions` is a function of the turn's CLASS only, from the one
    // assembler every runner shares; what varies per turn leads the run input.
    // `tools.allowlist: ["@none"]` (guuey#2262) makes a no-tools class.
    const cls = promptClassOf(invoke, { noTools: declaresNoTools(snapshot.tools), surfaceHints: snapshot.surfaceHints });
    instructions = buildSystemPrompt(snapshot.systemPrompt ?? GUUEY_DEFAULT_SYSTEM_PROMPT, cls);
    turnContext = buildTurnContextBlocks(invoke, cls);
    mcpServers = buildOpenaiMcpServers(ctx, snapshot.tools);
    reportToolGateErrors(snapshot.tools);
  } catch (err) {
    emit.error(err instanceof Error ? err.message : String(err));
    return;
  }

  try {
    for (const server of mcpServers) {
      await server.connect();
    }
  } catch (err) {
    await closeAll(mcpServers);
    emit.error(err instanceof Error ? err.message : String(err));
    return;
  }

  try {
    const maxTurns = snapshot.runtime?.maxTurns;
    // `MCPServerStreamableHttp` IS an `MCPServer`; the Agent's `mcpServers` field
    // is `MCPServer[]` — widen via the interface (no cast; structural subtype).
    const servers: MCPServer[] = mcpServers;
    const agent = new Agent({
      name: "guuey-agent",
      instructions,
      mcpServers: servers,
      model: snapshot.model ?? DEFAULT_MODEL,
    });

    const stream = await run(agent, withTurnContext(turnContext, openaiTurnInput(invoke)), {
      stream: true,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    });

    // Drive the stream: each raw event crosses the wire as native.
    for await (const ev of stream) {
      emit.native(OPENAI_FRAMEWORK, toJson(ev));
    }

    // The runner THROWS `MaxTurnsExceededError` from `completed` AFTER the stream
    // ends. Catch it specifically → feed the normalizer the `__host_error__`
    // sentinel, then a terminal `done(.., "max_turns")`. Other throws → `error`.
    try {
      await stream.completed;
    } catch (err) {
      if (err instanceof MaxTurnsExceededError) {
        // The `__host_error__` sentinel — a fresh object literal so it is checked
        // directly against `JsonValue` (the `native` payload type). Shape is the
        // BINDING contract {@link HostErrorSentinel}.
        emit.native(OPENAI_FRAMEWORK, {
          type: "__host_error__",
          code: "max_turns",
          message: err.message,
        } satisfies HostErrorSentinel);
        emit.done(finalText(stream), "max_turns");
        return;
      }
      throw err;
    }

    emit.done(finalText(stream), "end_turn");
  } catch (err) {
    emit.error(err instanceof Error ? err.message : String(err));
  } finally {
    await closeAll(mcpServers);
  }
}

/**
 * The run input with the turn's context blocks first (A1). A string input (no
 * images) becomes the blocks and the text joined by blank lines; the one-user-
 * message input (images) gets each block as its own leading `input_text` part,
 * ahead of the images and the text.
 */
export function withTurnContext(
  blocks: readonly string[],
  input: ReturnType<typeof openaiTurnInput>,
): ReturnType<typeof openaiTurnInput> {
  if (typeof input === "string") return [...blocks, input].join("\n\n");
  return input.map((message, index) =>
    index === 0
      ? { ...message, content: [...blocks.map((text) => ({ type: "input_text" as const, text })), ...message.content] }
      : message,
  );
}

/**
 * The agent's final text output, or `""` when absent (a tool-only turn, or a
 * turn cut short by `max_turns`). For the default text-output Agent `finalOutput`
 * is `string | undefined`.
 */
function finalText(stream: OpenaiRunResult): string {
  const out = stream.finalOutput;
  return typeof out === "string" ? out : "";
}

/**
 * Translate the framework-neutral resolved MCP map → connected-capable
 * `MCPServerStreamableHttp` instances. Each `http`/`sse` entry's `headers`
 * (typically `{ authorization: 'Bearer <token>' }`, from the federation
 * credential file or `${env.NAME}` substitution) ride on the underlying MCP
 * transport's `RequestInit.headers` via `requestInit`.
 *
 * The broker's entries only carry `http`/`sse` servers (the Router resolves all
 * transport to one of those two); the `stdio` arm below is unreachable
 * defensive code — kept so a future schema change can't silently drop a server.
 */
function buildOpenaiMcpServers(ctx: BuildOptionsContext, gates: ToolGates): MCPServerStreamableHttp[] {
  const resolved = resolveMcpServers(ctx);
  const servers: MCPServerStreamableHttp[] = [];
  for (const [name, entry] of Object.entries(resolved)) {
    servers.push(toOpenaiMcpServer(name, entry, modelToolFilterFor(name, gates, ctx.withheldTools)));
  }
  return servers;
}

/**
 * One resolved `SdkMcpServer` → an `MCPServerStreamableHttp`. Both `http` and
 * `sse` arms map to the StreamableHTTP server (the SDK's HTTP MCP transport);
 * the `stdio` arm is unreachable (`resolveMcpServers` rejects colocated before
 * we get here) — handled with a loud throw so a future schema change can't
 * silently drop a server.
 */
function toOpenaiMcpServer(name: string, entry: SdkMcpServer, keep: (name: string, listed: object) => boolean): MCPServerStreamableHttp {
  if (entry.type === "stdio") {
    throw new Error(
      `mcpServers["${name}"]: stdio (colocated) MCP is not supported on the OpenAI host path.`,
    );
  }
  const headers = entry.headers;
  return new MCPServerStreamableHttp({
    url: entry.url,
    name,
    ...(headers && Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
    // `customDataExtractor` (agents 0.12+) is the ONLY channel that carries an
    // MCP tool result's `structuredContent` AND `_meta` onto the wire
    // (`item.customData`) WITHOUT leaking them into model-visible text — the
    // ggui render-cache marker and the card's MCP-Apps `ui://` locator both
    // ride here. guuey#981: ONE shared extractor for every OpenAI worker — the
    // code-mode template's `worker.ts` passes the same `@guuey/worker` export.
    customDataExtractor: mcpToolCustomData,
    // The SDK calls the filter as it lists the server's tools for the model: a
    // tool the model may call (MCP Apps visibility, read off the listed tool),
    // then what the builder's tool gates and this turn's withholds admit
    // (`mcp-tool-gates.ts`). Every server gets it. A callable, because a static
    // filter can neither read `_meta` nor say "keep none".
    toolFilter: toolFilterOf(keep),
  });
}

/** The model-facing filter as the SDK's callable (the SDK awaits it per listed tool, `_meta` included). */
function toolFilterOf(keep: (name: string, listed: object) => boolean): MCPToolFilterCallable {
  return async (_context, tool) => keep(tool.name, tool);
}

/** Best-effort close of every connected MCP server (release the transport). */
async function closeAll(servers: MCPServerStreamableHttp[]): Promise<void> {
  await Promise.allSettled(servers.map((s) => s.close()));
}

/**
 * Coerce one `RunStreamEvent` to the `JsonValue` the `native` event carries.
 * Stream events are plain JSON-serializable objects; the round-trip drops any
 * non-JSON surface and yields the exact shape the Router's normalizer parses off
 * the wire. Mirrors `run.ts`'s `toJson`.
 */
function toJson(ev: RunStreamEvent): JsonValue {
  return JSON.parse(JSON.stringify(ev)) as JsonValue;
}
