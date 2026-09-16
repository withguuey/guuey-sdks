import { describe, expect, it } from "vitest";
import { GUUEY_CHAT_THEME as fromReact } from "../react.js";
import { GUUEY_CHAT_THEME as fromRoot } from "../theme.js";

/**
 * guuey#1320 — the react arm re-exports the kit's default theme so a bundle
 * that carries this entry alone (guuey's widget `host/v1.js`) has the base to
 * merge a host page's design under. The SAME object as the root's — never a
 * copy that could drift.
 */
describe("@guuey/chat/react — the default theme re-export (guuey#1320)", () => {
  it("is the root subpath's GUUEY_CHAT_THEME, by identity", () => {
    expect(fromReact).toBe(fromRoot);
    expect(fromReact.name).toBe(fromRoot.name);
  });
});
