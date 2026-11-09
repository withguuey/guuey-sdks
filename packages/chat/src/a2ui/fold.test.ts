/**
 * guuey#2381 — the surface fold: replace-by-id, the resolved tree, the data
 * model, and the two fault classes (spec §5.4, §5.7, §6; S1 RED (a), (a2),
 * (a3), (a5), (a6), (b)).
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { A2UI_LIMITS } from "./limits.js";
import { EMPTY_A2UI_STATE, readA2uiModel, type A2uiFoldState } from "./fold.js";
import type { A2uiNode } from "./schema.js";
import { foldA2uiCarrier, validateA2uiCarrier, type A2uiValidation } from "./validate.js";

type Json = JsonValue;
const V = "v0.9";
const create = (surfaceId = "s", title?: string): Json => ({
  version: V,
  createSurface: { surfaceId, catalogId: "guuey.a2ui.v1", ...(title !== undefined ? { title } : {}) },
});
const update = (list: Json[], surfaceId = "s"): Json => ({ version: V, updateComponents: { surfaceId, components: list } });
const model = (value: Json, path?: string, surfaceId = "s"): Json => ({
  version: V,
  updateDataModel: { surfaceId, value, ...(path !== undefined ? { path } : {}) },
});
const del = (surfaceId = "s"): Json => ({ version: V, deleteSurface: { surfaceId } });
const carrier = (...messages: Json[]): Json => ({ format: "a2ui", version: V, messages });

const col = (id: string, children: string[], extra: { [k: string]: Json } = {}): Json => ({
  id,
  component: "Column",
  children,
  ...extra,
});
const txt = (id: string, text: Json = "t"): Json => ({ id, component: "Text", text });
const field = (id: string, path = `/${id}`, extra: { [k: string]: Json } = {}): Json => ({
  id,
  component: "TextField",
  label: id,
  value: { path },
  ...extra,
});
const submit = (id = "go", name = "submit"): Json => ({ id, component: "Button", label: "Send", action: { name } });

/** The one drawn surface of a validation, or a failure naming why there is none. */
function drawn(out: A2uiValidation) {
  if (!out.ok) throw new Error(`not drawn: ${out.reason} at ${out.path}`);
  const first = out.surfaces[0];
  if (first?.kind !== "drawn") throw new Error(`surface ${first?.kind ?? "missing"}`);
  return first.surface;
}

const ids = (node: A2uiNode | null): string[] => {
  if (node === null) return [];
  switch (node.component) {
    case "Row":
    case "Column":
    case "List":
      return [node.id, ...node.children.flatMap(ids)];
    case "Card":
      return [node.id, ...ids(node.child)];
    default:
      return [node.id];
  }
};

