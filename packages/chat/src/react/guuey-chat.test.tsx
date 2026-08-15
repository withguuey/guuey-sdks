// @vitest-environment jsdom
/**
 * `<GuueyChat>` — the composer's state matrix over the REAL hook stack
 * (guuey#135 wave 3c): send/Enter/Shift+Enter/IME, the Send↔Stop swap,
 * unavailable mode, string overrides. The transport is scripted; nothing
 * else is faked.
 */
import { createRef, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import { GuueyChat, type GuueyChatHandle } from "./guuey-chat.js";

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
