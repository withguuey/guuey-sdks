// @vitest-environment jsdom
/**
 * The `::part()` contract (guuey#1152, half i-a): every name in `PARTS` is
 * stamped on a rendered `<GuueyChat>` — the shadow-root host (the widget
 * loader's inline transcript) restyles through these, so a missing one is
 * a broken host stylesheet, not a cosmetic drift. Rendered over the REAL
 * hook stack with a scripted transport, exactly like `guuey-chat.test.tsx`;
 * the transcript needs one turn so both message roles exist.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import { GuueyChat } from "./guuey-chat.js";
import { PARTS, messagePart } from "./parts.js";

afterEach(cleanup);

const SESSION_FRAME = 'event: session\ndata: {"threadId":"t-parts"}\n\n';
const TEXT_FRAME = 'event: message\ndata: {"type":"text.delta","delta":"Hello."}\n\n';
const DONE_FRAME = 'event: done\ndata: {"stopReason":"end"}\n\n';

function scriptedAdapters(opts: { hold?: Promise<void> } = {}): {
  adapters: AgentInvokeAdapters;
  calls: InvokeRequest[];
} {
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
      if (opts.hold !== undefined) await opts.hold;
      yield TEXT_FRAME;
      yield DONE_FRAME;
    },
  };
  return { adapters, calls };
}

/** `[part~="name"]` — the token-list match a `::part()` selector performs. */
function byPart(container: HTMLElement, name: string): Element | null {
  return container.querySelector(`[part~="${name}"]`);
}

describe("the ::part() contract (guuey#1152)", () => {
  it("every PARTS name is present on a rendered <GuueyChat> with a header, one turn and chips", async () => {
    const { adapters, calls } = scriptedAdapters();
    const { container } = render(
      <GuueyChat
        endpointUrl="https://pod.example/agent/invoke"
        adapters={adapters}
        header={{ title: "Rep" }}
        suggestions={["What is Guuey?", "Pricing?"]}
      />,
    );
    // Empty transcript: surface, header, transcript, chips, composer are already there.
    expect(byPart(container, PARTS.surface)?.className).toContain("guuey-chat-surface");
    expect(byPart(container, PARTS.header)?.tagName).toBe("HEADER");
    expect(byPart(container, PARTS.transcript)?.className).toContain("guuey-chat");
    expect(byPart(container, PARTS.chips)?.tagName).toBe("NAV");
    expect(container.querySelectorAll(`[part~="${PARTS.chip}"]`)).toHaveLength(2);
    expect(byPart(container, PARTS.composer)?.tagName).toBe("FORM");
    expect(byPart(container, PARTS.composerInput)?.tagName).toBe("TEXTAREA");
    expect(byPart(container, PARTS.composerSend)?.textContent).toBe("Send");
    expect(byPart(container, PARTS.composerStop)).toBeNull();
    expect(byPart(container, PARTS.message)).toBeNull();

    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hi there" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("Hello.")).toBeTruthy());

    // Both roles carry `message` plus their own token — one selector for
    // all messages, one per side.
    const messages = container.querySelectorAll(`[part~="${PARTS.message}"]`);
    expect(messages).toHaveLength(2);
    expect(byPart(container, PARTS.user)?.getAttribute("part")).toBe(messagePart("user"));
    expect(byPart(container, PARTS.user)?.textContent).toContain("hi there");
    expect(byPart(container, PARTS.agent)?.getAttribute("part")).toBe(messagePart("agent"));
    expect(byPart(container, PARTS.agent)?.textContent).toContain("Hello.");
  });

  it("while a turn is in flight the Stop button carries composer-stop (Send's slot, its own name)", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapters, calls } = scriptedAdapters({ hold });
    const { container } = render(
      <GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={adapters} />,
    );
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(byPart(container, PARTS.composerStop)?.textContent).toBe("Stop"));
    expect(byPart(container, PARTS.composerSend)).toBeNull();
    release();
    await waitFor(() => expect(byPart(container, PARTS.composerSend)).not.toBeNull());
  });

  it("composer={false} drops the composer parts; no chips / no header → no such parts (absence is honest)", () => {
    const { adapters } = scriptedAdapters();
    const { container } = render(
      <GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={adapters} composer={false} />,
    );
    expect(byPart(container, PARTS.composer)).toBeNull();
    expect(byPart(container, PARTS.composerInput)).toBeNull();
    expect(byPart(container, PARTS.composerSend)).toBeNull();
    expect(byPart(container, PARTS.chips)).toBeNull();
    expect(byPart(container, PARTS.header)).toBeNull();
    expect(byPart(container, PARTS.surface)).not.toBeNull();
    expect(byPart(container, PARTS.transcript)).not.toBeNull();
  });

  it("the table is closed: exactly these names, each value a hyphenated lowercase token", () => {
    expect(Object.keys(PARTS).sort()).toEqual(
      [
        "agent",
        "chip",
        "chips",
        "composer",
        "composerInput",
        "composerSend",
        "composerStop",
        "header",
        "message",
        "surface",
        "transcript",
        "user",
      ].sort(),
    );
    for (const value of Object.values(PARTS)) expect(value).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(new Set(Object.values(PARTS)).size).toBe(Object.values(PARTS).length);
    expect(messagePart("user")).toBe("message user");
    expect(messagePart("agent")).toBe("message agent");
  });
});
