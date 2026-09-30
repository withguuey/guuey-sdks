/**
 * guuey#2031 — SYNTHETIC card-tap wire shapes, test-only (`src/fixtures/**`
 * ships in no build and no tarball).
 *
 * Nothing here was captured live. Every shape is built the way
 * `@ggui-ai/iframe-runtime` 0.25.0 builds it, with invented ids and invented
 * words: the `ggui_runtime_submit_action` dispatch arguments and the
 * `ui/message` doorbell (runtime.js), the relay results its classifier reads
 * (the three unwrap tiers), and a greeting card's stored paint in the shape a
 * guuey thread row carries it. A real capture replaces a synthetic case when one
 * is taken; the shape each case copies is named beside it.
 */
import type { AgMessage, JsonValue } from "@silverprotocol/core";
import type { McpToolCallResult, UiActionRequest } from "../action.js";

export const SYNTHETIC_SESSION = "render_00000000-0000-4000-8000-000000002031";
export const SYNTHETIC_APP = "gapp_synthetic_2031";
export const SYNTHETIC_LOCATOR = `ui://ggui/render/${SYNTHETIC_SESSION}/0000000000002031`;

/** ggui's doorbell text, as the runtime writes it (the prose + the directive block + the prose). */
export const SYNTHETIC_DIRECTIVE = [
  `Your REQUIRED FIRST TOOL CALL is ggui_consume with arguments {"sessionId":"${SYNTHETIC_SESSION}"}. Call it NOW to retrieve and process the pending interaction. Do not respond conversationally; do not summarize. Issue the tool call as your next action.`,
  "",
  '<ggui_directive kind="user-action">',
  `  <session_id>${SYNTHETIC_SESSION}</session_id>`,
  "  <next_tool>ggui_consume</next_tool>",
  `  <next_args>{"sessionId":"${SYNTHETIC_SESSION}"}</next_args>`,
  "</ggui_directive>",
  "",
  `The user interacted with render ${SYNTHETIC_SESSION} while no ggui_consume long-poll was active.`,
].join("\n");

export const CHIP_FIND = { label: "Find me a mystery novel", id: "a1b2c3d4e5f6" };
export const CHIP_HOURS = { id: "b2c3d4e5f6a7", label: "What are your opening hours?" };
export const CHIP_EVENTS = { id: "c3d4e5f6a7b8", label: "Any author events soon?" };

export const GREETING_PROPS = {
  heading: "Welcome to the Example Bookshop",
  quickReplies: [CHIP_FIND, CHIP_HOURS, CHIP_EVENTS],
  message: "Your neighborhood bookshop guide.",
};

const RENDER_CALL_ID = "dr_00000000-0000-4000-8000-00000000c411";

/**
 * A greeting's paint as the fold holds it: the render call in an assistant
 * message, its ok result in the tool message after it (the result's `uiData`
 * names the render session — the direct-render shape).
 */
export function greetingFold(
  props: { [key: string]: JsonValue } = GREETING_PROPS,
  renderOutcome: "ok" | "error" = "ok",
): AgMessage[] {
  return [
    {
      id: "msg_synthetic_render",
      role: "assistant",
      turnId: "turn_synthetic_1",
      content: [
        {
          type: "tool-call",
          toolCallId: RENDER_CALL_ID,
          name: "mcp__ggui__ggui_render",
          input: { handshakeId: "00000000-0000-4000-8000-00000000a5a5", props },
        },
      ],
    },
    {
      id: "msg_synthetic_render_result",
      role: "tool",
      turnId: "turn_synthetic_1",
      content: [
        {
          type: "tool-result",
          toolCallId: RENDER_CALL_ID,
          outcome: renderOutcome,
          isError: renderOutcome === "error",
          uiData: { outcome: "rendered", sessionId: SYNTHETIC_SESSION, resourceUri: SYNTHETIC_LOCATOR, action: "create" },
          content: [{ type: "text", text: `{"outcome":"rendered","sessionId":"${SYNTHETIC_SESSION}"}` }],
        },
      ],
    },
  ];
}

/** A repaint of the synthetic session (`ggui_amend` / `ggui_update`), with its result. */
export function repaintFold(
  tool: "ggui_amend" | "ggui_update",
  toolCallId: string,
  input: { [key: string]: JsonValue },
  outcome: "ok" | "error" | "denied" = "ok",
): AgMessage[] {
  return [
    {
      id: `msg_${toolCallId}`,
      role: "assistant",
      turnId: `turn_${toolCallId}`,
      content: [{ type: "tool-call", toolCallId, name: `mcp__ggui__${tool}`, input }],
    },
    {
      id: `msg_${toolCallId}_result`,
      role: "tool",
      turnId: `turn_${toolCallId}`,
      content: [
        {
          type: "tool-result",
          toolCallId,
          outcome,
          ...(outcome === "error" ? { isError: true } : {}),
          content: [{ type: "text", text: outcome === "ok" ? "{}" : "refused" }],
        },
      ],
    },
  ];
}

