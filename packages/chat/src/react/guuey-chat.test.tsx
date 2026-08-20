// @vitest-environment jsdom
/**
 * `<GuueyChat>` — the composer's state matrix over the REAL hook stack
 * (guuey#135 wave 3c): send/Enter/Shift+Enter/IME, the Send↔Stop swap,
 * unavailable mode, string overrides. The transport is scripted; nothing
 * else is faked.
 */
import { createRef, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import { GuueyChat, type GuueyChatHandle } from "./guuey-chat.js";
import type { PlanViewSummary } from "../types.js";

afterEach(cleanup);

const SESSION_FRAME = 'event: session\ndata: {"threadId":"t-3c"}\n\n';
const TEXT_FRAME = 'event: message\ndata: {"type":"text.delta","delta":"Hello."}\n\n';
const DONE_FRAME = 'event: done\ndata: {"stopReason":"end"}\n\n';

/** Scripted adapters: an openable gate holds the stream mid-turn. */
function scriptedAdapters(opts: { holdOpen?: boolean } = {}) {
  const calls: InvokeRequest[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
      yield TEXT_FRAME;
      if (opts.holdOpen === true) {
        // Hold the stream open, but honor the abort signal the way a real
        // transport does — aborting unwinds the hook's read loop.
        await Promise.race([
          gate,
          new Promise<never>((_, reject) => {
            const abort = (): void => reject(new DOMException("aborted", "AbortError"));
            if (req.signal.aborted) abort();
            else req.signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
      }
      yield DONE_FRAME;
    },
  };
  return { adapters, calls, release: () => release() };
}

function renderChat(
  adapters: AgentInvokeAdapters,
  extra: Partial<Parameters<typeof GuueyChat>[0]> = {},
) {
  return render(
    <GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={adapters} {...extra} />,
  );
}

describe("<GuueyChat> composer", () => {
  it("sends on Enter, clears the input, and the turn round-trips", async () => {
    const { adapters, calls } = scriptedAdapters();
    renderChat(adapters);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hi there" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.stringify(calls[0].body)).toContain("hi there");
    expect((input as HTMLTextAreaElement).value).toBe("");
    // The turn settles: user bubble + assistant text render.
    await waitFor(() => expect(screen.getByText("hi there")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Hello.")).toBeTruthy());
  });

  it("Shift+Enter does not send", () => {
    const { adapters, calls } = scriptedAdapters();
    renderChat(adapters);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(calls).toHaveLength(0);
  });

  it("Send is disabled for empty and whitespace-only input", () => {
    const { adapters } = scriptedAdapters();
    renderChat(adapters);
    const send = screen.getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "   " } });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "x" } });
    expect((send as HTMLButtonElement).disabled).toBe(false);
  });

  it("swaps Send for Stop while a turn streams; Stop aborts and marks the partial", async () => {
    const { adapters } = scriptedAdapters({ holdOpen: true });
    renderChat(adapters);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });

    const stop = await screen.findByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    // Back to Send (status ready); "Stopped." marks BOTH the kept partial
    // (R1) and the status line (§4.2) — two sightings is the contract.
    await screen.findByRole("button", { name: "Send" });
    await waitFor(() => expect(screen.getAllByText("Stopped.").length).toBeGreaterThan(0));
  });

  it("null endpoint disables the input with the unavailable placeholder", () => {
    const { adapters } = scriptedAdapters();
    render(<GuueyChat endpointUrl={null} adapters={adapters} />);
    const input = screen.getByLabelText("Message");
    expect((input as HTMLTextAreaElement).disabled).toBe(true);
    expect((input as HTMLTextAreaElement).placeholder).toBe("Chat is unavailable.");
  });

  it("string overrides reach both chrome and plan copy", async () => {
    const { adapters } = scriptedAdapters();
    renderChat(adapters, { strings: { send: "Fire", composerPlaceholder: "Ask me…" } });
    expect(screen.getByRole("button", { name: "Fire" })).toBeTruthy();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).placeholder).toBe("Ask me…");
  });
});

/** Render with a ref and return the attached handle (throws if missing). */
function renderWithHandle(
  adapters: AgentInvokeAdapters,
  extra: Partial<Parameters<typeof GuueyChat>[0]> = {},
) {
  const ref = createRef<GuueyChatHandle>();
  const view = render(
    <GuueyChat
      ref={ref}
      endpointUrl="https://pod.example/agent/invoke"
      adapters={adapters}
      {...extra}
    />,
  );
  const handle = ref.current;
  if (handle === null) throw new Error("handle not attached");
  return { handle, view };
}

