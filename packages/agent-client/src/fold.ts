/**
 * `BlockFold` — the guuey-side fold used by every block-preserving consumer.
 *
 * It is `@silverprotocol/core`'s `Reducer` plus ONE repair: **`_meta` survives
 * onto `tool-result` blocks.**
 *
 * ## Why the repair exists
 *
 * The reducer's `tool.done` arm copies `content`, `outcome`, `isError`,
 * `structuredContent`, `uiData`, `sideData`, `errorText`, `errorCode`,
 * `toolMetadata`, `dynamic`, `pendingInput`, `providerMetadata` and
 * `preliminary` onto the block — and NOT `ev._meta` (only `text.start` and
 * `reasoning.start` carry `_meta` through). The `AgBlock` `tool-result` arm
 * declares `_meta?: AgMeta`, so the field is contract-legal on the block; the
 * fold simply never populates it.
 *
 * That drop is invisible for most tools and fatal for one class: MCP-Apps
 * generative UI. The canonical `_meta.ui` slice AND ggui's
 * `_meta["ai.ggui/render"]` bootstrap (runtime bundle URL, live-channel URL +
 * token, seed props) are BOTH `_meta`-only — visible on the wire, absent from
 * `AgReduceResult`. No folded consumer can mount such a card without them.
 *
 * Upstream is the right long-term home for this (the reducer should copy
 * `ev._meta` the way its text/reasoning arms already do — filed against
 * `@silverprotocol/core`); it has NOT landed as of the pinned `0.3.9` (the
 * reducer is byte-identical across the 0.3.x cohorts), so until it does,
 * this wrapper is the guuey-side carriage the card-mount design calls for. It
 * is deliberately NOT a re-implementation of the fold: every event still goes
 * through the real `Reducer`, and the only thing added is a `toolCallId →
 * _meta` sidecar re-attached at `result()`.
 *
 * ## Fidelity notes
 *
 * - A `tool-result` block that ALREADY carries `_meta` (a future reducer that
 *   fixes this upstream, or another producer) is left exactly as it is —
 *   the carriage never overwrites the fold's own output.
 * - Blocks/messages with nothing to re-attach are passed through by REFERENCE,
 *   so React consumers see the same identity they would without the wrapper.
 * - `needsResync` is proxied verbatim; the wrapper never masks a parked fold.
 */
import { Reducer, type AgEvent, type AgMeta, type AgMessage, type AgReduceResult } from "@silverprotocol/core";

/**
 * Re-attach `_meta` (keyed by `toolCallId`) onto the `tool-result` blocks of a
 * folded result. Pure; returns the SAME object when nothing changes.
 */
export function withToolResultMeta(
  result: AgReduceResult,
  metaByToolCallId: ReadonlyMap<string, AgMeta>,
): AgReduceResult {
  if (metaByToolCallId.size === 0) return result;
  let anyMessageChanged = false;
  const messages: AgMessage[] = result.messages.map((message) => {
    let anyBlockChanged = false;
    const content = message.content.map((block) => {
      if (block.type !== "tool-result" || block._meta !== undefined) return block;
      const meta = metaByToolCallId.get(block.toolCallId);
      if (meta === undefined) return block;
      anyBlockChanged = true;
      return { ...block, _meta: meta };
    });
    if (!anyBlockChanged) return message;
    anyMessageChanged = true;
    return { ...message, content };
  });
  return anyMessageChanged ? { ...result, messages } : result;
}

/**
 * The block-preserving fold: `Reducer` + `_meta` carriage on tool results.
 * Drop-in for the reducer at every guuey consumption site.
 */
export class BlockFold {
  readonly #reducer = new Reducer();
  readonly #metaByToolCallId = new Map<string, AgMeta>();

  /**
   * Fold one AgEvent, recording a `tool.done`'s `_meta` on the way through.
   *
   * The `typeof toolCallId === "string"` check is a real narrowing, not
   * defensive noise: `AgEvent` includes the open `AgExtEvent` arm (`type:
   * string` + a `JsonValue` catch-all), so an extension event is free to carry
   * `type: "tool.done"` with a non-string `toolCallId`. Only the closed arm's
   * shape is a valid key here.
   */
  push(event: AgEvent): void {
    if (
      event.type === "tool.done" &&
      event._meta !== undefined &&
      typeof event.toolCallId === "string"
    ) {
      this.#metaByToolCallId.set(event.toolCallId, event._meta);
    }
    this.#reducer.push(event);
  }

  /** The reducer's park flag, verbatim — a parked fold stays visibly parked. */
  get needsResync(): boolean {
    return this.#reducer.needsResync;
  }

  /** The folded transcript, with tool-result `_meta` re-attached. */
  result(): AgReduceResult {
    return withToolResultMeta(this.#reducer.result(), this.#metaByToolCallId);
  }
}
