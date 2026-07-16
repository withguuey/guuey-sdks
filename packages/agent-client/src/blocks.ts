/**
 * Frame → AgEvent[] ingestion for the opt-in block-preserving transcript.
 *
 * The wire carries ONE `message` frame per SSE event, but the *payload* shape
 * differs by producer:
 *
 *  - the deployed pod (`nocode-runtime`) emits a SINGLE AgEvent JSON OBJECT per
 *    frame (`sendEvent(res, 'message', e)`);
 *  - the CLI dev server (`guuey dev --serve`) batches an AgEvent[] ARRAY per
 *    frame (`sendEvent(res, 'message', batch)`).
 *
 * `ingestMessageFrame` is tolerant of BOTH shapes (object OR array). Validation
 * is delegated to `@silverprotocol/core`'s `ingestAgEvents`, the library's own
 * parse-known-else-skip consumer validator: any element that is not a valid
 * AgJSON event — including bypass-mode SDKMessage shapes (`type: "assistant"` /
 * `type: "result"`, which are NOT AgEvent `type` literals) — is dropped rather
 * than crashing the stream or forcing a type lie. A frame that is not even a
 * JSON value (`undefined`, a function, `NaN`, …) yields `[]`.
 *
 * The `unknown` → `JsonValue` narrowing is done at runtime via the exported
 * `JsonValue` schema's `safeParse` (the same posture the Claude facet uses for
 * provider-raw parts) — no assertion, no `as`.
 */
import { ingestAgEvents, JsonValue, type AgEvent } from "@silverprotocol/core";

/** Ingest one `message` SSE payload (object OR array) into validated AgEvents. */
export function ingestMessageFrame(raw: unknown): AgEvent[] {
  const parsed = JsonValue.safeParse(raw);
  if (!parsed.success) return [];
  const value = parsed.data;
  return ingestAgEvents(Array.isArray(value) ? value : [value]);
}