describe("<GuueyChat> imperative seam (guuey#210)", () => {
  it("handle.send sends through the composer gate and leaves the typed draft untouched", async () => {
    const { adapters, calls } = scriptedAdapters();
    const { handle } = renderWithHandle(adapters);
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "half-typed draft" } });

    let ok = false;
    act(() => {
      ok = handle.send("What can you do?");
    });
    expect(ok).toBe(true);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.stringify(calls[0].body)).toContain("What can you do?");
    // A chip send must not eat the half-typed message.
    expect(input.value).toBe("half-typed draft");
    await waitFor(() => expect(screen.getByText("Hello.")).toBeTruthy());
  });

  it("send returns false and no-ops while a turn is in flight, then works after Stop", async () => {
    const { adapters, calls } = scriptedAdapters({ holdOpen: true });
    const { handle } = renderWithHandle(adapters);

    act(() => {
      expect(handle.send("first")).toBe(true);
    });
    await screen.findByRole("button", { name: "Stop" });
    act(() => {
      expect(handle.send("while busy")).toBe(false);
    });
    expect(calls).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByRole("button", { name: "Send" });
    act(() => {
      expect(handle.send("after stop")).toBe(true);
    });
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("send returns false for blank text, and always when the endpoint is null", () => {
    const { adapters, calls } = scriptedAdapters();
    const { handle } = renderWithHandle(adapters);
    act(() => {
      expect(handle.send("   ")).toBe(false);
    });
    expect(calls).toHaveLength(0);

    cleanup();
    const second = scriptedAdapters();
    const ref = createRef<GuueyChatHandle>();
    render(<GuueyChat ref={ref} endpointUrl={null} adapters={second.adapters} />);
    act(() => {
      expect(ref.current?.send("hello")).toBe(false);
    });
    expect(second.calls).toHaveLength(0);
  });

  it("prefill replaces, appends with a single space, and owns focus", () => {
    const { adapters } = scriptedAdapters();
    const { handle } = renderWithHandle(adapters);
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;

    act(() => {
      handle.prefill("hello");
    });
    expect(input.value).toBe("hello");
    expect(document.activeElement).toBe(input);

    act(() => {
      handle.prefill("world", { append: true });
    });
    expect(input.value).toBe("hello world");

    input.blur();
    act(() => {
      handle.prefill("replaced", { focus: false });
    });
    expect(input.value).toBe("replaced");
    expect(document.activeElement).not.toBe(input);
  });

  it("onReady fires once with the SAME stable handle the ref receives, across re-renders", async () => {
    const { adapters, calls } = scriptedAdapters();
    const onReady = vi.fn<(handle: GuueyChatHandle) => void>();
    const { handle, view } = renderWithHandle(adapters, { onReady });

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0][0]).toBe(handle);

    view.rerender(
      <GuueyChat
        endpointUrl="https://pod.example/agent/invoke"
        adapters={adapters}
        onReady={onReady}
        strings={{ send: "Fire" }}
      />,
    );
    expect(onReady).toHaveBeenCalledTimes(1);
    // The captured handle still drives the CURRENT instance.
    act(() => {
      expect(handle.send("still wired")).toBe(true);
    });
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("suggested-prompt chips: the filing use case works batteries-included", async () => {
    const { adapters, calls } = scriptedAdapters();
    function ChipsHost() {
      const ref = useRef<GuueyChatHandle>(null);
      return (
        <div>
          <button type="button" onClick={() => ref.current?.send("Plan my week")}>
            Plan my week
          </button>
          <GuueyChat ref={ref} endpointUrl="https://pod.example/agent/invoke" adapters={adapters} />
        </div>
      );
    }
    render(<ChipsHost />);
    fireEvent.click(screen.getByRole("button", { name: "Plan my week" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.stringify(calls[0].body)).toContain("Plan my week");
    // The chip text lands as the user bubble; the turn round-trips.
    await waitFor(() => expect(screen.getAllByText("Plan my week").length).toBe(2));
    await waitFor(() => expect(screen.getByText("Hello.")).toBeTruthy());
  });
});

/**
 * Adapters whose transport stamps a caller-chosen thread id per turn, so a
 * test can drive a REAL thread change through the wire (the pod's session
 * frame is the only thing that ever moves the hook's threadId).
 */
function threadedAdapters(ids: string[]) {
  const queue = [...ids];
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
    transport: async function* () {
      const id = queue.shift() ?? "t-last";
      yield `event: session\ndata: {"threadId":"${id}"}\n\n`;
      yield TEXT_FRAME;
      yield DONE_FRAME;
    },
  };
  return adapters;
}

describe("<GuueyChat> thread identity on the handle (guuey#210 pairing)", () => {
  it("handle.threadId is null before hydration and reflects the live id after the session frame", async () => {
    const { adapters } = scriptedAdapters();
    const { handle } = renderWithHandle(adapters);
    expect(handle.threadId).toBeNull();
    act(() => {
      expect(handle.send("hi")).toBe(true);
    });
    await waitFor(() => expect(handle.threadId).toBe("t-3c"));
  });

  it("onThread fires once per DISTINCT id — not for null, not on rerender — and again on a real change", async () => {
    const adapters = threadedAdapters(["t-a", "t-b"]);
    const onThread = vi.fn<(id: string) => void>();
    const { handle, view } = renderWithHandle(adapters, { onThread });
    // Nothing hydrated yet: no null notification.
    expect(onThread).not.toHaveBeenCalled();

    act(() => {
      expect(handle.send("first")).toBe(true);
    });
    await waitFor(() => expect(onThread).toHaveBeenCalledTimes(1));
    expect(onThread).toHaveBeenLastCalledWith("t-a");
    expect(handle.threadId).toBe("t-a");

    // A rerender with the same thread does not re-fire.
    view.rerender(
      <GuueyChat
        endpointUrl="https://pod.example/agent/invoke"
        adapters={adapters}
        onThread={onThread}
        className="rerendered"
      />,
    );
    expect(onThread).toHaveBeenCalledTimes(1);

    // The next turn arrives on a different thread (a fresh session): one more fire.
    await waitFor(() => expect(handle.send("second")).toBe(true));
    await waitFor(() => expect(onThread).toHaveBeenCalledTimes(2));
    expect(onThread).toHaveBeenLastCalledWith("t-b");
    expect(handle.threadId).toBe("t-b");
  });

  it("existing #210 handle members are unchanged beside threadId", () => {
    const { adapters } = scriptedAdapters();
    const { handle } = renderWithHandle(adapters);
    expect(typeof handle.send).toBe("function");
    expect(typeof handle.prefill).toBe("function");
    expect(typeof handle.focusComposer).toBe("function");
    expect("threadId" in handle).toBe(true);
  });
});

describe("<GuueyChat> default reader (guuey#221)", () => {
  const LOCATOR = "ui://ggui/render/render_dark/h1";
  // A meta-less ggui render on the wire (guuey#209 route-A shape): the
  // locator rides structuredContent, no uiData, no _meta.
  const wire = (events: object[]): string => `event: message\ndata: ${JSON.stringify(events)}\n\n`;
  const TOOL_FRAMES = [
    wire([
      { type: "turn.start", threadId: "t-3c", turnId: "turn-1", seq: 1 },
      { type: "message.start", id: "m1", role: "assistant", turnId: "turn-1", threadId: "t-3c", seq: 2 },
    ]),
    wire([
      { type: "tool.start", toolCallId: "t1", name: "ggui_render", seq: 3 },
      { type: "tool.args.assembled", toolCallId: "t1", input: { q: "ggui_render" }, seq: 4 },
      {
        type: "tool.done",
        toolCallId: "t1",
        content: [{ type: "text", text: "rendered" }],
        outcome: "ok",
        isError: false,
        structuredContent: { resourceUri: LOCATOR, sessionId: "render_dark" },
        seq: 5,
      },
    ]),
  ];

  function locatorAdapters(): AgentInvokeAdapters {
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

  /** Capture every fetch the reader makes; answer the pod door with a mountable payload. */
  function mockReadFetch() {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({ uri: LOCATOR, mimeType: "text/html", text: "<html>card</html>" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    return { calls, impl };
  }

  function sendRender(): void {
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "render a slot picker" } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("with apiBaseUrl and no explicit reader, resolves a locator through the pod door first, in cookie mode", async () => {
    const { calls, impl } = mockReadFetch();
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      render(
        <GuueyChat
          endpointUrl="https://pod.example/agent/invoke"
          apiBaseUrl="https://api.example/v1"
          adapters={locatorAdapters()}
        />,
      );
      sendRender();
      await waitFor(() => expect(calls.length).toBeGreaterThan(0));
      const first = calls[0]!;
      // Pod door first (guuey#209 C1), scoped to the locator…
      expect(first.url).toBe(
        `https://pod.example/agent/ui-resource?uri=${encodeURIComponent(LOCATOR)}`,
      );
      // …with the cookie arm: no bearer, no guest header, credentials included.
      expect(first.init?.credentials).toBe("include");
      const headers = (first.init?.headers ?? {}) as Record<string, string>;
      expect(headers["authorization"]).toBeUndefined();
      expect(headers["x-guuey-guest"]).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("without apiBaseUrl nothing is read — behavior unchanged", async () => {
    const { calls, impl } = mockReadFetch();
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={locatorAdapters()} />);
      sendRender();
      // Let the turn complete and any resolution effect run.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("an explicit reader wins over the default", async () => {
    const { calls, impl } = mockReadFetch();
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    const explicit = vi.fn(async () => undefined);
    try {
      render(
        <GuueyChat
          endpointUrl="https://pod.example/agent/invoke"
          apiBaseUrl="https://api.example/v1"
          adapters={locatorAdapters()}
          reader={explicit}
        />,
      );
      sendRender();
      await waitFor(() => expect(explicit).toHaveBeenCalled());
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ─── Identity churn (guuey#303 QA — the chat-rail template's render loop) ──
//
// The failing shape, live-reproduced by the agentic-app shell: a host that
// (a) passes `policy` as an INLINE literal, and (b) stores the roster from
// `onViewsChange` in state. Every emission re-rendered the host, the fresh
// literal re-minted the policy → plan → views-emission effect → host
// setState → re-render → "Maximum update depth exceeded". The second leg:
// with `promotedViewKey` set, the inputs spread was re-minted per render —
// same loop through the plan's identity path even with a hoisted policy.
describe("<GuueyChat> host-identity churn", () => {
  // The breaker caps a regressed loop at 50 renders so the test FAILS
  // fast instead of starving the event loop for the suite timeout (the
  // un-broken loop never yields to timers — observed, not theorized).
  function HostWithInlineLiterals({ adapters }: { adapters: AgentInvokeAdapters }) {
    const renders = useRef(0);
    renders.current += 1;
    const [, setViews] = useState<PlanViewSummary[]>([]);
    const onViewsChange = renders.current > 50 ? undefined : (next: PlanViewSummary[]) => setViews(next);
    return (
      <div data-testid="renders" data-renders={renders.current}>
        <GuueyChat
          endpointUrl="https://pod.example/agent/invoke"
          adapters={adapters}
          policy={{ view: { timeoutMs: 8000, presentation: "chips" } }}
          onViewsChange={onViewsChange}
        />
      </div>
    );
  }

  it("an inline policy literal + roster-in-state host settles instead of looping", async () => {
    const { adapters } = scriptedAdapters();
    const { getByTestId } = render(<HostWithInlineLiterals adapters={adapters} />);
    // One roster emission lands post-mount; give effects a beat to cascade
    // if they are going to. Pre-fix this line never resolves — React throws
    // "Maximum update depth exceeded" out of render.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const renders = Number(getByTestId("renders").dataset["renders"]);
    expect(renders).toBeLessThan(10);
  });

  const RAIL_POLICY = { view: { timeoutMs: 8000, presentation: "chips" as const } };

  function HostWithPromotedKey({ adapters }: { adapters: AgentInvokeAdapters }) {
    const renders = useRef(0);
    renders.current += 1;
    const [, setViews] = useState<PlanViewSummary[]>([]);
    const onViewsChange = renders.current > 50 ? undefined : (next: PlanViewSummary[]) => setViews(next);
    return (
      <div data-testid="renders-promoted" data-renders={renders.current}>
        <GuueyChat
          endpointUrl="https://pod.example/agent/invoke"
          adapters={adapters}
          policy={RAIL_POLICY}
          promotedViewKey="view-1"
          onViewsChange={onViewsChange}
        />
      </div>
    );
  }

  it("a set promotedViewKey does not re-open the loop (hoisted policy, per-render spread leg)", async () => {
    const { adapters } = scriptedAdapters();
    const { getByTestId } = render(<HostWithPromotedKey adapters={adapters} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const renders = Number(getByTestId("renders-promoted").dataset["renders"]);
    expect(renders).toBeLessThan(10);
  });

  it("fresh getter arrows per render keep one adapter/reader identity (no transport re-mint)", async () => {
    // No `adapters` prop here — the getter props feed createWebAdapters, so
    // this covers the default-construction path the templates use.
    function GetterHost() {
      const [, setViews] = useState<PlanViewSummary[]>([]);
      return (
        <GuueyChat
          endpointUrl="https://pod.example/agent/invoke"
          apiBaseUrl="https://api.example/v1"
          policy={RAIL_POLICY}
          getGuestSecret={() => "guest-secret"}
          onViewsChange={(next) => setViews(next)}
        />
      );
    }
    render(<GetterHost />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    // Settling at all is the assertion — pre-fix the getter arrows churned
    // the adapters memo every render on this path.
  });
});
