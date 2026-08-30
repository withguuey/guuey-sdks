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
import { GuueyChat, viewPropsWithThemeAnnounce, type GuueyChatHandle } from "./guuey-chat.js";
import type { PlanViewSummary, ViewMountItem } from "../types.js";
import type { ResolvedViewMount } from "@guuey/mcp-apps-host";

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

describe("<GuueyChat> zero-effort native look (guuey#521)", () => {
  it("composer={false} renders no composer form — the imperative handle is the input", () => {
    const { adapters } = scriptedAdapters();
    const { container } = renderChat(adapters, { composer: false });
    expect(container.querySelector(".guuey-chat-composer")).toBeNull();
    expect(container.querySelector(".guuey-chat")).not.toBeNull();
  });

  it("the composer renders by default", () => {
    const { adapters } = scriptedAdapters();
    const { container } = renderChat(adapters);
    expect(container.querySelector(".guuey-chat-composer")).not.toBeNull();
  });

  it("surface='bare' reaches the transcript root through <GuueyChat>", () => {
    const { adapters } = scriptedAdapters();
    const { container } = renderChat(adapters, { surface: "bare" });
    expect(container.querySelector(".guuey-chat")?.className).toContain("guuey-chat--bare");
  });
});

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

  it("a HISTORY card through the DEFAULT reader never dials the pod door (guuey#421 — the dropped-hints hole)", async () => {
    // The live-capture find: the default-reader WRAPPER took only
    // `resourceUri`, silently dropping the hints param — so the inner
    // reader never learned `origin: "history"` and pod-dialed every
    // old-conversation load (the 404 pair, pod warm/cold dependent).
    // This pin drives the REAL wrapper: a rehydrated card must resolve
    // through the PLATFORM door alone.
    const { calls, impl } = mockReadFetch();
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    const adapters = locatorAdapters();
    // Seed a persisted thread + a history adapter returning one card.
    await adapters.storage.save("guuey:thread:app-h", "t-hist");
    adapters.history = {
      load: async () => ({
        messages: [{ role: "user", text: "earlier" }],
        cards: [
          {
            seq: 1,
            at: "2026-08-26T00:00:00Z",
            cardSnapshot: {
              parts: [
                { type: "tool-result", toolCallId: "c1", content: [], uiData: { resourceUri: LOCATOR } },
              ],
            },
          },
        ],
      }),
    };
    try {
      render(
        <GuueyChat
          endpointUrl="https://pod.example/agent/invoke"
          apiBaseUrl="https://api.example/v1"
          appId="app-h"
          adapters={adapters}
        />,
      );
      await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
      for (const c of calls) {
        expect(c.url).not.toContain("pod.example"); // NEVER the pod door
        expect(c.url).toContain("/threads/t-hist/ui-resource"); // platform only
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("without apiBaseUrl the POD door still reads — the pod-only default (guuey#368)", async () => {
    // The old pin here asserted zero reads ("behavior unchanged") — that
    // WAS the docs-lab bug: an endpoint-only surface (the guuey dev
    // scaffold) starved the pod door to zero requests and every live card
    // expired. The default reader is now pod-only-legal.
    const { calls, impl } = mockReadFetch();
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={locatorAdapters()} />);
      sendRender();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]!.url).toContain("https://pod.example/agent/ui-resource?uri=");
      // Pod-only: no half-built platform URL is ever guessed at.
      for (const c of calls) expect(c.url).not.toContain("/threads/");
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

// ─── The kit-tier theme announce (guuey#302) ───────────────────────────────
describe("viewPropsWithThemeAnnounce", () => {
  it("fills hostContext.theme from the mode when the host passes nothing", () => {
    const out = viewPropsWithThemeAnnounce(undefined, "dark");
    expect(out).toEqual({ hostContext: { theme: "dark" } });
  });

  it("merges under a static viewProps object — other keys pass through, theme fills in", () => {
    const out = viewPropsWithThemeAnnounce({ autoResize: true, hostContext: { locale: "de" } }, "light");
    expect(out).toEqual({ autoResize: true, hostContext: { theme: "light", locale: "de" } });
  });

  it("a caller-declared theme WINS over the mode default", () => {
    const out = viewPropsWithThemeAnnounce({ hostContext: { theme: "dark" } }, "light");
    expect(out).toEqual({ hostContext: { theme: "dark" } });
  });

  it("wraps the FUNCTION form — per-item results get the same merge", () => {
    const wrapped = viewPropsWithThemeAnnounce(() => ({ autoResize: true }), "dark");
    expect(typeof wrapped).toBe("function");
    if (typeof wrapped !== "function") throw new Error("unreachable");
    const mount: ResolvedViewMount = {
      channel: "inline",
      resource: { uri: "ui://tool/card", mimeType: "text/html", text: "<p>card</p>" },
    };
    const item: ViewMountItem = {
      kind: "view",
      key: "view.k",
      expanded: true,
      mount,
      channel: "inline",
      phase: "negotiating",
      label: null,
      diagnosis: null,
      attribution: null,
      toolTitle: "show card",
      actionScope: null,
    };
    expect(wrapped(item, mount)).toEqual({
      autoResize: true,
      hostContext: { theme: "dark" },
    });
  });
});

// ─── Kit-default host wiring (guuey#335 — the founder-hit Confirm bug) ─────
describe("kit-default view-host wiring (guuey#335)", () => {
  it("viewPropsWithThemeAnnounce fills the default wires; caller-declared slots win", () => {
    const kitRelay = async () => ({ content: [] });
    const kitSink = () => {};
    const out = viewPropsWithThemeAnnounce(undefined, "light", {
      onCallTool: kitRelay,
      onUpdateModelContext: kitSink,
    });
    expect(out).toEqual({
      onCallTool: kitRelay,
      onUpdateModelContext: kitSink,
      hostContext: { theme: "light" },
    });

    const own = async () => ({ content: [] });
    const withOwn = viewPropsWithThemeAnnounce({ onCallTool: own }, "light", {
      onCallTool: kitRelay,
      onUpdateModelContext: kitSink,
    });
    if (typeof withOwn === "function") throw new Error("static in, static out");
    expect(withOwn?.onCallTool).toBe(own);
    expect(withOwn?.onUpdateModelContext).toBe(kitSink);
  });

  it("handle.viewSlotProps() hands a canvas host the relay + sink + theme announce", async () => {
    const { adapters } = scriptedAdapters();
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      apiBaseUrl: "https://api.example/v1",
      mode: "dark",
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    const slot = handle!.viewSlotProps();
    expect(typeof slot.onCallTool).toBe("function");
    expect(typeof slot.onUpdateModelContext).toBe("function");
    expect(slot.hostContext).toEqual({ theme: "dark" });
  });

  it("without apiBaseUrl there is no default relay — the slot stays honest", async () => {
    const { adapters } = scriptedAdapters();
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    expect(handle!.viewSlotProps().onCallTool).toBeUndefined();
    expect(typeof handle!.viewSlotProps().onUpdateModelContext).toBe("function");
  });

  it("the default model-context sink records to the debug surface (fact + size, not payload)", async () => {
    const { adapters } = scriptedAdapters();
    const events: Array<{ type: string }> = [];
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      apiBaseUrl: "https://api.example/v1",
      preset: "debug",
      onDebugEvent: (e) => events.push(e),
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    const sink = handle!.viewSlotProps().onUpdateModelContext;
    if (sink === undefined) throw new Error("sink expected");
    sink({ structuredContent: { slot: "tuesday-3pm" } });
    const recorded = events.find((e) => e.type === "model-context-update");
    expect(recorded).toEqual({
      type: "model-context-update",
      byteSize: JSON.stringify({ structuredContent: { slot: "tuesday-3pm" } }).length,
    });
  });
});

// ─── Post-turn actions RELAY; ui/message starts the turn (guuey#422) ──────
describe("kit defaults — relay-through + the ui/message doorbell (guuey#422)", () => {
  it("an idle semantic card action RELAYS (no staging): pre-thread it answers the honest in-band unavailable, composer untouched", async () => {
    const { adapters } = scriptedAdapters();
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      apiBaseUrl: "https://api.example/v1",
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    const onCallTool = handle!.viewSlotProps().onCallTool;
    if (onCallTool === undefined) throw new Error("default relay expected");
    const result = await onCallTool({
      resourceUri: "ui://x/1",
      name: "ggui_runtime_submit_action",
      arguments: { actionId: "selectSlot", slot: "9am" },
    });
    // No thread yet ⇒ the relay's in-band unavailable — a RESULT envelope
    // the #440 classifier can grade, never the staged text acceptance.
    expect(result.isError).toBe(true);
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(input.value).toBe("");
  });

  it("the ui/message sink sends the doorbell text through the composer gate — a real turn starts", async () => {
    const { adapters, calls } = scriptedAdapters();
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      apiBaseUrl: "https://api.example/v1",
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    const sink = handle!.viewSlotProps().onUserMessage;
    if (sink === undefined) throw new Error("message sink expected");
    sink({
      role: "user",
      content: [{ type: "text", text: "Your REQUIRED FIRST TOOL CALL is ggui_consume…" }],
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.stringify(calls[0].body)).toContain("ggui_consume");
  });

  it("the doorbell is gate-respecting: empty content or unavailable chat sends nothing", async () => {
    const { adapters, calls } = scriptedAdapters();
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      apiBaseUrl: "https://api.example/v1",
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    const sink = handle!.viewSlotProps().onUserMessage;
    if (sink === undefined) throw new Error("message sink expected");
    sink({ role: "user", content: [] });
    sink({ role: "user", content: "not-an-array" });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0);
  });

  // ── Queue-and-drain (guuey#422 close-condition 1, ggui review): the
  // machine ACKs the doorbell BEFORE delivery, so a busy drop would be an
  // ACKed-then-silently-dropped message. The sink queues instead and the
  // idle transition drains — and the one genuinely undrainable case
  // (unavailable chat) is LOUD, never silent.
  it("a doorbell during a live turn QUEUES and drains on idle — never silently dropped", async () => {
    const { adapters, calls } = scriptedAdapters({ holdOpen: true });
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      apiBaseUrl: "https://api.example/v1",
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    const sink = handle!.viewSlotProps().onUserMessage;
    if (sink === undefined) throw new Error("message sink expected");

    act(() => {
      expect(handle!.send("first")).toBe(true);
    });
    await screen.findByRole("button", { name: "Stop" });
    sink({
      role: "user",
      content: [{ type: "text", text: "Your REQUIRED FIRST TOOL CALL is ggui_consume…" }],
    });
    // Queued, not sent, not dropped: still exactly the live turn's call.
    expect(calls).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    // Idle transition drains the queued doorbell as a real send.
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(JSON.stringify(calls[1].body)).toContain("ggui_consume");
  });

  it("repeat doorbells while busy collapse to ONE drain (exact-text dedupe — the consume pipe holds the gestures)", async () => {
    const { adapters, calls } = scriptedAdapters({ holdOpen: true });
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      apiBaseUrl: "https://api.example/v1",
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    const sink = handle!.viewSlotProps().onUserMessage;
    if (sink === undefined) throw new Error("message sink expected");

    act(() => {
      expect(handle!.send("first")).toBe(true);
    });
    await screen.findByRole("button", { name: "Stop" });
    const doorbell = {
      role: "user",
      content: [{ type: "text", text: "Your REQUIRED FIRST TOOL CALL is ggui_consume…" }],
    };
    sink(doorbell);
    sink(doorbell);
    sink(doorbell);
    expect(calls).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    // The drained send starts a fresh held turn; no further drain follows
    // once THAT settles — the queue held one entry, not three.
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(2);
  });

  it("onActivity fires the per-turn edges — submit on send, settled on turn end; never per token (guuey#403)", async () => {
    const { adapters, calls } = scriptedAdapters();
    const events: Array<"submit" | "settled"> = [];
    renderChat(adapters, { onActivity: (e) => events.push(e.type) });
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hi there" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("Hello.")).toBeTruthy());
    await waitFor(() => expect(events).toEqual(["submit", "settled"]));
  });

  it("an unavailable chat drops the doorbell LOUDLY (console.warn), never silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { adapters, calls } = scriptedAdapters();
      let handle: GuueyChatHandle | null = null;
      renderChat(adapters, {
        endpointUrl: null,
        apiBaseUrl: "https://api.example/v1",
        onReady: (h) => {
          handle = h;
        },
      });
      await waitFor(() => expect(handle).not.toBeNull());
      const sink = handle!.viewSlotProps().onUserMessage;
      if (sink === undefined) throw new Error("message sink expected");
      sink({ role: "user", content: [{ type: "text", text: "ggui_consume now" }] });
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("doorbell dropped"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("ui/open-link — the kit's disclosure affordance (guuey#522)", () => {
  it("the default sink SURFACES the URL — host label, full URL, a real anchor with the safety rel; nothing auto-opens", async () => {
    const { adapters } = scriptedAdapters();
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    const sink = handle!.viewSlotProps().onOpenLink;
    if (typeof sink !== "function") throw new Error("default open-link sink expected");
    act(() => sink("https://docs.guuey.com/hosting"));
    expect(screen.getByText("This card wants to open docs.guuey.com")).toBeTruthy();
    expect(screen.getByText("https://docs.guuey.com/hosting")).toBeTruthy();
    const open = screen.getByRole("link", { name: "Open" });
    expect(open.getAttribute("href")).toBe("https://docs.guuey.com/hosting");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("Open and Dismiss both clear the ask; a newer ask REPLACES the pending one (anti-spam cap of one)", async () => {
    const { adapters } = scriptedAdapters();
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    const sink = handle!.viewSlotProps().onOpenLink;
    if (typeof sink !== "function") throw new Error("default open-link sink expected");
    act(() => sink("https://a.example/1"));
    act(() => sink("https://b.example/2"));
    // Newest replaces — only one ask ever pending.
    expect(screen.queryByText("https://a.example/1")).toBeNull();
    expect(screen.getByText("https://b.example/2")).toBeTruthy();
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByText("https://b.example/2")).toBeNull();
    act(() => sink("https://c.example/3"));
    fireEvent.click(screen.getByRole("link", { name: "Open" }));
    expect(screen.queryByText("https://c.example/3")).toBeNull();
  });

  it("a host-declared onOpenLink wins over the kit default (the slot-prop precedence rule)", async () => {
    const { adapters } = scriptedAdapters();
    const custom = vi.fn();
    let handle: GuueyChatHandle | null = null;
    renderChat(adapters, {
      viewProps: { onOpenLink: custom },
      onReady: (h) => {
        handle = h;
      },
    });
    await waitFor(() => expect(handle).not.toBeNull());
    expect(handle!.viewSlotProps().onOpenLink).toBe(custom);
  });
});

describe("forget this device — clearConversation + the guest affordance (guuey#526)", () => {
  it("handle.clearConversation forgets everything on-device: transcript, pointer, storage key, draft; the next send mints fresh", async () => {
    const { adapters, calls } = scriptedAdapters();
    const { handle } = renderWithHandle(adapters);
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("Hello.")).toBeTruthy());
    expect(handle.threadId).toBe("t-3c");
    fireEvent.change(input, { target: { value: "half-typed secret" } });

    act(() => handle.clearConversation());
    expect(handle.threadId).toBeNull();
    expect(screen.queryByText("Hello.")).toBeNull();
    expect(input.value).toBe(""); // the draft is part of the record
    // The next send mints a FRESH thread: the request body carries no
    // threadId (the durable pointer is gone, storage emptied).
    fireEvent.change(input, { target: { value: "fresh start" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(JSON.stringify(calls[1].body)).not.toContain("t-3c");
  });

  it("the affordance is guest-gated by default, two-tap, and opt-out-able", async () => {
    const { adapters, calls } = scriptedAdapters();
    // Guest mode + a message on screen → the affordance renders.
    const view = renderChat(adapters, { getGuestSecret: () => "0".repeat(64) });
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("Hello.")).toBeTruthy());
    const clear = screen.getByRole("button", { name: "Clear conversation" });
    // Tap 1 arms; tap 2 clears.
    fireEvent.click(clear);
    expect(screen.getByRole("button", { name: "Tap again to clear this device" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tap again to clear this device" }));
    expect(screen.queryByText("Hello.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear conversation|Tap again/ })).toBeNull();

    // Opt-out beats the guest default.
    view.rerender(
      <GuueyChat
        endpointUrl="https://pod.example/agent/invoke"
        adapters={adapters}
        getGuestSecret={() => "0".repeat(64)}
        clearAffordance={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /Clear conversation/ })).toBeNull();
  });

  it("no guest secret (signed-in surface) → no affordance by default; clearAffordance={true} forces it on", async () => {
    const { adapters, calls } = scriptedAdapters();
    const view = renderChat(adapters);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /Clear conversation/ })).toBeNull();
    view.rerender(
      <GuueyChat
        endpointUrl="https://pod.example/agent/invoke"
        adapters={adapters}
        clearAffordance={true}
      />,
    );
    expect(screen.getByRole("button", { name: "Clear conversation" })).toBeTruthy();
  });
});

describe("clearConversation server fold-in — DELETE + rotation (guuey#526 ask 3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires DELETE /threads/:id with the PRE-rotation guest secret, then rotates — and the debug line says deleted", async () => {
    const deletes: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      (async (url: unknown, init?: RequestInit) => {
        deletes.push({ url: String(url), init });
        return new Response('{"deleted":true,"threadId":"t-3c"}', { status: 200 });
      }) as typeof fetch,
    );
    const { adapters, calls } = scriptedAdapters();
    let secret = "1".repeat(64);
    const rotations: string[] = [];
    const debugEvents: Array<{ type: string; outcome?: string }> = [];
    const { handle } = renderWithHandle(adapters, {
      apiBaseUrl: "https://api.example/v1",
      getGuestSecret: () => secret,
      onGuestSecretRotate: () => {
        rotations.push(secret);
        secret = "2".repeat(64); // the host mints fresh — synchronously, like the widget would
      },
      onDebugEvent: (e) => debugEvents.push(e as { type: string; outcome?: string }),
    });
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(handle.threadId).toBe("t-3c"));

    act(() => handle.clearConversation());
    // The delete was dispatched against the platform door, method DELETE,
    // carrying the OLD identity — rotation already swapped the getter's
    // value, so a post-rotation read here would be "2…" (the 403 bug the
    // contract's capture-first rule exists to prevent).
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toBe("https://api.example/v1/threads/t-3c");
    expect(deletes[0].init?.method).toBe("DELETE");
    expect((deletes[0].init?.headers as Record<string, string>)["x-guuey-guest"]).toBe("1".repeat(64));
    expect(rotations).toEqual(["1".repeat(64)]); // rotated exactly once, after dispatch
    expect(handle.threadId).toBeNull(); // local clear never waited on the wire
    await waitFor(() =>
      expect(debugEvents).toContainEqual({ type: "thread-delete", threadId: "t-3c", outcome: "deleted" }),
    );
  });

  it("no platform door (no apiBaseUrl) → no fetch, outcome 'skipped', local clear + rotation still run", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    const { adapters, calls } = scriptedAdapters();
    const rotations: number[] = [];
    const debugEvents: Array<{ type: string; outcome?: string }> = [];
    const { handle } = renderWithHandle(adapters, {
      getGuestSecret: () => "3".repeat(64),
      onGuestSecretRotate: () => rotations.push(1),
      onDebugEvent: (e) => debugEvents.push(e as { type: string; outcome?: string }),
    });
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(handle.threadId).toBe("t-3c"));

    act(() => handle.clearConversation());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(handle.threadId).toBeNull();
    expect(rotations).toHaveLength(1);
    expect(debugEvents).toContainEqual({ type: "thread-delete", threadId: "t-3c", outcome: "skipped" });
  });

  it("a denied delete still clears the device (the unlinkability fallback) — nothing louder than the debug line", async () => {
    vi.stubGlobal(
      "fetch",
      (async () => new Response("{}", { status: 403 })) as typeof fetch,
    );
    const { adapters, calls } = scriptedAdapters();
    const debugEvents: Array<{ type: string; outcome?: string }> = [];
    const { handle } = renderWithHandle(adapters, {
      apiBaseUrl: "https://api.example/v1",
      getGuestSecret: () => "4".repeat(64),
      onDebugEvent: (e) => debugEvents.push(e as { type: string; outcome?: string }),
    });
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("Hello.")).toBeTruthy());

    act(() => handle.clearConversation());
    expect(screen.queryByText("Hello.")).toBeNull(); // cleared regardless
    expect(handle.threadId).toBeNull();
    await waitFor(() =>
      expect(debugEvents).toContainEqual({ type: "thread-delete", threadId: "t-3c", outcome: "denied" }),
    );
    // Nothing louder: no error row appeared for the failed erasure.
    expect(screen.queryByText(/went wrong|couldn't|failed/i)).toBeNull();
  });
});
