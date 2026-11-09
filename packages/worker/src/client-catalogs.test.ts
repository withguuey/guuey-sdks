import { describe, it, expect } from "vitest";
import { CLIENT_CATALOGS_MAX, CLIENT_CATALOG_ID_MAX_CHARS, parseClientCatalogs } from "./client-catalogs.js";
import { parseControl } from "./parse.js";

const A2UI = "guuey.a2ui.v1";
const JSON_RENDER = "guuey.json-render.v1";

describe("parseClientCatalogs — the one bound the Router writes with and the worker reads with", () => {
  it("keeps a valid list as sent, in order", () => {
    expect(parseClientCatalogs([A2UI, JSON_RENDER])).toEqual([A2UI, JSON_RENDER]);
  });

  it("is absent for a non-array, an empty list, or a list where nothing survives", () => {
    expect(parseClientCatalogs(undefined)).toBeUndefined();
    expect(parseClientCatalogs("guuey.a2ui.v1")).toBeUndefined();
    expect(parseClientCatalogs({ 0: A2UI })).toBeUndefined();
    expect(parseClientCatalogs([])).toBeUndefined();
    expect(parseClientCatalogs([1, null, "", {}])).toBeUndefined();
  });

  it("drops a wrong entry and keeps the rest: one bad id never costs the turn the catalogs it draws", () => {
    expect(parseClientCatalogs([7, A2UI, "", "x".repeat(CLIENT_CATALOG_ID_MAX_CHARS + 1), JSON_RENDER])).toEqual([
      A2UI,
      JSON_RENDER,
    ]);
  });

  it("keeps an id only in the URL-safe ASCII class: whitespace, control and non-ASCII drop alone", () => {
    const atBound = "a".repeat(CLIENT_CATALOG_ID_MAX_CHARS);
    expect(parseClientCatalogs([atBound, "ns:ui/v1@2+x~y_z-w"])).toEqual([atBound, "ns:ui/v1@2+x~y_z-w"]);
    expect(parseClientCatalogs([`${atBound}a`, A2UI])).toEqual([A2UI]);
    for (const bad of ["guuey.a2ui.v1\n", "guuey a2ui", "guuey\u0000a2ui", "guüey.a2ui.v1", "\u{1d49c}"]) {
      expect(parseClientCatalogs([bad, A2UI]), JSON.stringify(bad)).toEqual([A2UI]);
    }
  });

  it("drops repeats", () => {
    expect(parseClientCatalogs([A2UI, A2UI, JSON_RENDER, A2UI])).toEqual([A2UI, JSON_RENDER]);
  });

  it("keeps the first CLIENT_CATALOGS_MAX ids and drops the rest", () => {
    const many = Array.from({ length: CLIENT_CATALOGS_MAX + 4 }, (_, i) => `catalog.${String(i)}`);
    const kept = parseClientCatalogs(many);
    expect(kept).toEqual(many.slice(0, CLIENT_CATALOGS_MAX));
  });
});

describe("parseControl carries clientCatalogs onto the Invoke", () => {
  const base = {
    type: "invoke",
    input: "hi",
    identity: { userId: "u1", authMode: "authenticated" },
    fs: { app: "/app", home: "/home", session: "/session" },
  };

  it("round-trips a valid list", () => {
    const msg = parseControl(JSON.stringify({ ...base, clientCatalogs: [A2UI, JSON_RENDER] }));
    expect(msg).toMatchObject({ type: "invoke", clientCatalogs: [A2UI, JSON_RENDER] });
  });

  it("leaves the field absent when the Router sent none, or nothing survives the bound", () => {
    for (const clientCatalogs of [undefined, [], "guuey.a2ui.v1", [42]]) {
      const msg = parseControl(JSON.stringify({ ...base, clientCatalogs }));
      expect("clientCatalogs" in msg, JSON.stringify(clientCatalogs)).toBe(false);
    }
  });
});
