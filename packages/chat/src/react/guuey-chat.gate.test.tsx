// @vitest-environment jsdom
/**
 * One gate, said once: every send path of `<GuueyChat>` (the composer, a
 * handle send, a suggestion chip, a view's ui/message doorbell and an A2UI
 * press) refuses on the composer's one refusal, `composerClosed`: no chat, a
 * pending connect card, or an ended conversation. Over the real hook stack
 * with scripted transports.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import { defaultChatStrings } from "../strings.js";
import { GuueyChat, type GuueyChatHandle } from "./guuey-chat.js";

afterEach(cleanup);

const THREAD = "t-gate";
const SESSION_FRAME = `event: session\ndata: {"threadId":"${THREAD}"}\n\n`;
const DONE_FRAME = 'event: done\ndata: {"stopReason":"end"}\n\n';
const wire = (events: object[]): string => `event: message\ndata: ${JSON.stringify(events)}\n\n`;
const CLOSED = { code: "app:CHAT_FULL", message: "This chat is full.", closedAt: "2026-10-15T00:00:00.000Z" };

const V = "v0.9";
const FORM_FRAMES = [
  wire([
    { type: "turn.start", threadId: THREAD, turnId: "turn-1", seq: 1 },
    { type: "message.start", id: "m1", role: "assistant", turnId: "turn-1", threadId: THREAD, seq: 2 },
    { type: "tool.start", toolCallId: "t1", name: "show_order_form", seq: 3 },
    { type: "tool.args.assembled", toolCallId: "t1", input: {}, seq: 4 },
    {
      type: "tool.done",
      toolCallId: "t1",
      content: [{ type: "text", text: "form shown" }],
      outcome: "ok",
      isError: false,
      structuredContent: {
        "com.guuey/a2ui": {
          format: "a2ui",
          version: V,
          messages: [
            { version: V, createSurface: { surfaceId: "order", catalogId: "guuey.a2ui.v1" } },
            {
              version: V,
              updateComponents: {
                surfaceId: "order",
                components: [
                  { id: "root", component: "Column", children: ["go"] },
                  { id: "go", component: "Button", label: "Place order", action: { name: "submit" } },
                ],
              },
            },
          ],
        },
      },
      seq: 5,
    },
  ]),
];

/** The held (card-only) stream of an `authMode:'upfront'` server with no connection (guuey#605). */
function heldFrames(): string[] {
  const ask = {
    askId: "mcp-oauth:app_1:linear:t-gate",
    kind: "auth",
    message: "Trip Planner wants to use your Linear account",
    authConfig: { scheme: "oauth2", authorizationUrl: "https://mcp.example/oauth/start?state=" + "a".repeat(64) },
    grantModes: [{ id: "always", label: "Always allow" }],
    metadata: { appId: "app_1", serverName: "linear", displayName: "Linear", authMode: "upfront" },
  };
  return [
    SESSION_FRAME,
    `event: message\ndata: ${JSON.stringify({ type: "turn.start", seq: 6, turnId: `${ask.askId}#turn`, threadId: THREAD })}\n\n`,
    `event: message\ndata: ${JSON.stringify({ type: "hitl.ask", seq: 7, turnId: `${ask.askId}#turn`, continuation: "turn", ...ask })}\n\n`,
    `event: message\ndata: ${JSON.stringify({ type: "turn.done", seq: 8, turnId: `${ask.askId}#turn`, finishReason: "paused", outcome: { type: "paused", asks: [ask] } })}\n\n`,
    DONE_FRAME,
  ];
}

type Closing = "authRequired" | "threadClosed";

/**
 * Turn 1 draws the A2UI form. Turn 2 closes the composer: `authRequired` holds
 * it on a connect card, `threadClosed` ends the conversation.
 */
function closingAdapters(closing: Closing): { adapters: AgentInvokeAdapters; calls: InvokeRequest[] } {
  const calls: InvokeRequest[] = [];
  const store = new Map<string, string>();
  const adapters: AgentInvokeAdapters = {
    storage: {
      load: (key) => store.get(key) ?? null,
      save: (key, threadId) => {
        store.set(key, threadId);
      },
    },
    generateId: (() => {
      let n = 0;
      return () => `cmid-${n++}`;
    })(),
    transport: async function* (req) {
      calls.push(req);
      if (calls.length === 1) {
        yield SESSION_FRAME;
        for (const f of FORM_FRAMES) yield f;
        yield DONE_FRAME;
        return;
      }
      if (closing === "authRequired") {
        for (const f of heldFrames()) yield f;
        return;
      }
      yield SESSION_FRAME;
      yield `event: error\ndata: ${JSON.stringify({ code: CLOSED.code, message: CLOSED.message, threadClosed: CLOSED })}\n\n`;
      yield `event: done\ndata: ${JSON.stringify({ stopReason: "end_turn", threadId: THREAD, threadClosed: CLOSED })}\n\n`;
    },
  };
  return { adapters, calls };
}

