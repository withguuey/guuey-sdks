// @vitest-environment jsdom
/**
 * guuey#2382 — `<GuueyChat>` turns A2UI rendering on for its own planner path
 * (spec §8: the presets never set it, and it is no override key), because the
 * web kit now draws the kind. Over the REAL hook stack with a scripted
 * transport: a tool result carrying a valid carrier draws its surface, and
 * the tool row's old face (the row and its JSON preview) is gone.
 */
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters } from "@guuey/agent-client";
import { defaultChatStrings } from "../strings.js";
import { GuueyChat, type GuueyChatHandle } from "./guuey-chat.js";

afterEach(cleanup);

const V = "v0.9";
const SESSION_FRAME = 'event: session\ndata: {"threadId":"t-a2ui"}\n\n';
const DONE_FRAME = 'event: done\ndata: {"stopReason":"end"}\n\n';
const wire = (events: object[]): string => `event: message\ndata: ${JSON.stringify(events)}\n\n`;

const CARRIER = {
  format: "a2ui",
  version: V,
  messages: [
    { version: V, createSurface: { surfaceId: "order", catalogId: "guuey.a2ui.v1", title: "Your order" } },
    {
      version: V,
      updateComponents: {
        surfaceId: "order",
        components: [
          { id: "root", component: "Column", children: ["name", "go"] },
          { id: "name", component: "TextField", label: "Name", value: { path: "/name" } },
          { id: "go", component: "Button", label: "Place order", action: { name: "submit" } },
        ],
      },
    },
  ],
};

const TOOL_FRAMES = [
  wire([
    { type: "turn.start", threadId: "t-a2ui", turnId: "turn-1", seq: 1 },
    { type: "message.start", id: "m1", role: "assistant", turnId: "turn-1", threadId: "t-a2ui", seq: 2 },
  ]),
  wire([
    { type: "tool.start", toolCallId: "t1", name: "show_order_form", seq: 3 },
    { type: "tool.args.assembled", toolCallId: "t1", input: {}, seq: 4 },
    {
      type: "tool.done",
      toolCallId: "t1",
      content: [{ type: "text", text: "form shown" }],
      outcome: "ok",
      isError: false,
      structuredContent: { "com.guuey/a2ui": CARRIER },
      seq: 5,
    },
  ]),
];

const CLOSED = { code: "app:CHAT_FULL", message: "This chat is full.", closedAt: "2026-10-15T00:00:00.000Z" };

/** Every turn draws the same form (same call id, same surface); `closeFirst` ends the first conversation after it. */
function adapters(opts: { closeFirst?: boolean } = {}): AgentInvokeAdapters {
  const store = new Map<string, string>();
  let calls = 0;
  return {
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
    transport: async function* () {
      calls++;
      yield SESSION_FRAME;
      for (const f of TOOL_FRAMES) yield f;
      if (opts.closeFirst === true && calls === 1) {
        yield `event: error\ndata: ${JSON.stringify({ code: CLOSED.code, message: CLOSED.message, threadClosed: CLOSED })}\n\n`;
        yield `event: done\ndata: ${JSON.stringify({ stopReason: "end_turn", threadId: "t-a2ui", threadClosed: CLOSED })}\n\n`;
        return;
      }
      yield DONE_FRAME;
    },
  };
}

function send(): void {
  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: "order please" } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("<GuueyChat> draws A2UI surfaces (guuey#2382)", () => {
  it("calm: the surface draws, the tool row and its JSON preview are gone", async () => {
    const { container } = render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={adapters()} />);
    send();
    await waitFor(() => expect(container.querySelector(".guuey-chat-a2ui")).not.toBeNull());
    const surface = container.querySelector<HTMLElement>(".guuey-chat-a2ui")!;
    expect(surface.querySelector(".guuey-chat-a2ui-title")?.textContent).toBe("Your order");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
    // No action path yet: the press is drawn disabled, never a dead button.
    expect((screen.getByRole("button", { name: "Place order" }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector(".guuey-chat-tool")).toBeNull();
    expect(container.querySelector(".guuey-chat-data")).toBeNull();
    expect(container.textContent).not.toContain("com.guuey/a2ui");
  });

  it("a host can turn it off: policy {a2ui:{render:false}} plans the carrier as today's tool row", async () => {
    const { container } = render(
      <GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={adapters()} policy={{ a2ui: { render: false } }} />,
    );
    send();
    await waitFor(() => expect(container.querySelector(".guuey-chat-tool")).not.toBeNull());
    expect(container.querySelector(".guuey-chat-a2ui")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  it("debug: the surface draws too, beside the tool row the debug preset keeps", async () => {
    const { container } = render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={adapters()} preset="debug" />);
    send();
    await waitFor(() => expect(container.querySelector(".guuey-chat-a2ui")).not.toBeNull());
    expect(container.querySelector(".guuey-chat-tool")).not.toBeNull();
    expect(container.querySelector(".guuey-chat-data")).toBeNull();
  });
});

/**
 * "The device holds nothing of the conversation": a value typed into a
 * surface is conversation state, so Clear and New conversation forget it.
 * The next conversation draws the same surface (same call id, same surface
 * id, same empty model) and must not show it.
 */
describe("<GuueyChat> forgets A2UI edits with the conversation (guuey#2382)", () => {
  const nameBox = () => screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;

  it("Clear conversation: the typed value does not carry into the next conversation", async () => {
    const ref = createRef<GuueyChatHandle>();
    const { container } = render(<GuueyChat ref={ref} endpointUrl="https://pod.example/agent/invoke" adapters={adapters()} />);
    send();
    await waitFor(() => expect(container.querySelector(".guuey-chat-a2ui")).not.toBeNull());
    fireEvent.change(nameBox(), { target: { value: "alice@x.example" } });
    expect(nameBox().value).toBe("alice@x.example");
    act(() => ref.current!.clearConversation());
    expect(container.querySelector(".guuey-chat-a2ui")).toBeNull();
    send();
    await waitFor(() => expect(container.querySelector(".guuey-chat-a2ui")).not.toBeNull());
    expect(nameBox().value).toBe("");
  });

  it("New conversation: the typed value does not carry into the next conversation", async () => {
    const { container } = render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={adapters({ closeFirst: true })} />);
    send();
    await waitFor(() => expect(screen.getByText(defaultChatStrings.threadClosedTitle)).toBeTruthy());
    fireEvent.change(nameBox(), { target: { value: "alice@x.example" } });
    expect(nameBox().value).toBe("alice@x.example");
    fireEvent.click(screen.getByRole("button", { name: defaultChatStrings.threadClosedStartNew }));
    await waitFor(() => expect(container.querySelector(".guuey-chat-a2ui")).toBeNull());
    send();
    await waitFor(() => expect(container.querySelector(".guuey-chat-a2ui")).not.toBeNull());
    expect(nameBox().value).toBe("");
  });
});
