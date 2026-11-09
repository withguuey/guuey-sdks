/**
 * guuey#2381 — the carrier validator (spec §5.6, §5.7, §6; S1 RED (a), (a7), (b)).
 *
 * Envelope faults: each yields its closed reason code and the carrier takes the
 * old face. Component faults are the fold's (fold.test.ts); here they show up
 * only through `validateA2uiCarrier`'s verdict on a fresh surface.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { a2uiCarrierUnits } from "@guuey/mcp-apps-host/narrowing";
import { A2UI_LIMITS } from "./limits.js";
import { namedA2uiSurfaceIds, parseA2uiCarrier, validateA2uiCarrier } from "./validate.js";

type Json = JsonValue;

const V = "v0.9";
const create = (surfaceId: string, extra: { [key: string]: Json } = {}): Json => ({
  version: V,
  createSurface: { surfaceId, catalogId: "guuey.a2ui.v1", ...extra },
});
const components = (surfaceId: string, list: Json[]): Json => ({
  version: V,
  updateComponents: { surfaceId, components: list },
});
const carrier = (messages: Json[], extra: { [key: string]: Json } = {}): Json => ({
  format: "a2ui",
  version: V,
  messages,
  ...extra,
});
const text = (id: string, t = "hello"): Json => ({ id, component: "Text", text: t });

function reasonOf(value: Json): string | undefined {
  const out = validateA2uiCarrier(value);
  return out.ok ? undefined : out.reason;
}

describe("envelope faults → the old face, each with its reason (spec §5.7)", () => {
  const table: Array<[string, Json, string]> = [
    ["not an object", [1, 2], "not-object"],
    ["a string", "a2ui", "not-object"],
    ["an unknown format", carrier([create("s")], { format: "html" }), "unsupported-format"],
    ["json-render (the S5 adapter is not here yet)", { format: "json-render", version: "0.21.1", surfaceId: "s", spec: {} }, "unsupported-format"],
    ["a bad carrier version", carrier([create("s")], { version: "v0.8" }), "bad-version"],
    ["a bad message version", carrier([{ version: "v1.0", createSurface: { surfaceId: "s", catalogId: "c" } }]), "bad-version"],
    ["messages not a list", carrier([], { messages: { a: 1 } }), "bad-shape"],
    ["an empty message list", carrier([]), "bad-shape"],
    ["a message that is not an object", carrier(["createSurface"]), "bad-shape"],
    ["a message with only a version", carrier([{ version: V }]), "unrecognized-message"],
    ["a message with only unknown keys", carrier([{ version: V, openModal: { surfaceId: "s" } }]), "unrecognized-message"],
    [
      "a message with two recognized keys",
      carrier([{ version: V, createSurface: { surfaceId: "s", catalogId: "c" }, deleteSurface: { surfaceId: "s" } }]),
      "bad-shape",
    ],
    ["a surface id outside the charset", carrier([create("has space")]), "bad-surface-id"],
    ["a surface id over 64", carrier([create("s".repeat(65))]), "bad-surface-id"],
    ["an empty catalogId", carrier([{ version: V, createSurface: { surfaceId: "s", catalogId: "" } }]), "bad-shape"],
    ["components not a list", carrier([{ version: V, updateComponents: { surfaceId: "s", components: {} } }]), "bad-shape"],
    ["a component that is not an object", carrier([create("s"), components("s", ["root"])]), "bad-shape"],
    ["a component without a string id", carrier([create("s"), components("s", [{ component: "Text", text: "x" }])]), "bad-shape"],
    ["a component without a component name", carrier([create("s"), components("s", [{ id: "a", text: "x" }])]), "bad-shape"],
    ["updateDataModel without a value", carrier([create("s"), { version: V, updateDataModel: { surfaceId: "s", path: "/a" } }]), "bad-shape"],
    ["a root data-model write that is not an object", carrier([create("s"), { version: V, updateDataModel: { surfaceId: "s", value: 3 } }]), "bad-shape"],
    ["a malformed data path", carrier([create("s"), { version: V, updateDataModel: { surfaceId: "s", path: "a/b", value: 1 } }]), "bad-path"],
    ["a bad pointer escape", carrier([create("s"), { version: V, updateDataModel: { surfaceId: "s", path: "/a~2", value: 1 } }]), "bad-path"],
    [
      "a malformed binding in a component",
      carrier([create("s"), components("s", [{ id: "root", component: "Text", text: { path: "nope" } }])]),
      "bad-path",
    ],
    [
      "a malformed binding in an action context",
      carrier([
        create("s"),
        components("s", [{ id: "root", component: "Button", label: "Go", action: { name: "go", context: { a: { path: "x" } } } }]),
      ]),
      "bad-path",
    ],
  ];
  for (const [what, value, reason] of table) {
    it(`${what} → ${reason}`, () => {
      const out = validateA2uiCarrier(value);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe(reason);
      expect(out.level).toBe("envelope");
    });
  }

  it("a fault names where it is", () => {
    const out = validateA2uiCarrier(carrier([create("s"), components("s", [text("root"), "x"])]));
    expect(out).toMatchObject({ ok: false, reason: "bad-shape", path: "/messages/1/updateComponents/components/1" });
  });

  it("format absent reads as a2ui; mimeType and unknown envelope keys are ignored", () => {
    const value: Json = { version: V, mimeType: "application/json+a2ui", extra: true, messages: [create("s"), components("s", [text("root")])] };
    expect(validateA2uiCarrier(value).ok).toBe(true);
  });

  it("a message with a recognized key and unknown keys beside it reads as the recognized key", () => {
    const value = carrier([{ version: V, createSurface: { surfaceId: "s", catalogId: "c" }, theme: { dark: true } }, components("s", [text("root")])]);
    expect(validateA2uiCarrier(value).ok).toBe(true);
  });
});

describe("envelope bounds — at the bound and one over (spec §6, S1 (b))", () => {
  it(`carrier JSON: ${A2UI_LIMITS.carrierUnits} units reads, one more is too-large`, () => {
    const make = (units: number): Json => {
      const shell = carrier([create("s"), components("s", [text("root", "")])]);
      const pad = units - a2uiCarrierUnits(shell);
      return carrier([create("s"), components("s", [text("root", "x".repeat(pad))])]);
    };
    // A Text over 4 000 truncates on a read-only surface; the bound under test is the carrier's.
    expect(a2uiCarrierUnits(make(A2UI_LIMITS.carrierUnits))).toBe(A2UI_LIMITS.carrierUnits);
    expect(reasonOf(make(A2UI_LIMITS.carrierUnits))).toBeUndefined();
    expect(reasonOf(make(A2UI_LIMITS.carrierUnits + 1))).toBe("too-large");
  });

  it("a too-large carrier still names its surfaces, read by a bounded lenient scan of its first messages", () => {
    const dm = (surfaceId: string, value: Json): Json => ({ version: V, updateDataModel: { surfaceId, value } });
    const pad = "x".repeat(A2UI_LIMITS.carrierUnits);
    const named = carrier([dm("f1", { blob: pad }), components("f2", [text("root")])]);
    expect(validateA2uiCarrier(named)).toMatchObject({ ok: false, reason: "too-large", surfaceIds: ["f1", "f2"] });
    const late = carrier([
      ...Array.from({ length: A2UI_LIMITS.messagesPerCarrier }, () => dm("early", { blob: pad.slice(0, 600) })),
      dm("late", 1),
    ]);
    expect(namedA2uiSurfaceIds(late)).toEqual(["early"]);
    expect(namedA2uiSurfaceIds(7)).toEqual([]);
  });

  it(`messages: ${A2UI_LIMITS.messagesPerCarrier} read, one more is too-many-messages`, () => {
    const many = (n: number): Json => carrier([create("s"), ...Array.from({ length: n - 1 }, () => components("s", [text("root")]))]);
    expect(reasonOf(many(A2UI_LIMITS.messagesPerCarrier))).toBeUndefined();
    expect(reasonOf(many(A2UI_LIMITS.messagesPerCarrier + 1))).toBe("too-many-messages");
  });

  it(`surfaces: ${A2UI_LIMITS.surfacesPerCarrier} read, a fifth is too-many-surfaces`, () => {
    const surfaces = (n: number): Json =>
      carrier(Array.from({ length: n }, (_, i) => [create(`s${i}`), components(`s${i}`, [text("root")])]).flat());
    expect(reasonOf(surfaces(A2UI_LIMITS.surfacesPerCarrier))).toBeUndefined();
    expect(reasonOf(surfaces(A2UI_LIMITS.surfacesPerCarrier + 1))).toBe("too-many-surfaces");
  });

  it(`data path depth: ${A2UI_LIMITS.dataPathDepth} segments read, nine is path-too-deep`, () => {
    const at = (n: number): Json =>
      carrier([create("s"), { version: V, updateDataModel: { surfaceId: "s", path: "/a".repeat(n), value: 1 } }]);
    expect(reasonOf(at(A2UI_LIMITS.dataPathDepth))).toBeUndefined();
    expect(reasonOf(at(A2UI_LIMITS.dataPathDepth + 1))).toBe("path-too-deep");
  });

  it("a data path segment of 64 units reads; 65 is malformed", () => {
    const at = (n: number): Json =>
      carrier([create("s"), { version: V, updateDataModel: { surfaceId: "s", path: `/${"k".repeat(n)}`, value: 1 } }]);
    expect(reasonOf(at(64))).toBeUndefined();
    expect(reasonOf(at(65))).toBe("bad-path");
  });

  it(`action context keys: ${A2UI_LIMITS.actionContextKeys} read, 33 is too-many-context-keys`, () => {
    const at = (n: number): Json => {
      const context: { [key: string]: Json } = {};
      for (let i = 0; i < n; i++) context[`k${i}`] = i;
      return carrier([create("s"), components("s", [{ id: "root", component: "Button", label: "Go", action: { name: "go", context } }])]);
    };
    expect(reasonOf(at(A2UI_LIMITS.actionContextKeys))).toBeUndefined();
    expect(reasonOf(at(A2UI_LIMITS.actionContextKeys + 1))).toBe("too-many-context-keys");
  });
});

describe("parseA2uiCarrier — the envelope stage", () => {
  it("hands on each message with its surface and parsed components", () => {
    const out = parseA2uiCarrier(
      carrier([create("s", { title: "T" }), components("s", [text("root", "hi")]), { version: V, deleteSurface: { surfaceId: "s" } }]),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.messages.map((m) => m.kind)).toEqual(["createSurface", "updateComponents", "deleteSurface"]);
    const update = out.messages[1];
    expect(update?.kind === "updateComponents" ? update.components[0] : undefined).toMatchObject({
      id: "root",
      name: "Text",
      interactive: false,
      parsed: { component: "Text", props: { text: "hi" } },
    });
  });

  it("an envelope fault still names the surfaces it could read (to close a stale interactive revision)", () => {
    const out = parseA2uiCarrier(carrier([create("form-1"), { version: V, bogus: 1 }]));
    expect(out).toMatchObject({ ok: false, reason: "unrecognized-message", surfaceIds: ["form-1"] });
  });

  it("unknown props are stripped, a bad prop is dropped alone and counted", () => {
    const out = parseA2uiCarrier(
      carrier([create("s"), components("s", [{ id: "root", component: "Row", gap: 4, align: "center", extra: "x" }])]),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const update = out.messages[1];
    const entry = update?.kind === "updateComponents" ? update.components[0] : undefined;
    expect(entry?.parsed).toEqual({ component: "Row", props: { align: "center" } });
    expect(entry?.faults).toEqual({ "bad-prop": 1 });
  });
});

describe("S1 (a7) — Text content is a string, with no markup check", () => {
  it("a Text link that is not https, raw HTML and image syntax are never carrier faults", () => {
    const value = carrier([
      create("s"),
      components("s", [
        { id: "root", component: "Column", children: ["a", "b", "c"] },
        text("a", "[click](javascript:alert(1)) and [plain](http://example.com)"),
        text("b", "<img src=x onerror=alert(1)><script>x</script>"),
        text("c", "![alt](http://host/x.png)"),
      ]),
    ]);
    const out = validateA2uiCarrier(value);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const surface = out.surfaces[0];
    expect(surface?.kind).toBe("drawn");
    expect(surface?.kind === "drawn" ? surface.surface.degrade : undefined).toEqual({});
  });
});