function typeAndSend(text: string): void {
  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

/**
 * `closingAdapters`, but turn 2 holds its stream open until `release()`, so a
 * doorbell can ring while it is busy and queue behind it.
 */
function heldClosingAdapters(closing: Closing): { adapters: AgentInvokeAdapters; calls: InvokeRequest[]; release: () => void } {
  const inner = closingAdapters(closing);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let turns = 0;
  const adapters: AgentInvokeAdapters = {
    ...inner.adapters,
    transport: async function* (req) {
      turns += 1;
      if (turns > 1) await held;
      yield* inner.adapters.transport(req);
    },
  };
  return { adapters, calls: inner.calls, release: () => release() };
}

/** Mounts the chat, draws the form, then closes the composer; returns the handle. */
async function closedChat(closing: Closing) {
  const t = closingAdapters(closing);
  let handle: GuueyChatHandle | null = null;
  const view = render(
    <GuueyChat
      endpointUrl="https://pod.example/agent/invoke"
      apiBaseUrl="https://api.example/v1"
      adapters={t.adapters}
      onReady={(h) => {
        handle = h;
      }}
    />,
  );
  typeAndSend("order please");
  await screen.findByRole("button", { name: "Place order" });
  await waitFor(() => expect(screen.queryByRole("button", { name: defaultChatStrings.stop })).toBeNull());
  typeAndSend("and then");
  await waitFor(() => expect(t.calls).toHaveLength(2));
  await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true));
  await waitFor(() => expect(screen.queryByRole("button", { name: defaultChatStrings.stop })).toBeNull());
  if (handle === null) throw new Error("handle expected");
  return { ...t, handle: handle as GuueyChatHandle, view };
}

describe.each<Closing>(["authRequired", "threadClosed"])("one gate, said once, under %s", (closing) => {
  it("a handle send is refused: it returns false and nothing is sent", async () => {
    const { calls, handle } = await closedChat(closing);
    let sent = true;
    act(() => {
      sent = handle.send("send it anyway");
    });
    expect(sent).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(2);
  });

  it("a view's ui/message doorbell is refused: not delivered, nothing is sent", async () => {
    const { calls, handle } = await closedChat(closing);
    const sink = handle.viewSlotProps().onUserMessage;
    if (sink === undefined) throw new Error("message sink expected");
    const warn = console.warn;
    console.warn = () => {};
    try {
      const delivery = await sink({ role: "user", content: [{ type: "text", text: "ggui_consume now" }] });
      expect(delivery).toEqual({ delivered: false, reason: "chat is closed" });
    } finally {
      console.warn = warn;
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(2);
  });

  it("a doorbell queued behind the closing turn is refused the same way once it drains", async () => {
    const t = heldClosingAdapters(closing);
    let handle: GuueyChatHandle | null = null;
    render(
      <GuueyChat
        endpointUrl="https://pod.example/agent/invoke"
        apiBaseUrl="https://api.example/v1"
        adapters={t.adapters}
        onReady={(h) => {
          handle = h;
        }}
      />,
    );
    typeAndSend("order please");
    await screen.findByRole("button", { name: "Place order" });
    await waitFor(() => expect(screen.queryByRole("button", { name: defaultChatStrings.stop })).toBeNull());
    typeAndSend("and then");
    await screen.findByRole("button", { name: defaultChatStrings.stop });
    if (handle === null) throw new Error("handle expected");
    const sink = (handle as GuueyChatHandle).viewSlotProps().onUserMessage;
    if (sink === undefined) throw new Error("message sink expected");
    const warn = console.warn;
    console.warn = () => {};
    try {
      const delivery = sink({ role: "user", content: [{ type: "text", text: "ggui_consume now" }] });
      t.release();
      expect(await delivery).toEqual({ delivered: false, reason: "chat is closed" });
    } finally {
      console.warn = warn;
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(t.calls).toHaveLength(2);
  });

  it("an A2UI press is refused: the surface says the chat is closed and nothing is sent", async () => {
    const { calls } = await closedChat(closing);
    fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    await screen.findByText(defaultChatStrings.composerUnavailable);
    expect(calls).toHaveLength(2);
  });
});

describe("one gate, said once: a suggestion chip", () => {
  it("is refused on a conversation its agent ended (read back from history): nothing is sent", async () => {
    const calls: InvokeRequest[] = [];
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => THREAD, save: () => {} },
      generateId: () => "cmid-0",
      transport: async function* (req) {
        calls.push(req);
        yield SESSION_FRAME;
        yield DONE_FRAME;
      },
      history: { load: async () => ({ messages: [], closed: CLOSED }) },
    };
    render(
      <GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={adapters} suggestions={["Plan my afternoon"]} />,
    );
    await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Plan my afternoon" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0);
  });
});
