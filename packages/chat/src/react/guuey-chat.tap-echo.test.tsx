// @vitest-environment jsdom
/**
 * guuey#2031 — the kit's tap echo, end to end over the REAL hook stack: a chip
 * tap on a card the live fold painted draws the chip's words at once as a
 * pending action turn; the doorbell's send carries the same words and the same
 * id; the sent row replaces the pending one in place. And the wiring rule: the
 * echo relay is substituted only where BOTH the kit's relay and the kit's
 * `ui/message` sink are in effect for a slot.
 *
 * The transport and the action door are scripted (fetch is stubbed); every
 * wire value is SYNTHETIC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import type { McpToolCallResult, UiActionRequest } from "@guuey/mcp-apps-host";
import { GuueyChat, viewPropsWithThemeAnnounce, type GuueyChatHandle } from "./guuey-chat.js";
import type { ViewMountItem } from "../types.js";

afterEach(cleanup);

const SESSION = "render_00000000-0000-4000-8000-000000002031";
const LOCATOR = `ui://ggui/render/${SESSION}/0000000000002031`;
const CHIP = { id: "b2c3d4e5f6a7", label: "What are your opening hours?" };
const GREETING = { heading: "Welcome", message: "Hi.", quickReplies: [{ id: "a1b2c3d4e5f6", label: "Find me a mystery novel" }, CHIP] };
const DIRECTIVE = `Your REQUIRED FIRST TOOL CALL is ggui_consume with arguments {"sessionId":"${SESSION}"}.\n\n<ggui_directive kind="user-action">\n  <session_id>${SESSION}</session_id>\n  <next_tool>ggui_consume</next_tool>\n</ggui_directive>`;

/** The greeting's paint as the runtime streams it: a render call, then its ok result naming the session. */
const RENDER_FRAME = `event: message\ndata: ${JSON.stringify([
  { seq: 0, type: "turn.start", threadId: "t-tap", turnId: "turn-1" },
  { seq: 1, type: "message.start", id: "m-render", role: "assistant", turnId: "turn-1", threadId: "t-tap" },
  {
    seq: 2,
    type: "content.block",
    messageId: "m-render",
    turnId: "turn-1",
    block: { type: "tool-call", toolCallId: "dr_call_1", name: "mcp__ggui__ggui_render", input: { props: GREETING } },
  },
  { seq: 3, type: "message.end", id: "m-render" },
  { seq: 4, type: "message.start", id: "m-result", role: "tool", turnId: "turn-1", threadId: "t-tap" },
  {
    seq: 5,
    type: "content.block",
    messageId: "m-result",
    turnId: "turn-1",
    block: { type: "tool-result", toolCallId: "dr_call_1", outcome: "ok", content: [], uiData: { sessionId: SESSION, resourceUri: LOCATOR } },
  },
  { seq: 6, type: "message.end", id: "m-result" },
  { seq: 7, type: "turn.done", turnId: "turn-1", outcome: { type: "success" }, finishReason: "stop" },
])}\n\n`;
const SESSION_FRAME = 'event: session\ndata: {"threadId":"t-tap"}\n\n';
const DONE_FRAME = 'event: done\ndata: {"stopReason":"end"}\n\n';

function tapRequest(actionId: string): UiActionRequest {
  return {
    resourceUri: LOCATOR,
    name: "ggui_runtime_submit_action",
    arguments: {
      kind: "dispatch",
      payload: { intent: "chooseReply", actionData: { id: CHIP.id }, uiContext: {} },
      sessionId: SESSION,
      appId: "gapp_synthetic",
      actionId,
      firedAt: "2026-09-30T00:00:00.000Z",
    },
  };
}

function doorbell(actionId: string, text: string = DIRECTIVE): { [key: string]: unknown } {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text,
        _meta: {
          "ai.ggui/userAction": {
            kind: "user-action",
            description: "",
            sessionId: SESSION,
            actionId,
            submittedAt: "2026-09-30T00:00:00.000Z",
            intent: "chooseReply",
            nextStep: { tool: "ggui_consume", args: { sessionId: SESSION } },
          },
        },
      },
    ],
  };
}

/** The first turn paints the greeting; later turns fail before admission when `failAfterFirst` says so. */
function adaptersFor(opts: { failSecond?: boolean } = {}) {
  const calls: InvokeRequest[] = [];
  let n = 0;
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => `cmid-${n++}`,
    transport: async function* (req) {
      calls.push(req);
      if (calls.length === 2 && opts.failSecond === true) throw new Error("network down");
      yield SESSION_FRAME;
      if (calls.length === 1) yield RENDER_FRAME;
      yield DONE_FRAME;
    },
  };
  return { adapters, calls };
}

