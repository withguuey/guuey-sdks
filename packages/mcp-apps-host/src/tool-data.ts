/**
 * The tool data a mounted view is owed (MCP Apps SEP-1865, §Lifecycle):
 * after the view's `ui/notifications/initialized`, the host sends
 * `ui/notifications/tool-input` (the producing call's complete arguments)
 * and `ui/notifications/tool-result` (the tool's result, a `CallToolResult`).
 * A standard view waits for that result (`App.ontoolresult`) before it draws.
 *
 * This module turns what a transcript ALREADY holds for a card into those
 * two payloads — the live fold's `tool-call` + `tool-result` blocks, or a
 * persisted card snapshot — and nothing else. Pure narrowing, no DOM.
 *
 * What is sent, and what never is:
 *  - **input**: the call's `input` when it is a key-value object. An input
 *    replaced by the persistence elision marker ({@link ELIDED_VALUE_MARKER}),
 *    or absent (a card snapshot stores the result only), sends nothing —
 *    never a stand-in.
 *  - **structuredContent**: the surface channel (`uiData`) when it holds
 *    data, else `structuredContent`. The AgJSON normalizer routes a result's
 *    `structuredContent` to `uiData` when the server stamped `_meta.ui`, so
 *    between them they are the tool's structured output. An inline mount
 *    resource on `uiData` (`{uri, text|blob}`) is the view's own document,
 *    not data, and is never echoed back.
 *  - **content**: text blocks only. Media blocks (base64 by MCP's own
 *    content shape), `provider-raw` parts and embedded resources stay out —
 *    the same "no base64 across the boundary" posture the transcript keeps.
 *  - **`_meta`**: never. A live tool result's `_meta` is mount material that
 *    can carry short-TTL credentials; persistence strips it too.
 */
import type { AgBlock, JsonValue } from "@silverprotocol/core";
import { asUiResource, isJsonObject } from "./block-ui.js";
import type { McpToolCallContent, McpToolCallResult, McpToolStructuredContent } from "./action.js";

/**
 * The key of the marker a persisted tool-call value is replaced by when its
 * row would not fit the store (`{ "com.guuey/elided": { bytes } }` —
 * `@guuey/threads`' `ELIDED_VALUE_KEY`; a sync test there pins the two).
 */
export const ELIDED_VALUE_MARKER = "com.guuey/elided";

/** What a card's view is sent after `initialized`; each half only when held. */
export interface ViewToolData {
  /** `ui/notifications/tool-input` `params.arguments`. */
  input?: McpToolStructuredContent;
  /** `ui/notifications/tool-result` `params` (a `CallToolResult`). */
  result?: McpToolCallResult;
}

type ToolResultBlock = Extract<AgBlock, { type: "tool-result" }>;

/**
 * A tool call's `input` → the tool-input arguments, or `undefined` when it
 * is not a key-value object or is the elision marker.
 */
export function toolCallViewInput(input: JsonValue | undefined): McpToolStructuredContent | undefined {
  if (!isJsonObject(input)) return undefined;
  if (Object.prototype.hasOwnProperty.call(input, ELIDED_VALUE_MARKER)) return undefined;
  return input;
}

/** The structured output a view gets: surface data first, never a mount resource. */
function structuredOutput(
  uiData: JsonValue | undefined,
  structuredContent: JsonValue | undefined,
): McpToolStructuredContent | undefined {
  if (isJsonObject(uiData) && asUiResource(uiData) === undefined) return uiData;
  return isJsonObject(structuredContent) ? structuredContent : undefined;
}

function resultParams(
  content: McpToolCallContent[],
  structured: McpToolStructuredContent | undefined,
  isError: boolean,
): McpToolCallResult {
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

/** A live `tool-result` block → the tool-result params. */
export function toolResultViewResult(block: ToolResultBlock): McpToolCallResult {
  const content: McpToolCallContent[] = [];
  for (const part of block.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
  }
  return resultParams(content, structuredOutput(block.uiData, block.structuredContent), block.isError === true);
}

/** A live card's producing call (when the fold holds it) + its result → the view's tool data. */
export function viewToolData(call: { input: JsonValue } | undefined, result: ToolResultBlock): ViewToolData {
  const input = toolCallViewInput(call?.input);
  return { ...(input !== undefined ? { input } : {}), result: toolResultViewResult(result) };
}

/** A stored (untyped) tool-result part → the tool-result params. */
function storedResultParams(part: { [key: string]: JsonValue }): McpToolCallResult {
  const content: McpToolCallContent[] = [];
  if (Array.isArray(part.content)) {
    for (const block of part.content) {
      if (isJsonObject(block) && block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      }
    }
  }
  return resultParams(content, structuredOutput(part.uiData, part.structuredContent), part.isError === true);
}

/**
 * A persisted card's `cardSnapshot` → its view's tool data: the first
 * stored `tool-result` part, plus the input of a stored `tool-call` part
 * with the same `toolCallId` when the snapshot carries one (today's
 * projection stores the result only, so the input is absent and none is
 * sent). `undefined` when the snapshot holds no tool-result part.
 */
export function snapshotViewToolData(cardSnapshot: JsonValue): ViewToolData | undefined {
  if (!isJsonObject(cardSnapshot) || !Array.isArray(cardSnapshot.parts)) return undefined;
  const parts = cardSnapshot.parts.filter(isJsonObject);
  const stored = parts.find((part) => part.type === "tool-result");
  if (stored === undefined) return undefined;
  const call = parts.find(
    (part) => part.type === "tool-call" && typeof stored.toolCallId === "string" && part.toolCallId === stored.toolCallId,
  );
  const input = toolCallViewInput(call?.input);
  return { ...(input !== undefined ? { input } : {}), result: storedResultParams(stored) };
}
