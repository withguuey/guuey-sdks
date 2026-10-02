// @vitest-environment jsdom
/**
 * `<GuueyChat analytics>` — the inline chat's usage events over the REAL hook
 * stack: one composer focus → `helper_opened`, two sends → turns 1 and 2, a
 * click on a transcript link → `helper_cta_clicked`, a host-owned input's
 * `markOpened` and `handle.send` count the same, and without the prop the
 * same embed emits nothing. The transport is scripted; nothing else is faked.
 */
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import { GuueyChat, type GuueyChatHandle } from "./guuey-chat.js";
import type { ChatAnalyticsSink } from "../analytics.js";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "posthog");
});

const SESSION_FRAME = 'event: session\ndata: {"threadId":"t-an"}\n\n';
const LINK_FRAME =
  'event: message\ndata: {"type":"text.delta","delta":"See [Pricing](https://guuey.com/pricing?email=a%40b.c#plans)."}\n\n';
const DONE_FRAME = 'event: done\ndata: {"stopReason":"end"}\n\n';

function scriptedAdapters() {
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
      yield SESSION_FRAME;
      yield LINK_FRAME;
      yield DONE_FRAME;
    },
  };
  return { adapters, calls };
}

async function sendFromComposer(text: string, expectedCalls: number, calls: InvokeRequest[]): Promise<void> {
  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(calls).toHaveLength(expectedCalls));
  await screen.findByRole("button", { name: "Send" });
}

describe("<GuueyChat analytics>", () => {
  it("focus → opened once; two sends → turns 1, 2; a transcript link click → cta (origin + path); never text", async () => {
    const { adapters, calls } = scriptedAdapters();
    const sink = vi.fn<ChatAnalyticsSink>();
    render(
      <GuueyChat endpointUrl="https://pod.example/agent/invoke" appId="app_1" adapters={adapters} analytics={sink} />,
    );
    const input = screen.getByLabelText("Message");
    fireEvent.focus(input);
    fireEvent.focus(input);
    await sendFromComposer("my secret question", 1, calls);
    await sendFromComposer("another private one", 2, calls);
    const link = await waitFor(() => {
      const found = screen.getAllByRole("link", { name: "Pricing" });
      expect(found.length).toBeGreaterThan(0);
      return found[0]!;
    });
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);

    expect(sink.mock.calls).toEqual([
      ["helper_opened", { app_id: "app_1", surface: "inline", gui: "on" }],
      ["helper_message_sent", { app_id: "app_1", turn: 1, surface: "inline", gui: "on" }],
      ["helper_message_sent", { app_id: "app_1", turn: 2, surface: "inline", gui: "on" }],
      ["helper_cta_clicked", { app_id: "app_1", cta: "https://guuey.com/pricing", surface: "inline", gui: "on" }],
    ]);
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/secret|private|email/);
  });

  it("a host-owned input (composer off): markOpened → opened, handle.send counts the turn, a refused send does not", async () => {
    const { adapters, calls } = scriptedAdapters();
    const sink = vi.fn<ChatAnalyticsSink>();
    const ref = createRef<GuueyChatHandle>();
    render(
      <GuueyChat
        ref={ref}
        endpointUrl="https://pod.example/agent/invoke"
        appId="app_1"
        adapters={adapters}
        composer={false}
        analytics={{ capture: sink, gguiEnabled: false }}
      />,
    );
    act(() => {
      ref.current?.markOpened();
      ref.current?.markOpened();
    });
    let accepted = false;
    act(() => {
      accepted = ref.current?.send("hello") ?? false;
    });
    expect(accepted).toBe(true);
    // Mid-turn: the gate refuses, and a refused send is not a turn.
    act(() => {
      expect(ref.current?.send("again")).toBe(false);
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(sink.mock.calls).toEqual([
      ["helper_opened", { app_id: "app_1", surface: "inline", gui: "off" }],
      ["helper_message_sent", { app_id: "app_1", turn: 1, surface: "inline", gui: "off" }],
    ]);
  });

  it("`analytics` true captures on the host page's window.posthog, as a method", async () => {
    const { adapters, calls } = scriptedAdapters();
    const received: unknown[][] = [];
    const client = {
      capture(this: unknown, ...args: unknown[]) {
        expect(this).toBe(client);
        received.push(args);
      },
    };
    Reflect.set(globalThis, "posthog", client);
    render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" appId="app_1" adapters={adapters} analytics />);
    await sendFromComposer("hi", 1, calls);
    expect(received.map((args) => args[0])).toEqual(["helper_opened", "helper_message_sent"]);
  });

  it("without the prop (or without an app id) the same embed emits nothing", async () => {
    const capture = vi.fn();
    Reflect.set(globalThis, "posthog", { capture });
    const first = scriptedAdapters();
    render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" appId="app_1" adapters={first.adapters} />);
    fireEvent.focus(screen.getByLabelText("Message"));
    await sendFromComposer("hi", 1, first.calls);
    fireEvent.click((await screen.findAllByRole("link", { name: "Pricing" }))[0]!);
    cleanup();
    const second = scriptedAdapters();
    render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={second.adapters} analytics />);
    await sendFromComposer("hi", 1, second.calls);
    expect(capture).not.toHaveBeenCalled();
  });
});