/** The action door answers "enqueued, no consumer listening"; every other request misses. */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ content: [], structuredContent: { ok: true, consumerPresent: false } }), { status: 200 })
        : new Response("", { status: 404 }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function paintedChat(opts: { failSecond?: boolean } = {}) {
  const { adapters, calls } = adaptersFor(opts);
  let handle: GuueyChatHandle | null = null;
  render(
    <GuueyChat
      endpointUrl="https://pod.example/agent/invoke"
      apiBaseUrl="https://api.example/v1"
      adapters={adapters}
      onReady={(h) => {
        handle = h;
      }}
    />,
  );
  await waitFor(() => expect(handle).not.toBeNull());
  act(() => {
    expect(handle!.send("hi")).toBe(true);
  });
  await waitFor(() => expect(calls).toHaveLength(1));
  await screen.findByRole("button", { name: "Send" });
  await waitFor(() => expect(handle!.threadId).toBe("t-tap"));
  return { handle: handle!, calls };
}

function bodyOf(req: InvokeRequest | undefined): { [key: string]: unknown } {
  const body = req?.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("no body");
  return { ...body };
}

describe("the kit's tap echo, end to end (a chip on a card the live fold painted)", () => {
  it("the tap draws the chip's words at once; the doorbell's send carries them under the same id; the sent row replaces the pending one", async () => {
    const { handle, calls } = await paintedChat();
    const onCallTool = handle.viewSlotProps().onCallTool;
    const onUserMessage = handle.viewSlotProps().onUserMessage;
    if (onCallTool === undefined || onUserMessage === undefined) throw new Error("kit wiring expected");

    let result: McpToolCallResult | undefined;
    await act(async () => {
      result = await onCallTool(tapRequest("5a5a5a5a"));
    });
    expect(result?.structuredContent).toEqual({ ok: true, consumerPresent: false });
    // The pending action turn, in the chip's own words, before any turn started.
    const pending = document.querySelector(".guuey-chat-action-sending .guuey-chat-action-label");
    expect(pending?.textContent).toBe(CHIP.label);
    expect(calls).toHaveLength(1);

    await act(async () => {
      await onUserMessage(doorbell("5a5a5a5a"));
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    const body = bodyOf(calls[1]);
    expect(body["input"]).toBe(DIRECTIVE);
    expect(body["tapLabels"]).toEqual([CHIP.label]);
    expect(body["clientMessageId"]).toBe("cmid-1"); // minted for the pending row at tap time

    await screen.findByRole("button", { name: "Send" });
    // One action turn with the words, no continuation line, no directive text on screen.
    const labels = [...document.querySelectorAll(".guuey-chat-action-label")].map((el) => el.textContent);
    expect(labels).toEqual([CHIP.label]);
    expect(document.querySelector(".guuey-chat-directive-label")).toBeNull();
    expect(document.body.textContent).not.toContain("REQUIRED FIRST TOOL CALL");
  });

  it("a doorbell that names the tap but carries no text withdraws the drawn tap at once (no stale pending turn for the grace)", async () => {
    const { handle, calls } = await paintedChat();
    const onCallTool = handle.viewSlotProps().onCallTool;
    const onUserMessage = handle.viewSlotProps().onUserMessage;
    if (onCallTool === undefined || onUserMessage === undefined) throw new Error("kit wiring expected");
    await act(async () => {
      await onCallTool(tapRequest("9e9e9e9e"));
    });
    expect(document.querySelector(".guuey-chat-action-sending .guuey-chat-action-label")?.textContent).toBe(CHIP.label);

    let delivery: unknown;
    await act(async () => {
      delivery = await onUserMessage(doorbell("9e9e9e9e", "  "));
    });
    expect(delivery).toEqual({ delivered: false, reason: "no text content" });
    // Withdrawn in the doorbell's own task, well inside TAP_DOORBELL_GRACE_MS.
    expect(document.querySelector(".guuey-chat-action-sending")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("a retry of a failed action turn re-sends the directive WITH its words", async () => {
    const { handle, calls } = await paintedChat({ failSecond: true });
    const onCallTool = handle.viewSlotProps().onCallTool;
    const onUserMessage = handle.viewSlotProps().onUserMessage;
    if (onCallTool === undefined || onUserMessage === undefined) throw new Error("kit wiring expected");
    await act(async () => {
      await onCallTool(tapRequest("6b6b6b6b"));
      await onUserMessage(doorbell("6b6b6b6b"));
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(await screen.findByText("Retry"));
    await waitFor(() => expect(calls).toHaveLength(3));
    const retried = bodyOf(calls[2]);
    expect(retried["input"]).toBe(DIRECTIVE);
    expect(retried["tapLabels"]).toEqual([CHIP.label]);
  });
});

describe("the kit's tap echo on a card painted before a reload (its own document's props)", () => {
  it("a tap on a history card resolves the chip's words from the mounted shell, with no paint in the live fold", async () => {
    // A SYNTHETIC ggui shell: the inlined render-slice envelope ggui's shell writer emits
    // (`globalThis.__GGUI_META__ = {…};</script>`), with an invented session and props.
    const slice = { sessionId: SESSION, appId: "gapp_synthetic", runtimeUrl: "https://runtime.example/ggui-runtime.js", propsJson: JSON.stringify(GREETING) };
    const shell = `<!doctype html><html><body><script>globalThis.__GGUI_META__ = ${JSON.stringify({ "ai.ggui/render": slice })};</script></body></html>`;
    const reader = vi.fn(async (uri: string) => ({ channel: "ggui" as const, resource: { uri, mimeType: "text/html;profile=mcp-app", text: shell } }));
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => "t-tap", save: () => {} },
      generateId: (() => {
        let n = 0;
        return () => `cmid-${n++}`;
      })(),
      transport: async function* () {
        yield SESSION_FRAME;
        yield DONE_FRAME;
      },
      history: {
        load: async () => ({
          messages: [{ role: "assistant" as const, text: "Welcome back.", seq: 2 }],
          cards: [
            {
              seq: 1,
              at: "2026-09-30T00:00:01Z",
              cardSnapshot: { artifactId: "a1", parts: [{ type: "tool-result", toolCallId: "dr_call_1", content: [], uiData: { resourceUri: LOCATOR } }] },
            },
          ],
        }),
      },
    };
    let handle: GuueyChatHandle | null = null;
    render(
      <GuueyChat
        endpointUrl="https://pod.example/agent/invoke"
        apiBaseUrl="https://api.example/v1"
        adapters={adapters}
        reader={reader}
        onReady={(h) => {
          handle = h;
        }}
      />,
    );
    await waitFor(() => expect(handle?.threadId).toBe("t-tap"));
    await waitFor(() => expect(reader).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const onCallTool = handle!.viewSlotProps().onCallTool;
    if (onCallTool === undefined) throw new Error("kit relay expected");
    await act(async () => {
      await onCallTool(tapRequest("8d8d8d8d"));
    });
    expect(document.querySelector(".guuey-chat-action-sending .guuey-chat-action-label")?.textContent).toBe(CHIP.label);
  });
});

describe("the echo relay is substituted only where the kit's relay AND the kit's sink are both in effect", () => {
  const kitRelay = vi.fn(async (): Promise<McpToolCallResult> => ({ content: [] }));
  const echoRelay = vi.fn(async (): Promise<McpToolCallResult> => ({ content: [] }));
  const kitSink = vi.fn();
  const defaults = { onCallTool: kitRelay, onUserMessage: kitSink };
  const mountOf = { channel: "inline" as const, resource: { uri: "ui://x/1", text: "<p/>" } };
  const itemOf = (key: string): ViewMountItem => ({
    kind: "view",
    key,
    expanded: true,
    mount: mountOf,
    channel: "inline",
    phase: "connected",
    label: null,
    diagnosis: null,
    attribution: null,
    toolTitle: null,
    actionScope: "ui://x/1",
  });
  const slot = (viewProps: Parameters<typeof viewPropsWithThemeAnnounce>[0], item = itemOf("view.a")) => {
    const out = viewPropsWithThemeAnnounce(viewProps, "light", defaults, "", undefined, echoRelay);
    return typeof out === "function" ? out(item, mountOf) : out;
  };

  it("no viewProps, or an object without either key: the echo relay", () => {
    expect(slot(undefined)?.onCallTool).toBe(echoRelay);
    expect(slot({ autoResize: true })?.onCallTool).toBe(echoRelay);
  });

  it("a host's own onUserMessage: the kit's plain relay (its sink never sees the doorbell)", () => {
    const own = async () => ({ delivered: true as const });
    expect(slot({ onUserMessage: own })?.onCallTool).toBe(kitRelay);
  });

  it("a host's own onCallTool: its own relay, never wrapped", () => {
    const own = async (): Promise<McpToolCallResult> => ({ content: [] });
    expect(slot({ onCallTool: own })?.onCallTool).toBe(own);
  });

  it("function form: decided per item", () => {
    const perItem = (item: ViewMountItem) => (item.key === "view.b" ? { onUserMessage: async () => ({ delivered: true as const }) } : {});
    expect(slot(perItem, itemOf("view.a"))?.onCallTool).toBe(echoRelay);
    expect(slot(perItem, itemOf("view.b"))?.onCallTool).toBe(kitRelay);
  });

  it("the canvas handle's function-form branch hands out the echo relay (both kit defaults ride there)", async () => {
    const { adapters } = adaptersFor();
    let handle: GuueyChatHandle | null = null;
    render(
      <GuueyChat
        endpointUrl="https://pod.example/agent/invoke"
        apiBaseUrl="https://api.example/v1"
        adapters={adapters}
        viewProps={() => ({ autoResize: true })}
        onReady={(h) => {
          handle = h;
        }}
      />,
    );
    await waitFor(() => expect(handle).not.toBeNull());
    act(() => {
      expect(handle!.send("hi")).toBe(true);
    });
    await screen.findByRole("button", { name: "Send" });
    await waitFor(() => expect(handle!.threadId).toBe("t-tap"));
    const onCallTool = handle!.viewSlotProps().onCallTool;
    if (onCallTool === undefined) throw new Error("kit relay expected");
    await act(async () => {
      await onCallTool(tapRequest("7c7c7c7c"));
    });
    expect(document.querySelector(".guuey-chat-action-sending .guuey-chat-action-label")?.textContent).toBe(CHIP.label);
  });
});
