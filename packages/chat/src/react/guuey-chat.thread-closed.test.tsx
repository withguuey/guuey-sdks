// @vitest-environment jsdom
/**
 * guuey#2355 — `<GuueyChat>` on a conversation the agent ended: a status
 * banner with the agent's message verbatim (voiced once), the composer held
 * shut, and "Start a new conversation" opening a fresh one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import { GuueyChat } from "./guuey-chat.js";
import { defaultChatStrings } from "../strings.js";

afterEach(cleanup);

const MESSAGE = "This chat is **full**. <b>Start</b> a new one.";
const CLOSED = { code: "app:CHAT_FULL", message: MESSAGE, closedAt: "2026-10-15T00:00:00.000Z" };
const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function adapters(): { adapters: AgentInvokeAdapters; calls: InvokeRequest[] } {
  const calls: InvokeRequest[] = [];
  const store = new Map<string, string>();
  let n = 0;
  return {
    calls,
    adapters: {
      storage: { load: (k) => store.get(k) ?? null, save: (k, v) => void store.set(k, v) },
      generateId: () => `cmid-${n++}`,
      transport: async function* (req) {
        calls.push(req);
        if (calls.length === 1) {
          yield frame("session", { threadId: "t-closed" });
          yield frame("error", { code: CLOSED.code, message: MESSAGE, threadClosed: CLOSED });
          yield frame("done", { stopReason: "end_turn", threadId: "t-closed", threadClosed: CLOSED });
        } else {
          yield frame("session", { threadId: "t-new" });
          yield frame("done", { stopReason: "end_turn", threadId: "t-new" });
        }
      },
    },
  };
}

function threadIdOf(body: unknown): unknown {
  return typeof body === "object" && body !== null ? Reflect.get(body, "threadId") : undefined;
}

async function closeTheConversation() {
  const a = adapters();
  render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={a.adapters} />);
  const input = screen.getByLabelText(defaultChatStrings.composerLabel);
  fireEvent.change(input, { target: { value: "hello" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.getByText(defaultChatStrings.threadClosedTitle)).toBeTruthy());
  return a;
}

describe("<GuueyChat> on a closed conversation", () => {
  it("draws a status banner with the agent's message verbatim, once", async () => {
    await closeTheConversation();
    const banner = screen.getByText(defaultChatStrings.threadClosedTitle).closest('[role="status"]');
    expect(banner).not.toBeNull();
    // Verbatim: the markdown and the tag are text, never rendered.
    expect(banner?.textContent).toContain(MESSAGE);
    const message = banner?.querySelector(".guuey-chat-thread-closed-message");
    expect(message?.textContent).toBe(MESSAGE);
    expect(message?.children).toHaveLength(0);
    // Voiced once: no error item repeats it.
    expect(document.body.textContent?.split(MESSAGE).length).toBe(2);
  });

  it("holds the composer shut with the closed placeholder", async () => {
    await closeTheConversation();
    const input = screen.getByLabelText(defaultChatStrings.composerLabel);
    expect(input).toHaveProperty("disabled", true);
    expect(input.getAttribute("placeholder")).toBe(defaultChatStrings.composerThreadClosed);
    expect(screen.getByRole("button", { name: defaultChatStrings.send })).toHaveProperty("disabled", true);
  });

  it("Start a new conversation clears the banner, opens the composer, and the next send names no thread", async () => {
    const a = await closeTheConversation();
    fireEvent.click(screen.getByRole("button", { name: defaultChatStrings.threadClosedStartNew }));
    await waitFor(() => expect(screen.queryByText(defaultChatStrings.threadClosedTitle)).toBeNull());
    const input = screen.getByLabelText(defaultChatStrings.composerLabel);
    expect(input).toHaveProperty("disabled", false);
    fireEvent.change(input, { target: { value: "again" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(a.calls).toHaveLength(2));
    expect(threadIdOf(a.calls[1]?.body)).toBeUndefined();
  });
});
