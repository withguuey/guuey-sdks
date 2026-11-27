/**
 * The turn-context caps, judged at send so a builder hears about a list the server would refuse before it goes out
 * (the same as the inbound part caps).
 *
 * `SendOptions.turnContext` is untrusted per-turn context: text blocks the client adds beside the person's words. The
 * server is the authority. Its sanitiser (`context-sanitise`, the one home of these rules) refuses the list, never
 * truncating it, when:
 * - it holds more than {@link TURN_CONTEXT_MAX_BLOCKS} blocks;
 * - a block is not `{ type: "text", text: <string> }`;
 * - the serialised list, `JSON.stringify` of the `{ type, text }` blocks, is over {@link TURN_CONTEXT_MAX_BYTES} UTF-8
 *   bytes. Extra keys on a block are dropped, so they never count.
 * It also refuses a text holding control characters, frame markers or credential-like strings. Those content rules
 * stay on the server; this check is the counts and the shape only.
 *
 * The server measures the list after sanitising it: it strips invisible characters, normalises line breaks, and
 * escapes the context tags. So a list near the byte cap can still be refused there even though it passed here, and
 * the reverse can happen for a list whose texts carry many invisible characters. An empty list is the same as none.
 *
 * The two numbers follow the server's (`TURN_CONTEXT_MAX_BLOCKS` and `TURN_CONTEXT_MAX_BYTES` in
 * `@guuey-private/types/context-sanitise`). This public package cannot import that private one; a test on the private
 * side (`agent-client-turn-context-caps.sync.test.ts` in the runtime) pins the two copies equal.
 */

/** At most this many blocks in one turn's context. */
export const TURN_CONTEXT_MAX_BLOCKS = 32;

/** At most this many UTF-8 bytes in one turn's context, over `JSON.stringify` of its `{ type, text }` blocks. */
export const TURN_CONTEXT_MAX_BYTES = 16_384;

/** Why a turn's context was refused; the words are the server's own refusal codes. */
export type TurnContextRefusal =
  | { reason: "not_text"; index?: number }
  | { reason: "too_many_blocks"; max: number }
  | { reason: "turn_context_kind_unsupported"; index: number }
  | { reason: "too_large"; max: number };

/** The judged list (`{ type, text }` only), or why it was refused. */
export type TurnContextVerdict =
  | { ok: true; blocks: Array<{ type: "text"; text: string }> }
  | { ok: false; refusal: TurnContextRefusal };

const utf8 = new TextEncoder();

/** Judge a turn's context the way the server counts it. Reads what it is given, typed or not. */
export function validateTurnContext(list: unknown): TurnContextVerdict {
  if (!Array.isArray(list)) return { ok: false, refusal: { reason: "not_text" } };
  if (list.length > TURN_CONTEXT_MAX_BLOCKS) {
    return { ok: false, refusal: { reason: "too_many_blocks", max: TURN_CONTEXT_MAX_BLOCKS } };
  }
  const blocks: Array<{ type: "text"; text: string }> = [];
  for (const [index, block] of list.entries()) {
    if (typeof block !== "object" || block === null || Reflect.get(block, "type") !== "text" || !("text" in block)) {
      return { ok: false, refusal: { reason: "turn_context_kind_unsupported", index } };
    }
    const text: unknown = Reflect.get(block, "text");
    if (typeof text !== "string") return { ok: false, refusal: { reason: "not_text", index } };
    blocks.push({ type: "text", text });
  }
  if (utf8.encode(JSON.stringify(blocks)).byteLength > TURN_CONTEXT_MAX_BYTES) {
    return { ok: false, refusal: { reason: "too_large", max: TURN_CONTEXT_MAX_BYTES } };
  }
  return { ok: true, blocks };
}

/** One sentence for the person or the developer: which rule, and the cap or the block. */
export function describeTurnContextRefusal(refusal: TurnContextRefusal): string {
  switch (refusal.reason) {
    case "too_many_blocks":
      return `This message's context has more than ${refusal.max} blocks.`;
    case "too_large":
      return `This message's context is larger than ${refusal.max} bytes.`;
    case "turn_context_kind_unsupported":
      return `Block ${refusal.index + 1} of this message's context is not a text block.`;
    case "not_text":
      return refusal.index === undefined
        ? "This message's context must be a list of text blocks."
        : `Block ${refusal.index + 1} of this message's context has no text.`;
  }
}