describe("the resolved tree", () => {
  it("draws from the component with id root, children nested, ids kept", () => {
    const s = drawn(validateA2uiCarrier(carrier(create("s", "Hi"), update([txt("b"), col("root", ["a", "b"]), txt("a")]))));
    expect(s.title).toBe("Hi");
    expect(s.catalogId).toBe("guuey.a2ui.v1");
    expect(ids(s.root)).toEqual(["root", "a", "b"]);
    expect(s.interactive).toBe(false);
    expect(s.degrade).toEqual({});
  });

  it("without a root id: the first component of the first batch that nothing references", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([txt("leaf"), col("top", ["leaf"])]))));
    expect(s.root?.id).toBe("top");
  });

  it("catalogId is advisory: any non-empty id draws by name", () => {
    const s = drawn(validateA2uiCarrier(carrier({ version: V, createSurface: { surfaceId: "s", catalogId: "ggui.preview.v1" } }, update([txt("root")]))));
    expect(s.catalogId).toBe("ggui.preview.v1");
    expect(s.root?.component).toBe("Text");
  });

  it("replace by id: a later batch replaces a component in place", () => {
    const out = validateA2uiCarrier(carrier(create(), update([col("root", ["a"]), txt("a", "old")]), update([txt("a", "new")])));
    const root = drawn(out).root;
    expect(root?.component === "Column" ? root.children[0] : undefined).toMatchObject({ component: "Text", text: "new" });
  });

  it("props map to closed tokens: unknown gap draws md, unknown variant draws body", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([col("root", ["t"], { gap: "calc(1px)" }), { id: "t", component: "Text", text: "x", variant: "x;color:red" }]))));
    expect(s.root).toMatchObject({ component: "Column", gap: "md", align: null, justify: null });
    expect(s.root?.component === "Column" ? s.root.children[0] : undefined).toMatchObject({ variant: "body" });
    expect(s.degrade).toEqual({});
  });

  it("a Text binding stays a binding; the model holds the value", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), model({ name: "Ada" }), update([txt("root", { path: "/name" })]))));
    expect(s.root).toMatchObject({ component: "Text", text: { path: "/name" } });
    expect(readA2uiModel(s.dataModel, "/name")).toBe("Ada");
    expect(readA2uiModel(s.dataModel, "/missing")).toBeUndefined();
  });

  it("an image off policy A is a chip; an https href shows its host; a refused one is inert", () => {
    const s = drawn(
      validateA2uiCarrier(
        carrier(
          create(),
          update([
            col("root", ["img", "ok", "bad"]),
            { id: "img", component: "Image", src: "https://tracker.example/p.gif", alt: "pixel" },
            { id: "ok", component: "Button", label: "Docs", href: "https://docs.example.com/a" },
            { id: "bad", component: "Button", label: "Run", href: "javascript:alert(1)" },
          ]),
        ),
      ),
    );
    const [img, ok, bad] = s.root?.component === "Column" ? s.root.children : [];
    expect(img).toMatchObject({ component: "Image", display: { kind: "link", host: "tracker.example" }, alt: "pixel" });
    expect(ok).toMatchObject({ component: "Button", link: { host: "docs.example.com" } });
    expect(bad).toMatchObject({ component: "Button", link: null, action: null });
    expect(s.degrade).toEqual({ "refused-image": 1, "refused-link": 1 });
  });
});

describe("S1 (a) — component faults degrade in place on a read-only surface", () => {
  it("an unknown component is a labeled placeholder; its siblings draw", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([col("root", ["a", "x", "b"]), txt("a"), { id: "x", component: "Tabs" }, txt("b")]))));
    expect(s.root?.component === "Column" ? s.root.children.map((c) => c.component) : []).toEqual(["Text", "unknown", "Text"]);
    expect(s.root?.component === "Column" ? s.root.children[1] : undefined).toEqual({ id: "x", component: "unknown", name: "Tabs" });
    expect(s.degrade).toEqual({ "unknown-component": 1 });
  });

  it("a dangling child is skipped", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([col("root", ["a", "ghost"]), txt("a")]))));
    expect(ids(s.root)).toEqual(["root", "a"]);
    expect(s.degrade).toEqual({ "dangling-child": 1 });
  });

  it("a component reachable from two parents draws at its first reference only", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([col("root", ["p1", "p2"]), col("p1", ["x"]), col("p2", ["x"]), txt("x")]))));
    expect(ids(s.root)).toEqual(["root", "p1", "x", "p2"]);
    expect(s.degrade).toEqual({ "shared-child": 1 });
  });

  it("a bad prop is dropped and the component draws with its default", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([{ id: "root", component: "Divider", orientation: "diagonal" }]))));
    expect(s.root).toEqual({ id: "root", component: "Divider", orientation: "horizontal" });
    expect(s.degrade).toEqual({ "bad-prop": 1 });
  });

  it("an unusable required prop (Text.text, Button.label) makes a placeholder", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([col("root", ["t", "b"]), { id: "t", component: "Text", text: 5 }, { id: "b", component: "Button" }]))));
    expect(s.root?.component === "Column" ? s.root.children : []).toEqual([
      { id: "t", component: "unknown", name: "Text" },
      { id: "b", component: "unknown", name: "Button" },
    ]);
    expect(s.degrade).toEqual({ "bad-prop": 2 });
  });

  it("an id outside the charset drops the component", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([col("root", ["a"]), txt("a"), txt("bad id")]))));
    expect(ids(s.root)).toEqual(["root", "a"]);
    expect(s.degrade).toEqual({ "bad-id": 1 });
  });

  it("a cycle is an envelope fault", () => {
    const out = validateA2uiCarrier(carrier(create(), update([col("root", ["a"]), col("a", ["root"])])));
    expect(out).toMatchObject({ ok: false, reason: "cycle", level: "envelope" });
  });

  it("an unreachable cycle is an envelope fault too", () => {
    const out = validateA2uiCarrier(carrier(create(), update([txt("root"), col("a", ["b"]), col("b", ["a"])])));
    expect(out).toMatchObject({ ok: false, reason: "cycle" });
  });
});

