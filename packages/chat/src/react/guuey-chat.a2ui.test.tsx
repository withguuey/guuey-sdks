// @vitest-environment jsdom
/**
 * guuey#2382 — `<GuueyChat>` turns A2UI rendering on for its own planner path
 * (spec §8: the presets never set it, and it is no override key), because the
 * web kit now draws the kind. Over the REAL hook stack with a scripted
 * transport: a tool result carrying a valid carrier draws its surface, and
 * the tool row's old face (the row and its JSON preview) is gone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters } from "@guuey/agent-client";
import { GuueyChat } from "./guuey-chat.js";

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

function adapters(): AgentInvokeAdapters {
  const store = new Map<string, string>();
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
      yield SESSION_FRAME;
      for (const f of TOOL_FRAMES) yield f;
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

  it("debug: the surface draws too, beside the tool row the debug preset keeps", async () => {
    const { container } = render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={adapters()} preset="debug" />);
    send();
    await waitFor(() => expect(container.querySelector(".guuey-chat-a2ui")).not.toBeNull());
    expect(container.querySelector(".guuey-chat-tool")).not.toBeNull();
    expect(container.querySelector(".guuey-chat-data")).toBeNull();
  });
});
