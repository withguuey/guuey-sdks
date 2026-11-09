/**
 * N−1 across a rolling release for the invoke's `clientCatalogs`: an OLDER
 * worker (its parser frozen in `fixtures/parse-control.pre-client-catalogs.prev.ts`)
 * reads a NEWER Router's invoke, and the current parser reads an older
 * Router's invoke. Neither throws, and neither side sees the field the other
 * did not send.
 */
import { describe, it, expect } from "vitest";
import { parseControl } from "./parse.js";
import { parseControl as parseControlPrev } from "./fixtures/parse-control.pre-client-catalogs.prev.js";

const OLD_INVOKE = {
  type: "invoke",
  input: "Book a table for four",
  identity: { userId: "u1", authMode: "authenticated" },
  fs: { app: "/app", home: "/home", session: "/session" },
  fsBound: true,
  history: [{ role: "user", text: "hello" }],
  gguiAttached: true,
};
const NEW_INVOKE = { ...OLD_INVOKE, clientCatalogs: ["guuey.a2ui.v1", "guuey.json-render.v1"] };

describe("the previous worker's parseControl (frozen) × a new Router's invoke", () => {
  it("reads the new invoke and drops clientCatalogs: the same turn as without it", () => {
    const fromNew = parseControlPrev(JSON.stringify(NEW_INVOKE));
    expect(fromNew).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
    expect("clientCatalogs" in fromNew).toBe(false);
  });

  it("still reads a malformed clientCatalogs without throwing", () => {
    const odd = { ...OLD_INVOKE, clientCatalogs: { a2ui: true } };
    expect(parseControlPrev(JSON.stringify(odd))).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
  });
});

describe("the current parseControl × an old Router's invoke", () => {
  it("reads it as the previous parser does, with no clientCatalogs", () => {
    const now = parseControl(JSON.stringify(OLD_INVOKE));
    expect(now).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
    expect("clientCatalogs" in now).toBe(false);
  });

  it("differs from the previous parser on the new invoke ONLY by clientCatalogs", () => {
    const now = parseControl(JSON.stringify(NEW_INVOKE));
    const prev = parseControlPrev(JSON.stringify(NEW_INVOKE));
    expect(now).toEqual({ ...prev, clientCatalogs: NEW_INVOKE.clientCatalogs });
  });
});
