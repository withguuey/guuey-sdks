// @vitest-environment jsdom
/**
 * guuey#2834 — `<GuueyChat>`'s banner after the OAuth dance returns. The
 * server's retry code (`first_party_allowlist_unavailable`: it could not READ
 * the first-party allowlist, so nothing was decided) reads as "try again in a
 * moment" and never shows the code; every other code reads exactly as before,
 * "Couldn't connect: <code>"; a builder's `strings` override wins.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters } from "@guuey/agent-client";
import { GuueyChat } from "./guuey-chat.js";
import type { ChatStrings } from "../strings.js";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function adapters(): AgentInvokeAdapters {
  const store = new Map<string, string>();
  return {
    storage: { load: (k) => store.get(k) ?? null, save: (k, v) => void store.set(k, v) },
    generateId: () => "cmid-1",
    // eslint-disable-next-line require-yield
    transport: async function* () {
      return;
    },
  };
}

/** The banner's tone class (the face): `connected`, `retry` or `error`. */
function bannerTone(): string[] {
  const banner = document.querySelector(".guuey-chat-oauth-notice");
  return Array.from(banner?.classList ?? []).filter((c) => c !== "guuey-chat-oauth-notice");
}

/** Land on the page the broker returned to, mount the chat, and read its banner. */
async function bannerAfterReturn(query: string, strings?: Partial<ChatStrings>): Promise<string> {
  window.history.replaceState(null, "", `/chat?${query}`);
  render(<GuueyChat endpointUrl="https://pod.example/agent/invoke" adapters={adapters()} strings={strings} />);
  const banner = await waitFor(() => {
    const found = document.querySelector(".guuey-chat-oauth-notice");
    expect(found).not.toBeNull();
    return found;
  });
  expect(banner?.getAttribute("role")).toBe("status");
  const dismiss = banner?.querySelector(".guuey-chat-oauth-dismiss");
  // The line is the banner's text without its Dismiss button.
  return (banner?.textContent ?? "").slice(0, -(dismiss?.textContent?.length ?? 0));
}

describe("<GuueyChat> OAuth return banner (guuey#2834)", () => {
  it("the retry code reads as try-again-later and never shows the code", async () => {
    const line = await bannerAfterReturn("error=first_party_allowlist_unavailable");
    expect(line).toBe("We couldn't check this connection just now. Try again in a moment.");
    expect(document.body.textContent).not.toContain("first_party_allowlist_unavailable");
    // The face matches the words: nothing was decided, so no error tint.
    expect(bannerTone()).toEqual(["guuey-chat-oauth-retry"]);
    // The address bar no longer carries the return param (a reload shows nothing).
    expect(window.location.search).toBe("");
  });

  it("an unrelated code still reads Couldn't connect: <code>", async () => {
    expect(await bannerAfterReturn("error=access_denied")).toBe("Couldn't connect: access_denied");
    expect(bannerTone()).toEqual(["guuey-chat-oauth-error"]);
  });

  it("a connected return reads as before", async () => {
    expect(await bannerAfterReturn("connected=linear")).toBe(
      "Connected linear. The agent can use it from your next message.",
    );
    expect(bannerTone()).toEqual(["guuey-chat-oauth-connected"]);
  });

  it("a builder's oauthRetryLater override wins", async () => {
    expect(await bannerAfterReturn("error=first_party_allowlist_unavailable", { oauthRetryLater: "Gleich nochmal." })).toBe(
      "Gleich nochmal.",
    );
    expect(screen.queryByText(/first_party_allowlist_unavailable/)).toBeNull();
  });
});
