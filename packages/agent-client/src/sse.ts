/**
 * Pure SSE helpers for the base-platform invoke contract. Zero React / DOM /
 * platform dependencies — unit-tested in isolation (`sse.test.ts`) and shared
 * verbatim across web (Studio) and React-Native (Portal).
 */

import type { ProfileLinkRequest } from "./types.js";

export interface ParsedSseEvent {
  event: string;
  data: unknown;
}

/**
 * Parse complete `event:`/`data:` frames out of an SSE buffer. Returns the
 * parsed events plus the unparsed remainder (a partial trailing frame). Frames
 * are separated by a blank line; `data:` JSON is parsed best-effort.
 */
export function parseSseEvents(buffer: string): { events: ParsedSseEvent[]; rest: string } {
  const events: ParsedSseEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    let data: unknown = dataLines.join("\n");
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      /* leave as raw string */
    }
    events.push({ event, data });
  }
  return { events, rest };
}

function frameType(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return undefined;
  return (data as { type?: unknown }).type;
}

function isResultMessage(data: unknown): boolean {
  return frameType(data) === "result";
}

/**
 * Join point where a NEW text block begins: distinct blocks are distinct
 * paragraphs on the flat text surface (guuey#98 — raw concatenation rendered
 * "…instead.Here's your packing…"). Idempotent so an empty block between two
 * boundaries never stacks separators.
 */
function withBlockBreak(current: string): string {
  if (!current || current.endsWith("\n\n")) return current;
  return current + "\n\n";
}

/**
 * Fold one `message` SSE payload into the running assistant text. `assistant`
 * messages APPEND (streaming). The success `result` message carries the SAME
 * final text, so it REPLACES rather than appends — otherwise the answer renders
 * twice. The result is also the fallback for result-only turns.
 *
 * Block boundaries become paragraph breaks: a silver `text.start` frame (and,
 * on the bypass arm, each new `assistant` message) opens a new block, so the
 * separator lands exactly there — never per `text.delta`, which must stay a
 * raw append for streaming (#91).
 */
export function reduceAssistantText(current: string, data: unknown): string {
  if (isResultMessage(data)) {
    const result = extractAssistantText(data);
    return result || current;
  }
  if (frameType(data) === "text.start") return withBlockBreak(current);
  const text = extractAssistantText(data);
  if (!text) return current;
  if (frameType(data) === "assistant") return withBlockBreak(current) + text;
  return current + text;
}

/**
 * Best-effort assistant text from one `message` payload — BOTH protocols:
 *
 *  - **silver (the pod default)**: AgJSON events — `text.delta` carries the
 *    streamed text in `.delta`; every other event family (turn/message/tool
 *    lifecycle) contributes "". AgJSON never resends the final text, so
 *    deltas are append-only (no result-replacement leg).
 *  - **bypass**: SDKMessage shapes — text blocks off an `assistant` message;
 *    the success `result` string as fallback/replacement.
 *
 * The silver arm was MISSING while silver became the pod default — live
 * portal/studio chat rendered EMPTY assistant messages (0.3.2 coverage
 * audit G14, confirmed by reducing a live wire capture to "").
 */
export function extractAssistantText(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const type = (data as { type?: unknown }).type;
  if (type === "text.delta") {
    const delta = (data as { delta?: unknown }).delta;
    return typeof delta === "string" ? delta : "";
  }
  if (type === "assistant") {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "object" && message !== null && "content" in message) {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        // Distinct text blocks are distinct paragraphs (guuey#98) — same
        // block-boundary contract as the silver arm's text.start handling.
        return content
          .filter(
            (b): b is { type: "text"; text: string } =>
              typeof b === "object" &&
              b !== null &&
              (b as { type?: unknown }).type === "text" &&
              typeof (b as { text?: unknown }).text === "string",
          )
          .map((b) => b.text)
          .filter((t) => t.length > 0)
          .join("\n\n");
      }
    }
    return "";
  }
  if (type === "result") {
    const subtype = (data as { subtype?: unknown }).subtype;
    const result = (data as { result?: unknown }).result;
    if (subtype === "success" && typeof result === "string") return result;
  }
  return "";
}

/** Read a string field off an SSE `data` object, or undefined. */
export function stringField(data: unknown, key: string): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Parse a `profile-link-needed` SSE payload into a typed
 * {@link ProfileLinkRequest}, or `null` if it does not conform. `appId` must
 * be a non-empty string and `requested` exactly `"read"` or `"read-write"`;
 * extra keys are tolerated (ignored). Returns a fresh normalized object so
 * callers get exactly the typed shape, never the raw wire payload with
 * unknown extras.
 */
export function parseLinkRequest(data: unknown): ProfileLinkRequest | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const appId = (data as { appId?: unknown }).appId;
  const requested = (data as { requested?: unknown }).requested;
  if (typeof appId !== "string" || appId.length === 0) return null;
  if (requested !== "read" && requested !== "read-write") return null;
  return { appId, requested };
}
