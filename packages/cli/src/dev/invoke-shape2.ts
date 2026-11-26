/**
 * `guuey dev`'s parse of a shape-2 invoke body (silverprotocol's AgInput), to the Router's signed contract (router's R2
 * contract c8c5a184 + ADD-3 441a01c2): the same detection, the protocol's own check IMPORTED (never re-implemented),
 * and the same refusal prefixes, so a body `guuey dev` refuses is one the Router refuses with the same message.
 *
 * What it hands the local worker is what shape 1 gives it today, twin for twin: the turn's text and the session id. A
 * local turn has never delivered images, attachments, page context or turn context (dev-server.ts `readInvokeBody`
 * reads `input` and `sessionId` alone), so the non-text blocks and the run context of a shape-2 body are COUNTED and
 * named on stderr, never refused by kind. This package cannot import the Router's private parse, so the two are to
 * be pinned to ONE shared fixture corpus (`@guuey/agent-client`'s `src/fixtures/agjson-corpus`, OWED: it lands with
 * chat's R1). Once it lands, this package's corpus test FAILS when the corpus is missing; it never skips.
 */
import { checkAgInput } from "@silverprotocol/core";

/** The members only shape 1 has: one of them in a shape-2 body is ambiguous (the contract's §1.2 step 3). */
export const SHAPE1_ONLY_MEMBERS = [
  "inputKind",
  "attachments",
  "images",
  "sessionId",
  "mode",
  "inputOrigin",
  "tapLabels",
  "clientMessageId",
  "pageContext",
  "turnContext",
  "userMeta",
  "traceContext",
  "resume",
] as const;

/** The most HITL answers one resume carries (the Router's RESUME_ANSWERS_MAX). */
const RESUME_ANSWERS_MAX = 32;

/** What a shape-2 body gives the local turn, and how much of it the local turn does not deliver. */
export interface DevShape2Turn {
  input: string;
  sessionId: string | undefined;
  /** Content blocks other than text (images, parts, resources ...) and run-context blocks: never delivered locally. */
  notDelivered: number;
  /** A `resume` body: its answers are not delivered locally, and the turn text is empty. */
  resume: boolean;
}

/** A shape-2 refusal: the Router's face, `400 {code: "INVALID_REQUEST", message}`, with its contract prefix. */
export class DevShape2Refused extends Error {
  readonly code = "INVALID_REQUEST";
  constructor(message: string) {
    super(message);
    this.name = "DevShape2Refused";
  }
}

/** Which shape a parsed body is (the contract's §1.1, own members only). */
export function invokeShapeOf(body: object): "shape1" | "shape2" | "ambiguous" | "neither" {
  const protocol = Object.hasOwn(body, "protocol");
  const input = Object.hasOwn(body, "input");
  if (protocol && input) return "ambiguous";
  if (protocol) return "shape2";
  if (input) return "shape1";
  return "neither";
}

/** Parse a shape-2 body for a local turn. Throws {@link DevShape2Refused} with the Router's message. */
export function parseDevShape2(body: object): DevShape2Turn {
  const checked = checkAgInput(body);
  if (!checked.ok) throw new DevShape2Refused(`agjson: ${checked.path.join(".")}: ${checked.code}`);
  const input = checked.input;
  if (input.kind === "tool-result") throw new DevShape2Refused("input_kind_unsupported: tool-result");
  for (const name of SHAPE1_ONLY_MEMBERS) {
    if (Object.hasOwn(body, name)) throw new DevShape2Refused(`invoke_shape_ambiguous: ${name}`);
  }
  const metadata = input.metadata ?? {};
  const rawSessionId = metadata["guuey/sessionId"];
  // Today's field parser (the Router's invoke-request.ts): a present session id is a non-empty string, or a 400.
  if (rawSessionId !== undefined && (typeof rawSessionId !== "string" || rawSessionId.length === 0)) {
    throw new DevShape2Refused("sessionId: non-empty string required when provided");
  }
  const sessionId = rawSessionId;

  if (input.kind === "resume") {
    const answers = input.answers ?? [];
    if (answers.length === 0 || answers.length > RESUME_ANSWERS_MAX) {
      throw new DevShape2Refused(`resume.answers: 1..${String(RESUME_ANSWERS_MAX)} answers required`);
    }
    if ((input.uiActions ?? []).length > 0) throw new DevShape2Refused("resume.uiActions: not accepted");
    // A resume's turn text is empty, as the shape-1 dev path reads one today.
    return { input: "", sessionId, notDelivered: 0, resume: true };
  }

  const [message, ...rest] = input.messages;
  if (message === undefined || rest.length > 0 || message.role !== "user" || message.id.length === 0) {
    throw new DevShape2Refused("messages: exactly one user message");
  }
  if (input.turnId !== message.id) throw new DevShape2Refused("turnId: must equal messages[0].id");
  const texts: string[] = [];
  let notDelivered = input.run?.context?.length ?? 0;
  for (const block of message.content) {
    if (block.type === "text") texts.push(block.text);
    else notDelivered += 1;
  }
  return { input: texts.join("\n\n"), sessionId, notDelivered, resume: false };
}
