/**
 * The invoke body, shape 2: ONE silverprotocol `AgInput` (request-shape design v6; the runtime's parse contract
 * c8c5a184, §1-§3). Built here as a pure function so the shape has a name, a test and a corpus (W6).
 *
 * The hook writes this body only after the runtime advertised `accepts.requestShape >= 2` on a previous `session` frame
 * in the same hook instance; otherwise it writes shape 1 ({@link buildInvokeBody}), which stays permanent for first
 * contact (W7). Every guuey-only field rides as `metadata["guuey/<key>"]`; the protocol's own members carry the rest.
 *
 * The rules the runtime holds this body to, mirrored so a valid turn is never refused for its shape:
 *  - exactly ONE message, role `user`, whose id is the turn id (the client message id, the idempotency key);
 *  - `threadId: ""` on first contact: the runtime reads it as absent and mints a thread, as it does for an unknown id;
 *  - one `text` block, or none beside `guuey/inputKind` (a turn without words);
 *  - turn context as `run.context` text blocks; never the page context, which stays `guuey/pageContext` (untrusted).
 */
import { AGJSON_VERSION, type AgBlock, type AgClientCapabilities, type AgInput, type JsonValue } from "@silverprotocol/core";
import type { TapLabels } from "@guuey/mcp-apps-host/narrowing";
import type { PageContext } from "./types.js";
import type { InputKind } from "./input-kinds.js";
import type { UserPart } from "./user-parts.js";
import { AgentResponseError } from "./errors.js";
import { AGENT_ERROR_CODES } from "./error-codes.js";

/** A turn-context block: text only in v1 (the runtime refuses any other kind). */
export type TurnContextBlock = Extract<AgBlock, { type: "text" }>;

export interface InvokeBodyV2Input {
  /** The user's words for this turn; `""` only beside {@link inputKind}. */
  text: string;
  /** The durable conversation id once the runtime minted one; absent on first contact. */
  threadId?: string | null;
  /** Idempotency key for this turn's user message: the message id AND the turn id. */
  clientMessageId: string;
  /** The turn's judged parts (`validateUserParts`). */
  parts?: readonly UserPart[];
  /** This message's context (design v5.3 turn context). */
  turnContext?: readonly TurnContextBlock[];
  capabilities?: AgClientCapabilities;
  pageContext?: PageContext;
  mode?: string;
  tapLabels?: TapLabels;
  inputKind?: InputKind;
}

/** The start arm of `AgInput`: what this builder returns. */
export type InvokeBodyV2 = Extract<AgInput, { kind: "start" }>;

/** The page context as a JSON object: only the members that are set, so the metadata is exactly what the client knows. */
function pageContextValue(pc: PageContext): { [key: string]: JsonValue } {
  return {
    ...(pc.path !== undefined ? { path: pc.path } : {}),
    ...(pc.title !== undefined ? { title: pc.title } : {}),
    ...(pc.context !== undefined ? { context: pc.context } : {}),
    ...(pc.hostOrigin !== undefined ? { hostOrigin: pc.hostOrigin } : {}),
  };
}

export function buildInvokeBodyV2(i: InvokeBodyV2Input): InvokeBodyV2 {
  const content: AgBlock[] = [
    ...(i.text !== "" ? [{ type: "text" as const, text: i.text }] : []),
    ...(i.parts ?? []),
  ];
  const metadata: { [key: string]: JsonValue } = {
    ...(i.pageContext !== undefined ? { "guuey/pageContext": pageContextValue(i.pageContext) } : {}),
    ...(i.mode !== undefined ? { "guuey/mode": i.mode } : {}),
    ...(i.tapLabels !== undefined ? { "guuey/tapLabels": [...i.tapLabels] } : {}),
    // A turn without words, as shape 1's rule: the kind rides only beside empty text.
    ...(i.inputKind !== undefined && i.text === "" ? { "guuey/inputKind": i.inputKind } : {}),
  };
  return {
    protocol: "agjson",
    version: AGJSON_VERSION,
    threadId: i.threadId ? i.threadId : "",
    turnId: i.clientMessageId,
    ...(i.capabilities !== undefined ? { capabilities: i.capabilities } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    kind: "start",
    messages: [{ id: i.clientMessageId, role: "user", content }],
    ...(i.turnContext !== undefined && i.turnContext.length > 0 ? { run: { context: [...i.turnContext] } } : {}),
  };
}

/** The released `guuey dev` server's refusal of a body without an `input` string, word for word. */
const DEV_SERVER_SHAPE_REFUSAL = "body.input must be a string";

/**
 * Whether a pre-stream refusal is an older server failing to parse a shape-2 body (W1). Two faces, each read exactly:
 *  - the agent runtime before shape 2 reads the body as shape 1, finds no `input` string, and answers a 400
 *    `{ code: "INVALID_REQUEST", message }` whose message names the `input` field ("input: non-empty string
 *    required"). Other refusals share the code, so the message's field is the discriminator;
 *  - every released `guuey dev` server answers a 400 `{ "error": "body.input must be a string" }`, with no code at all
 *    (`agentResponseErrorFrom` reads `error` as the message). Only that exact sentence and no code counts.
 * Any other 400 is an ordinary failure, never a reason to send again.
 */
export function isRequestShapeRefusal(err: unknown): err is AgentResponseError {
  if (!(err instanceof AgentResponseError) || err.status !== 400) return false;
  if (err.code === AGENT_ERROR_CODES.INVALID_REQUEST) return err.message.startsWith("input:");
  return err.code === undefined && err.message === DEV_SERVER_SHAPE_REFUSAL;
}