describe("S1 (b) — the component bounds, at the bound and one over", () => {
  const children = (n: number): Json[] => Array.from({ length: n }, (_, i) => txt(`c${i}`));
  const kids = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${i}`);

  it(`components per surface: ${A2UI_LIMITS.componentsPerSurface} draw, 201 is too-many-components`, () => {
    const at = (n: number): Json => carrier(create(), update([{ id: "root", component: "List", children: kids(n - 1) }, ...children(n - 1)]));
    expect(validateA2uiCarrier(at(A2UI_LIMITS.componentsPerSurface)).ok).toBe(true);
    expect(validateA2uiCarrier(at(A2UI_LIMITS.componentsPerSurface + 1))).toMatchObject({ ok: false, reason: "too-many-components" });
  });

  it(`depth: ${A2UI_LIMITS.treeDepth} levels draw, 13 is too-deep`, () => {
    const chain = (n: number): Json[] =>
      Array.from({ length: n }, (_, i) => (i === n - 1 ? txt(`n${i}`) : { id: i === 0 ? "root" : `n${i}`, component: "Card", child: `n${i + 1}` }));
    expect(validateA2uiCarrier(carrier(create(), update(chain(A2UI_LIMITS.treeDepth)))).ok).toBe(true);
    expect(validateA2uiCarrier(carrier(create(), update(chain(A2UI_LIMITS.treeDepth + 1))))).toMatchObject({ ok: false, reason: "too-deep" });
  });

  it(`children per container: ${A2UI_LIMITS.childrenPerContainer} draw, the 51st is dropped`, () => {
    const at50 = drawn(validateA2uiCarrier(carrier(create(), update([col("root", kids(50)), ...children(50)]))));
    expect(at50.root?.component === "Column" ? at50.root.children : []).toHaveLength(50);
    expect(at50.degrade).toEqual({});
    const at51 = drawn(validateA2uiCarrier(carrier(create(), update([col("root", kids(51)), ...children(51)]))));
    expect(at51.root?.component === "Column" ? at51.root.children : []).toHaveLength(50);
    expect(at51.degrade).toEqual({ "dropped-children": 1 });
  });

  it(`List items: ${A2UI_LIMITS.listItems} draw, the 101st is dropped`, () => {
    const list = (n: number) => drawn(validateA2uiCarrier(carrier(create(), update([{ id: "root", component: "List", children: kids(n) }, ...children(n)]))));
    expect(list(100).degrade).toEqual({});
    const over = list(101);
    expect(over.root?.component === "List" ? over.root.children : []).toHaveLength(100);
    expect(over.degrade).toEqual({ "dropped-items": 1 });
  });

  it(`Text: ${A2UI_LIMITS.textUnits} units draw whole, one more is truncated with an ellipsis`, () => {
    const at = drawn(validateA2uiCarrier(carrier(create(), update([txt("root", "a".repeat(4000))]))));
    expect(at.root).toMatchObject({ text: "a".repeat(4000) });
    const over = drawn(validateA2uiCarrier(carrier(create(), update([txt("root", "a".repeat(4001))]))));
    expect(over.root).toMatchObject({ text: `${"a".repeat(3999)}…` });
    expect(over.degrade).toEqual({ "truncated-text": 1 });
  });

  it("a bound Text longer than the bound in the model counts as truncated", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), model({ t: "a".repeat(4001) }), update([txt("root", { path: "/t" })]))));
    expect(s.degrade).toEqual({ "truncated-text": 1 });
  });

  it(`labels: ${A2UI_LIMITS.labelUnits} units draw whole, one more is truncated`, () => {
    const at = drawn(validateA2uiCarrier(carrier(create(), update([{ id: "root", component: "Button", label: "b".repeat(200) }]))));
    expect(at.root).toMatchObject({ label: "b".repeat(200) });
    expect(at.degrade).toEqual({});
    const over = drawn(validateA2uiCarrier(carrier(create("s", "t".repeat(201)), update([{ id: "root", component: "Image", src: "data:image/png;base64,AA==", alt: "a".repeat(201) }]))));
    expect(over.title).toBe(`${"t".repeat(199)}…`);
    expect(over.root).toMatchObject({ alt: `${"a".repeat(199)}…` });
    expect(over.degrade).toEqual({ "truncated-label": 2 });
  });

  it(`ChoicePicker options: ${A2UI_LIMITS.choiceOptions} draw, the 51st is dropped (read-only: a literal value)`, () => {
    const opts = (n: number): Json[] => Array.from({ length: n }, (_, i) => ({ label: `o${i}`, value: `${i}` }));
    // A literal ChoicePicker is still an input component, so the surface is interactive: the drop takes the old face.
    expect(validateA2uiCarrier(carrier(create(), update([{ id: "root", component: "ChoicePicker", options: opts(50) }]))).ok).toBe(true);
    expect(validateA2uiCarrier(carrier(create(), update([{ id: "root", component: "ChoicePicker", options: opts(51) }])))).toMatchObject({
      ok: false,
      reason: "dropped-options",
      level: "component",
    });
  });

  it(`data model: ${A2UI_LIMITS.dataModelUnits} units are kept; over it the update is refused and the earlier model stays (read-only)`, () => {
    const big = (units: number): Json => ({ v: "x".repeat(units - 8) }); // {"v":"…"} = 8 units of JSON around the value
    const at = drawn(validateA2uiCarrier(carrier(create(), model(big(A2UI_LIMITS.dataModelUnits)), update([txt("root")]))));
    expect(JSON.stringify(at.dataModel)).toHaveLength(A2UI_LIMITS.dataModelUnits);
    const over = drawn(validateA2uiCarrier(carrier(create(), model({ a: 1 }), model(big(A2UI_LIMITS.dataModelUnits + 1)), update([txt("root")]))));
    expect(over.dataModel).toEqual({ a: 1 });
    expect(over.degrade).toEqual({ "data-model-too-large": 1 });
  });
});

describe("the data model (spec §5.4)", () => {
  it("a path write creates intermediate objects; an array index must exist", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), model({ list: [1, 2] }), model("x", "/a/b"), model(9, "/list/1"), update([txt("root")]))));
    expect(s.dataModel).toEqual({ list: [1, 9], a: { b: "x" } });
    const refused = drawn(validateA2uiCarrier(carrier(create(), model({ list: [1] }), model(2, "/list/5"), update([txt("root")]))));
    expect(refused.dataModel).toEqual({ list: [1] });
    expect(refused.degrade).toEqual({ "data-model-refused": 1 });
  });

  it("escaped segments address their keys; a __proto__ key is an own key, never the prototype", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), model(1, "/a~1b"), model(2, "/~0x"), model({ polluted: true }, "/__proto__"), update([txt("root")]))));
    expect(readA2uiModel(s.dataModel, "/a~1b")).toBe(1);
    expect(readA2uiModel(s.dataModel, "/~0x")).toBe(2);
    expect(Object.hasOwn(s.dataModel, "__proto__")).toBe(true);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("the declared model: each input bound by a path, with its constraint", () => {
    const s = drawn(
      validateA2uiCarrier(
        carrier(
          create(),
          update([
            col("root", ["name", "agree", "size", "lit", "go"]),
            field("name", "/name", { required: true, maxLength: 40 }),
            { id: "agree", component: "CheckBox", label: "OK", checked: { path: "/agree" }, required: true },
            { id: "size", component: "ChoicePicker", options: [{ label: "S", value: "s" }], value: { path: "/size" }, multiple: true },
            { id: "lit", component: "TextField", value: "literal" },
            submit(),
          ]),
        ),
      ),
    );
    expect(s.interactive).toBe(true);
    expect(s.fields).toEqual({
      "/name": { kind: "text", componentId: "name", label: "name", inputType: "text", required: true, maxLength: 40, min: null, max: null },
      "/agree": { kind: "boolean", componentId: "agree", label: "OK", required: true },
      "/size": { kind: "choice", componentId: "size", label: null, options: ["s"], multiple: true, required: false },
    });
  });
});

describe("surface outcomes", () => {
  it("deleteSurface draws nothing", () => {
    const out = validateA2uiCarrier(carrier(create(), update([txt("root")]), del()));
    expect(out).toEqual({ ok: true, surfaces: [{ kind: "deleted", surfaceId: "s" }] });
  });

  it("an update for a surface never created is an orphan: ignored, with components or without", () => {
    expect(validateA2uiCarrier(carrier(update([txt("root")], "late")))).toEqual({
      ok: true,
      surfaces: [{ kind: "ignored", surfaceId: "late" }],
    });
    expect(validateA2uiCarrier(carrier(model({ a: 1 }, undefined, "orphan")))).toEqual({
      ok: true,
      surfaces: [{ kind: "ignored", surfaceId: "orphan" }],
    });
  });

  it("an empty components batch (preview-a2ui: a legal no-op) draws an empty surface", () => {
    expect(drawn(validateA2uiCarrier(carrier(create(), update([])))).root).toBeNull();
  });
});

describe("a surface with components but no root (no-root)", () => {
  it("an empty first batch does not pin the root search: the first batch that adds a component does", () => {
    const first = foldA2uiCarrier(EMPTY_A2UI_STATE, carrier(create(), update([])));
    if (!first.ok) throw new Error(first.reason);
    const second = foldA2uiCarrier(first.state, carrier(update([col("main", ["f", "go"]), field("f"), submit()])));
    expect(second.ok).toBe(true);
    const surface = second.ok ? second.surfaces[0] : undefined;
    expect(surface?.kind === "drawn" ? surface.surface.root?.id : undefined).toBe("main");
  });

  it("a first batch of bad ids only does not pin it either", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([txt("bad id")]), update([col("main", ["a"]), txt("a")]))));
    expect(s.root?.id).toBe("main");
    expect(s.degrade).toEqual({ "bad-id": 1 });
  });

  it("an interactive surface whose first-batch root is re-parented takes the old face", () => {
    const first = foldA2uiCarrier(EMPTY_A2UI_STATE, carrier(create(), update([txt("t1")])));
    if (!first.ok) throw new Error(first.reason);
    const out = foldA2uiCarrier(first.state, carrier(update([col("col", ["t1", "go"]), submit()])));
    expect(out).toMatchObject({ ok: false, reason: "no-root", level: "component" });
  });

  it("a read-only one degrades and counts it", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([txt("t1")]), update([col("col", ["t1", "t2"]), txt("t2")]))));
    expect(s.root).toBeNull();
    expect(s.degrade).toMatchObject({ "no-root": 1 });
  });
});

describe("one population: every component in the surface is drawn or counted", () => {
  it("an unreferenced component that is not the root is a fault (read-only: counted)", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([col("root", ["a"]), txt("a"), txt("stray")]))));
    expect(ids(s.root)).toEqual(["root", "a"]);
    expect(s.degrade).toEqual({ "unreferenced-component": 1 });
  });

  it("an unreferenced input takes the old face: a form never draws with a field missing", () => {
    const out = validateA2uiCarrier(carrier(create(), update([col("root", ["name", "go"]), field("name"), field("email"), submit()])));
    expect(out).toMatchObject({ ok: false, reason: "unreferenced-component", level: "component" });
  });

  it("a fault on an unreferenced component counts like one on a drawn component", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([txt("root"), { id: "x", component: "Tabs" }]))));
    expect(s.degrade).toEqual({ "unknown-component": 1, "unreferenced-component": 1 });
  });
});

describe("S1 (a2) — on an interactive surface every component fault takes the old face", () => {
  /** A form (one field, one submit) with one more component, `x0`, beside them. */
  const withExtra = (extra: { [k: string]: Json }): Json =>
    carrier(create(), update([col("root", ["name", "go", "x0"]), field("name"), submit(), { ...extra, id: "x0" }]));
  const cases: Array<[string, Json, string]> = [
    ["an unknown component", withExtra({ component: "Tabs" }), "unknown-component"],
    ["a bad prop", withExtra({ component: "Divider", orientation: "diagonal" }), "bad-prop"],
    ["an unusable required prop", withExtra({ component: "Text", text: 1 }), "bad-prop"],
    ["a dangling child", carrier(create(), update([col("root", ["name", "go", "ghost"]), field("name"), submit()])), "dangling-child"],
    ["a shared child", carrier(create(), update([col("root", ["name", "go", "p"]), col("p", ["name"]), field("name"), submit()])), "shared-child"],
    ["a truncated label", carrier(create(), update([col("root", ["name", "go"]), field("name", "/n", { label: "l".repeat(201) }), submit()])), "truncated-label"],
    ["a truncated text", withExtra({ component: "Text", text: "a".repeat(4001) }), "truncated-text"],
    [
      "dropped children",
      carrier(create(), update([col("root", ["name", "go", ...Array.from({ length: 49 }, (_, i) => `t${i}`)]), field("name"), submit(), ...Array.from({ length: 49 }, (_, i) => txt(`t${i}`))])),
      "dropped-children",
    ],
    ["an action name outside the charset", carrier(create(), update([col("root", ["name", "go"]), field("name"), submit("go", "do it!")])), "bad-prop"],
    ["a source id outside the charset", carrier(create(), update([col("root", ["name"]), field("name"), submit("bad id")])), "bad-id"],
    ["an action context key outside the charset", carrier(create(), update([col("root", ["go"]), { id: "go", component: "Button", label: "Go", action: { name: "go", context: { "bad key": 1 } } }])), "bad-prop"],
  ];
  for (const [what, value, reason] of cases) {
    it(`${what} → the old face (${reason}), never a partial form`, () => {
      const out = validateA2uiCarrier(value);
      expect(out).toMatchObject({ ok: false, reason, level: "component" });
    });
  }

  it("a Button with an action key counts even when its own props are bad", () => {
    const out = validateA2uiCarrier(carrier(create(), update([col("root", ["go"]), { id: "go", component: "Button", action: { name: "go" } }])));
    expect(out).toMatchObject({ ok: false, reason: "bad-prop", level: "component" });
  });

  it("the same faults on a read-only twin degrade in place", () => {
    const out = validateA2uiCarrier(carrier(create(), update([col("root", ["a", "ghost"]), txt("a")])));
    expect(out.ok).toBe(true);
  });
});

describe("S1 (a3) — an over-cap updateDataModel on an interactive surface", () => {
  it("takes the old face, and the fold state does not move (no new components drawn on stale data)", () => {
    const first = foldA2uiCarrier(EMPTY_A2UI_STATE, carrier(create(), model({ name: "a" }), update([col("root", ["name", "go"]), field("name"), submit()])));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = foldA2uiCarrier(first.state, carrier(model("x".repeat(A2UI_LIMITS.dataModelUnits), "/name"), update([txt("go", "changed")])));
    expect(second).toMatchObject({ ok: false, reason: "data-model-too-large", level: "component", surfaceIds: ["s"] });
  });
});

describe("S1 (a5) — the closed carve-out list stays in place on an interactive surface", () => {
  it("a refused image becomes its chip; every field and the submit stay", () => {
    const s = drawn(
      validateA2uiCarrier(carrier(create(), update([col("root", ["img", "name", "go"]), { id: "img", component: "Image", src: "http://example.com/a.png" }, field("name"), submit()]))),
    );
    expect(s.interactive).toBe(true);
    expect(ids(s.root)).toEqual(["root", "img", "name", "go"]);
    expect(s.root?.component === "Column" ? s.root.children[0] : undefined).toMatchObject({ display: { kind: "chip" } });
    expect(Object.keys(s.fields)).toEqual(["/name"]);
    expect(s.degrade).toEqual({ "refused-image": 1 });
  });

  it("the host's media policy narrows what loads, and a narrowed image is a refused-image carve-out", () => {
    const hosted = "https://cdn.guueyusercontent.com/a.png";
    const value = carrier(create(), update([col("root", ["img", "name", "go"]), { id: "img", component: "Image", src: hosted }, field("name"), submit()]));
    const open = foldA2uiCarrier(EMPTY_A2UI_STATE, value);
    const chipOnly = foldA2uiCarrier(EMPTY_A2UI_STATE, value, { chipOnly: true, origins: ["https://*.guueyusercontent.com"], maxInlineBytes: 1024 });
    const img = (out: typeof open) => {
      const s = drawn(out.ok ? { ok: true, surfaces: out.surfaces } : out);
      return { node: s.root?.component === "Column" ? s.root.children[0] : undefined, degrade: s.degrade, interactive: s.interactive };
    };
    expect(img(open)).toMatchObject({ node: { display: { kind: "image", src: hosted } }, degrade: {} });
    expect(img(chipOnly)).toMatchObject({
      node: { display: { kind: "link", url: hosted } },
      degrade: { "refused-image": 1 },
      interactive: true,
    });
  });

  it("a refused Button.href is inert; every field and the submit stay", () => {
    const s = drawn(
      validateA2uiCarrier(carrier(create(), update([col("root", ["link", "name", "go"]), { id: "link", component: "Button", label: "Help", href: "http://help.example" }, field("name"), submit()]))),
    );
    expect(ids(s.root)).toEqual(["root", "link", "name", "go"]);
    expect(s.degrade).toEqual({ "refused-link": 1 });
  });

  it("a Text link that is not https is not a fault at all (it draws inert at render, §7.1)", () => {
    const s = drawn(validateA2uiCarrier(carrier(create(), update([col("root", ["t", "name", "go"]), txt("t", "[x](http://a.example)"), field("name"), submit()]))));
    expect(s.degrade).toEqual({});
  });
});

describe("S1 (a6) — the class is read on the resulting tree", () => {
  function apply(state: A2uiFoldState, value: Json) {
    const out = foldA2uiCarrier(state, value);
    if (!out.ok) return { out, state };
    return { out, state: out.state };
  }

  it("an update that adds a Button.action to a read-only surface makes the next fault take the old face", () => {
    const one = apply(EMPTY_A2UI_STATE, carrier(create(), update([col("root", ["a"]), txt("a")])));
    expect(one.out.ok).toBe(true);
    // Read-only: a dangling child degrades in place.
    expect(apply(one.state, carrier(update([col("root", ["a", "ghost"])]))).out.ok).toBe(true);
    // The same fault in the carrier that adds an action: the resulting tree is interactive.
    const two = apply(one.state, carrier(update([col("root", ["a", "go", "ghost"]), submit()])));
    expect(two.out).toMatchObject({ ok: false, reason: "dangling-child", level: "component" });
  });

  it("an update that replaces the only input with a Text makes it read-only", () => {
    const one = apply(EMPTY_A2UI_STATE, carrier(create(), update([col("root", ["name"]), field("name")])));
    expect(one.out.ok).toBe(true);
    const two = apply(one.state, carrier(update([col("root", ["name", "ghost"]), txt("name", "Thanks!")])));
    expect(two.out.ok).toBe(true);
    if (!two.out.ok) return;
    const surface = two.out.surfaces[0];
    expect(surface?.kind === "drawn" ? surface.surface.interactive : undefined).toBe(false);
    expect(surface?.kind === "drawn" ? surface.surface.degrade : undefined).toEqual({ "dangling-child": 1 });
  });

  it("a later carrier for a surface keeps its components and model (replace by id across carriers)", () => {
    const one = apply(EMPTY_A2UI_STATE, carrier(create(), model({ n: 1 }), update([col("root", ["a"]), txt("a")])));
    const two = apply(one.state, carrier(model(2, "/n")));
    expect(two.out.ok).toBe(true);
    if (!two.out.ok) return;
    const surface = two.out.surfaces[0];
    expect(surface?.kind === "drawn" ? surface.surface.dataModel : undefined).toEqual({ n: 2 });
    expect(surface?.kind === "drawn" ? ids(surface.surface.root) : undefined).toEqual(["root", "a"]);
  });

  it("createSurface on an existing surface starts it fresh", () => {
    const one = apply(EMPTY_A2UI_STATE, carrier(create(), model({ n: 1 }), update([col("root", ["a"]), txt("a")])));
    const two = apply(one.state, carrier(create(), update([txt("root", "fresh")])));
    expect(two.out.ok).toBe(true);
    if (!two.out.ok) return;
    const surface = two.out.surfaces[0];
    expect(surface?.kind === "drawn" ? surface.surface.dataModel : undefined).toEqual({});
    expect(surface?.kind === "drawn" ? ids(surface.surface.root) : undefined).toEqual(["root"]);
  });
});

describe("determinism", () => {
  it("the same carrier validates to a deep-equal result", () => {
    const value = carrier(create("s", "T"), model({ a: [1, { b: 2 }] }), update([col("root", ["name", "go"]), field("name", "/a/1/b"), submit()]));
    expect(validateA2uiCarrier(value)).toEqual(validateA2uiCarrier(value));
  });
});