/**
 * The same messages as a thread stores them (one row per message, the message
 * itself as the row's `content`) and reads them back: JSON through and
 * through, nothing typed.
 */
export function storedRowsOf(messages: readonly AgMessage[]): { seq: number; authorRole: string; content: unknown }[] {
  const parsed: unknown = JSON.parse(JSON.stringify(messages));
  if (!Array.isArray(parsed)) throw new Error("fixture: messages did not round-trip");
  return parsed.map((content: unknown, i) => ({ seq: i + 1, authorRole: "agent", content }));
}

/** The `tools/call` a chip tap relays, arguments built as runtime.js 0.25 builds them for a `dispatch`. */
export function chipTapRequest(
  replyId: string | null,
  over: { sessionId?: string; actionId?: string; name?: string; kind?: string } = {},
): UiActionRequest {
  return {
    resourceUri: SYNTHETIC_LOCATOR,
    name: over.name ?? "ggui_runtime_submit_action",
    arguments: {
      kind: over.kind ?? "dispatch",
      payload: { intent: "chooseReply", actionData: replyId === null ? null : { id: replyId }, uiContext: {} },
      sessionId: over.sessionId ?? SYNTHETIC_SESSION,
      appId: SYNTHETIC_APP,
      actionId: over.actionId ?? "5a5a5a5a",
      firedAt: "2026-09-30T00:00:00.000Z",
    },
  };
}

/** The `ui/message` params the doorbell posts (runtime.js 0.25: the meta rides the FIRST content block). */
export function doorbellParams(actionId: string | null, sessionId = SYNTHETIC_SESSION): { [key: string]: unknown } {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: SYNTHETIC_DIRECTIVE,
        ...(actionId === null
          ? {}
          : {
              _meta: {
                "ai.ggui/userAction": {
                  kind: "user-action",
                  description: `User interacted with render ${sessionId}; call ggui_consume to retrieve and process it.`,
                  sessionId,
                  actionId,
                  submittedAt: "2026-09-30T00:00:00.000Z",
                  intent: "chooseReply",
                  nextStep: { tool: "ggui_consume", args: { sessionId } },
                },
              },
            }),
      },
    ],
  };
}

/**
 * Relay results for the submit-action classifier, one per tier and outcome
 * (runtime.js 0.25 `classifySubmitActionResponse` + `extractConsumerPresent`
 * over `unwrapCallToolResult`). SYNTHETIC: no live submit result is on file.
 */
export const SUBMIT_RESULTS: ReadonlyArray<{
  name: string;
  result: McpToolCallResult;
  outcome: "enqueued" | "consumed-live" | "not-enqueued";
}> = [
  {
    name: "enqueued, no consumer listening (structuredContent tier)",
    result: { content: [{ type: "text", text: "queued" }], structuredContent: { ok: true, consumerPresent: false } },
    outcome: "enqueued",
  },
  {
    name: "enqueued, consumer flag stripped (the runtime rings on anything but true)",
    result: { content: [], structuredContent: { ok: true } },
    outcome: "enqueued",
  },
  {
    name: "drained by a live consume (structuredContent tier)",
    result: { content: [], structuredContent: { ok: true, consumerPresent: true } },
    outcome: "consumed-live",
  },
  {
    name: "enqueued, text-JSON tier (a host that normalizes to the text block)",
    result: { content: [{ type: "text", text: '{"ok":true,"consumerPresent":false}' }] },
    outcome: "enqueued",
  },
  {
    name: "drained, text-JSON tier",
    result: { content: [{ type: "text", text: '{"ok":true,"consumerPresent":true}' }] },
    outcome: "consumed-live",
  },
  {
    name: "structuredContent wins over the text tier",
    result: { content: [{ type: "text", text: '{"ok":true}' }], structuredContent: { ok: false, code: "PIPE_NOT_FOUND" } },
    outcome: "not-enqueued",
  },
  {
    name: "a well-formed refusal (expired pipe)",
    result: { content: [], structuredContent: { ok: false, code: "PIPE_NOT_FOUND" } },
    outcome: "not-enqueued",
  },
  {
    name: "the relay's own in-band unavailable (isError, prose text)",
    result: { content: [{ type: "text", text: "This action isn't available right now." }], isError: true },
    outcome: "not-enqueued",
  },
  {
    name: "a non-JSON text block and no structuredContent",
    result: { content: [{ type: "text", text: "ok" }] },
    outcome: "not-enqueued",
  },
];
