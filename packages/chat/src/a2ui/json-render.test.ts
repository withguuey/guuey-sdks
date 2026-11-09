/**
 * guuey#2385 — the json-render adapter (spec §12): a `{ format: "json-render" }`
 * carrier maps onto the same A2UI message list, and the one validator judges
 * it with every §6 limit.
 *
 * The vectors in `__fixtures__/json-render-*.json` are written in the shape of
 * `@json-render/core@0.21.1`'s published types and README, read at 0.21.1.
 * The package is not a dependency, so no vector is run through it here. Each
 * fixture file's converted messages and drawn
 * surfaces are snapshotted beside this test; the cases below pin what each
 * row promises.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { a2uiCarrierUnits as a2uiUnits } from "@guuey/mcp-apps-host/narrowing";
import { A2UI_LIMITS } from "./limits.js";
import type { A2uiJsonObject, A2uiNode } from "./schema.js";
import type { A2uiResolvedSurface } from "./fold.js";
import { namedA2uiSurfaceIds, parseA2uiCarrier, validateA2uiCarrier } from "./validate.js";
import { JSON_RENDER_CATALOG_ID, jsonRenderToA2ui } from "./json-render.js";

interface FixtureCase {
  name: string;
  row: string;
  carrier?: A2uiJsonObject;
  spec: A2uiJsonObject;
}

interface FixtureFile {
  source: string;
  cases: FixtureCase[];
}

const FIXTURES = ["rows", "examples", "expressions", "hostile"] as const;
const fixture = (name: (typeof FIXTURES)[number]): FixtureFile =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/json-render-${name}.json`, import.meta.url), "utf8"));

/** A json-render carrier around a spec. */
function carrier(spec: JsonValue, extra: A2uiJsonObject = {}): A2uiJsonObject {
  return { format: "json-render", version: "0.21.1", surfaceId: "s", ...extra, spec };
}

function caseOf(file: (typeof FIXTURES)[number], name: string): A2uiJsonObject {
  const found = fixture(file).cases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no case ${name} in ${file}`);
  return carrier(found.spec, found.carrier ?? {});
}

/** The one surface a json-render carrier draws (the test fails when it does not draw). */
function drawn(value: A2uiJsonObject): A2uiResolvedSurface {
  const out = validateA2uiCarrier(value);
  if (!out.ok) throw new Error(`did not draw: ${out.reason} at ${out.path}`);
  const [outcome] = out.surfaces;
  if (outcome?.kind !== "drawn") throw new Error("no drawn surface");
  return outcome.surface;
}

/** The A2UI components the adapter emitted. */
function components(value: A2uiJsonObject): A2uiJsonObject[] {
  const out = jsonRenderToA2ui(value);
  if (!out.ok) throw new Error(`not adapted: ${out.reason} at ${out.path}`);
  const update = out.messages.map((m) => m["updateComponents"]).find((u) => u !== undefined);
  if (typeof update !== "object" || update === null || Array.isArray(update)) throw new Error("no updateComponents");
  const list = update["components"];
  if (!Array.isArray(list)) throw new Error("no components");
  return list.filter((c): c is A2uiJsonObject => typeof c === "object" && c !== null && !Array.isArray(c));
}

/** Every node of a tree, depth first. */
function nodes(root: A2uiNode | null): A2uiNode[] {
  if (root === null) return [];
  const kids =
    root.component === "Row" || root.component === "Column" || root.component === "List"
      ? root.children
      : root.component === "Card" && root.child !== null
        ? [root.child]
        : [];
  return [root, ...kids.flatMap(nodes)];
}

function node(surface: A2uiResolvedSurface, id: string): A2uiNode {
  const found = nodes(surface.root).find((n) => n.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guuey#2385 — the conformance vectors, converted and snapshotted", () => {
  for (const file of FIXTURES) {
    it(`json-render-${file}: every case converts and draws as its snapshot says`, async () => {
      const { cases } = fixture(file);
      const out = cases.map((c) => {
        const value = carrier(c.spec, c.carrier ?? {});
        const validation = validateA2uiCarrier(value);
        return {
          name: c.name,
          row: c.row,
          adapted: jsonRenderToA2ui(value),
          validation: validation.ok
            ? {
                ok: true,
                surfaces: validation.surfaces.map((s) =>
                  s.kind === "drawn"
                    ? { root: s.surface.root, interactive: s.surface.interactive, degrade: s.surface.degrade, fields: s.surface.fields }
                    : s,
                ),
              }
            : validation,
        };
      });
      await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(`./__snapshots__/json-render-${file}.snap`);
    });
  }
});

describe("guuey#2385 — the carrier envelope", () => {
  it("emits createSurface (id, title, the json-render catalog), updateDataModel from state, then updateComponents", () => {
    const out = jsonRenderToA2ui(carrier({ root: "t", elements: { t: { type: "Text", props: { text: "hi" } } }, state: { a: 1 } }, { title: "Hello" }));
    expect(out).toMatchObject({
      ok: true,
      surfaceId: "s",
      messages: [
        { version: "v0.9", createSurface: { surfaceId: "s", catalogId: JSON_RENDER_CATALOG_ID, title: "Hello" } },
        { version: "v0.9", updateDataModel: { surfaceId: "s", value: { a: 1 } } },
        { version: "v0.9", updateComponents: { surfaceId: "s", components: [{ id: "root", component: "Text", text: "hi" }] } },
      ],
      dropped: { count: 0, interactive: false },
    });
  });

  it("a valid json-render carrier draws through the one validator, under its own title", () => {
    const surface = drawn(carrier({ root: "t", elements: { t: { type: "Text", props: { text: "hi" } } } }, { title: "Hello" }));
    expect(surface).toMatchObject({ surfaceId: "s", catalogId: JSON_RENDER_CATALOG_ID, title: "Hello", interactive: false, degrade: {} });
    expect(surface.root).toEqual({ id: "root", component: "Text", text: "hi", variant: "body" });
  });

  it.each([
    ["0.21.0", true],
    ["0.21.1", true],
    ["0.21.7", true],
    ["0.21", true],
    ["0.22.0", false],
    ["0.20.9", false],
    ["1.0.0", false],
    ["0.21.01", false],
    ["latest", false],
  ])("version %s is known: %s (an unknown one is an envelope fault, never a guess)", (version, known) => {
    const out = validateA2uiCarrier(carrier({ root: "t", elements: { t: { type: "Text", props: { text: "x" } } } }, { version }));
    expect(out.ok ? "ok" : out.reason).toBe(known ? "ok" : "bad-version");
  });

  it.each<[string, JsonValue, string]>([
    ["no version", { format: "json-render", surfaceId: "s", spec: { root: "t", elements: { t: { type: "Text" } } } }, "bad-version"],
    ["a surface id outside the charset", carrier({ root: "t", elements: {} }, { surfaceId: "has space" }), "bad-surface-id"],
    ["no spec", { format: "json-render", version: "0.21.1", surfaceId: "s" }, "bad-shape"],
    ["a spec that is a list", carrier([]), "bad-shape"],
    ["no elements", carrier({ root: "t" }), "bad-shape"],
    ["no root", carrier({ elements: { t: { type: "Text" } } }), "bad-shape"],
    ["a root that names no element", carrier({ root: "x", elements: { t: { type: "Text" } } }), "bad-shape"],
    ["a root that names an inherited key", carrier({ root: "constructor", elements: { t: { type: "Text" } } }), "bad-shape"],
    ["state that is not an object", carrier({ root: "t", elements: { t: { type: "Text" } }, state: [1] }), "bad-shape"],
    ["an element that is not an object", carrier({ root: "t", elements: { t: "Text" } }), "bad-shape"],
    ["an element with no type", carrier({ root: "t", elements: { t: { props: {} } } }), "bad-shape"],
    ["a cycle", caseOf("hostile", "cycle"), "cycle"],
  ])("%s → the envelope fault %s (the old face)", (_label, value, reason) => {
    const out = validateA2uiCarrier(value);
    expect(out).toMatchObject({ ok: false, reason, level: "envelope" });
  });

  it("names its one surface for the close rule, from a valid carrier, an oversize one and a broken one alike (spec §5.7)", () => {
    expect(namedA2uiSurfaceIds(carrier({ root: "t", elements: {} }, { surfaceId: "jr-1" }))).toEqual(["jr-1"]);
    expect(namedA2uiSurfaceIds(carrier("x".repeat(20_000), { surfaceId: "jr-2" }))).toEqual(["jr-2"]);
    expect(namedA2uiSurfaceIds(carrier({}, { surfaceId: "bad id" }))).toEqual([]);
    const out = parseA2uiCarrier(carrier({ root: "x", elements: {} }, { surfaceId: "jr-3" }));
    expect(out).toMatchObject({ ok: false, reason: "bad-shape", surfaceIds: ["jr-3"] });
  });

  it("an unknown format is still not drawn (only json-render is adapted)", () => {
    expect(validateA2uiCarrier({ format: "html", version: "1", surfaceId: "s", spec: {} })).toMatchObject({ ok: false, reason: "unsupported-format" });
  });
});

describe("guuey#2385 — each row of the §12 table", () => {
  it("ids: a key becomes the id, the root is always `root`, a key outside the charset or a stray `root` is re-keyed, references rewritten", () => {
    const ids = components(caseOf("rows", "ids")).map((c) => [c["id"], c["text"] ?? c["component"]]);
    expect(ids).toEqual([
      ["root", "Column"],
      ["e1", "a key outside the charset"],
      ["e2", "an element keyed root that is not the root"],
      ["ok-id", "a key that is already an id"],
      ["e0", "a key that looks like a re-keyed id"],
    ]);
    const surface = drawn(caseOf("rows", "ids"));
    expect(surface.degrade).toEqual({});
    expect(nodes(surface.root).map((n) => n.id)).toEqual(["root", "e1", "e2", "ok-id", "e0"]);
  });

  it.each([
    ...["Row", "HStack", "horizontal"].map((t) => [t, "Row"]),
    ...["Column", "Stack", "VStack", "Box", "Container", "Section", "Form", "FORM"].map((t) => [t, "Column"]),
    ["card", "Card"],
    ["List", "List"],
    ...["Divider", "Separator"].map((t) => [t, "Divider"]),
    ...["Text", "Heading", "Paragraph", "Label", "Badge"].map((t) => [t, "Text"]),
    ...["Image", "Img", "Avatar"].map((t) => [t, "Image"]),
    ["Icon", "Icon"],
    ...["Button", "Link"].map((t) => [t, "Button"]),
    ...["Input", "TextField", "TextInput", "Textarea"].map((t) => [t, "TextField"]),
    ...["Checkbox", "Switch", "Toggle"].map((t) => [t, "CheckBox"]),
    ...["Select", "RadioGroup", "Dropdown", "ChoicePicker"].map((t) => [t, "ChoicePicker"]),
  ])("type %s maps to %s", (type, component) => {
    const [root] = components(carrier({ root: "x", elements: { x: { type, props: { text: "t", label: "l", src: "https://a.example/i.png", name: "n" } } } }));
    expect(root?.["component"]).toBe(component);
  });

  it("every kind draws as its A2UI component, the Card holding its one child, the Link a link button", () => {
    const surface = drawn(caseOf("rows", "every-kind"));
    expect(nodes(surface.root).map((n) => n.component)).toEqual(["Column", "Row", "Text", "Card", "Text", "List", "Text", "Divider", "Image", "Icon", "Button"]);
    expect(node(surface, "img")).toMatchObject({ alt: "Ada" });
    expect(node(surface, "go")).toMatchObject({ label: "Docs", action: null, link: { url: "https://docs.example/start" } });
    expect(surface.degrade).toEqual({});
  });

  it("inputs: Textarea is a long field, Select strings become options, a RadioGroup is never multiple, each bound two-way", () => {
    const surface = drawn(caseOf("rows", "every-input"));
    expect(node(surface, "name")).toMatchObject({ component: "TextField", inputType: "text", value: { path: "/name" }, placeholder: "Ada" });
    expect(node(surface, "note")).toMatchObject({ component: "TextField", inputType: "long" });
    expect(node(surface, "agree")).toMatchObject({ component: "CheckBox", checked: { path: "/agree" } });
    expect(node(surface, "size")).toMatchObject({
      component: "ChoicePicker",
      options: [
        { label: "S", value: "S" },
        { label: "M", value: "M" },
        { label: "L", value: "L" },
      ],
      value: { path: "/size" },
    });
    expect(node(surface, "plan")).toMatchObject({ component: "ChoicePicker", multiple: false });
    expect(surface).toMatchObject({ interactive: true, degrade: {} });
  });

  it("Heading: a level 1–6 (number or h-name) sets the variant, h2 by default", () => {
    const surface = drawn(caseOf("rows", "heading-levels"));
    expect(["h1", "h4", "plain"].map((id) => (node(surface, id) as { variant?: string }).variant)).toEqual(["h1", "h4", "h2"]);
  });

  it("an unknown type is a labeled placeholder, and what it holds is not drawn through it", () => {
    const surface = drawn(caseOf("rows", "unknown-type"));
    expect(nodes(surface.root).map((n) => [n.id, n.component])).toEqual([
      ["root", "Column"],
      ["tabs", "unknown"],
      ["after", "Text"],
    ]);
    expect(surface.degrade).toEqual({ "unknown-component": 1 });
  });

  it("$state: a binding where A2UI takes one, the state's value where it does not", () => {
    const surface = drawn(caseOf("rows", "state"));
    expect(node(surface, "greeting")).toMatchObject({ text: { path: "/greeting" } });
    expect(node(surface, "cta")).toMatchObject({ label: "Open the menu", link: { url: "https://menu.example/m" } });
    expect(surface.dataModel).toMatchObject({ greeting: "Good morning" });
  });

  it("$bindState on the value prop is the two-way binding, its field declared", () => {
    const surface = drawn(caseOf("rows", "bind-state"));
    expect(surface.root).toMatchObject({ component: "TextField", value: { path: "/user/name" } });
    expect(Object.keys(surface.fields)).toEqual(["/user/name"]);
  });

  it("$template substitutes ${/path} lookups once, at conversion (a missing path reads as nothing)", () => {
    expect(drawn(caseOf("rows", "template")).root).toMatchObject({ text: "Hello Ada, you have 3 items." });
  });

  it("repeat unrolls per item: $item and $bindItem become absolute paths, $index the item's number", () => {
    const surface = drawn(caseOf("rows", "repeat"));
    const ids = nodes(surface.root).map((n) => n.id);
    expect(ids).toEqual(["root", "todo.0", "done.0", "num.0", "todo.1", "done.1", "num.1"]);
    expect(node(surface, "done.1")).toMatchObject({ component: "CheckBox", label: "Call Ada", checked: { path: "/todos/1/done" } });
    expect(node(surface, "num.0")).toMatchObject({ text: "0" });
    expect(Object.keys(surface.fields)).toEqual(["/todos/0/done", "/todos/1/done"]);
    expect(surface.degrade).toEqual({});
  });

  it("repeat stops at the List cap (100), each item past it a counted drop", () => {
    const todos = Array.from({ length: 103 }, (_, i) => `t${i}`);
    const value = carrier({
      root: "l",
      elements: { l: { type: "List", props: {}, repeat: { statePath: "/todos" }, children: ["t"] }, t: { type: "Text", props: { text: { $item: "" } } } },
      state: { todos },
    });
    expect(components(value)).toHaveLength(1 + 100);
    expect(jsonRenderToA2ui(value)).toMatchObject({ dropped: { count: 3, interactive: false } });
    expect(drawn(value).degrade).toEqual({ "dropped-construct": 3 });
  });

  it("visible is read once against state; an undocumented form hides the element and counts", () => {
    const surface = drawn(caseOf("rows", "visible"));
    expect(nodes(surface.root).map((n) => n.id)).toEqual(["root", "yes", "truthy", "eq", "and", "or"]);
    expect(surface.degrade).toEqual({ "dropped-construct": 1 });
  });

  it("visible that is not a condition object, or nests past the bound, hides the element and counts", () => {
    let deep: JsonValue = { $state: "/on" };
    for (let i = 0; i < 9; i++) deep = { $and: [deep] };
    const surface = drawn(
      carrier({
        root: "c",
        elements: {
          c: { type: "Column", props: {}, children: ["word", "list", "deep", "shown"] },
          word: { type: "Text", props: { text: "a string" }, visible: "always" },
          list: { type: "Text", props: { text: "a list" }, visible: [true] },
          deep: { type: "Text", props: { text: "nine levels" }, visible: deep },
          shown: { type: "Text", props: { text: "shown" }, visible: { $and: [{ $and: [{ $state: "/on" }] }] } },
        },
        state: { on: true },
      }),
    );
    expect(nodes(surface.root).map((n) => n.id)).toEqual(["root", "shown"]);
    expect(surface.degrade).toEqual({ "dropped-construct": 3 });
  });

  it("on.press → the action with its params as context ($state a binding), confirm and the danger variant kept", () => {
    const surface = drawn(caseOf("rows", "press"));
    expect(node(surface, "book")).toMatchObject({
      component: "Button",
      action: { name: "book_table", context: { when: { path: "/when" }, party: 4, note: "window" } },
      confirm: { title: "Book it?", message: "We hold the table for 15 minutes." },
      variant: "danger",
    });
    expect(surface).toMatchObject({ interactive: true, degrade: {} });
  });

  it("a built-in state action is dropped, so the surface it would act on takes the old face (spec §5.7)", () => {
    expect(components(caseOf("rows", "built-in-actions"))[1]).toEqual({ id: "clear", component: "Button", label: "Clear" });
    expect(validateA2uiCarrier(caseOf("rows", "built-in-actions"))).toMatchObject({ ok: false, reason: "dropped-construct", level: "component" });
  });

  it("slots on a read-only surface: dropped and counted, the card drawn with its title and child", () => {
    const surface = drawn(caseOf("rows", "hooks-watch-slots"));
    expect(nodes(surface.root).map((n) => [n.id, n.component])).toEqual([
      ["root", "Card"],
      ["root.body", "Column"],
      ["root.title", "Text"],
      ["body", "Text"],
    ]);
    expect(node(surface, "root.title")).toMatchObject({ text: "Welcome", variant: "h3" });
    expect(surface.degrade).toEqual({ "dropped-construct": 1 });
  });

  it("watch, onSuccess and preventDefault on a form: each dropped and counted, so the form takes the old face", () => {
    expect(jsonRenderToA2ui(caseOf("rows", "hooks-on-a-form"))).toMatchObject({ dropped: { count: 3, interactive: true } });
    expect(validateA2uiCarrier(caseOf("rows", "hooks-on-a-form"))).toMatchObject({ ok: false, reason: "dropped-construct" });
  });

  it("$cond and $computed are dropped: a Text left with no text is a placeholder, an Image keeps its source", () => {
    const surface = drawn(caseOf("rows", "cond-computed"));
    expect(node(surface, "status")).toMatchObject({ component: "unknown", name: "Text" });
    expect(node(surface, "pic")).toMatchObject({ component: "Image", alt: null });
    expect(surface.degrade).toEqual({ "dropped-construct": 2, "bad-prop": 1 });
  });

  it("checks become field constraints: minLength 1 is required, email and numeric set the input type", () => {
    const surface = drawn(caseOf("rows", "checks"));
    expect(node(surface, "name")).toMatchObject({ required: true, maxLength: 40, inputType: "text" });
    expect(node(surface, "email")).toMatchObject({ required: true, inputType: "email" });
    expect(node(surface, "age")).toMatchObject({ inputType: "number", min: 18, max: 120 });
    expect(node(surface, "terms")).toMatchObject({ component: "CheckBox", required: true });
    expect(surface).toMatchObject({ interactive: true, degrade: {} });
  });

  it("pattern, matches, requiredIf, url and custom checks are dropped, never compiled: no RegExp is built", () => {
    const made = vi.spyOn(globalThis, "RegExp");
    const out = jsonRenderToA2ui(caseOf("rows", "unsupported-checks"));
    expect(out).toMatchObject({ dropped: { count: 5, interactive: false } });
    expect(made).not.toHaveBeenCalled();
    expect(validateA2uiCarrier(caseOf("rows", "unsupported-checks"))).toMatchObject({ ok: false, reason: "dropped-construct" });
  });

  it("minLength above 1 is dropped, never folded into required: a form that needs six characters takes the old face", () => {
    expect(jsonRenderToA2ui(caseOf("rows", "min-length-above-one"))).toMatchObject({ dropped: { count: 1 } });
    expect(validateA2uiCarrier(caseOf("rows", "min-length-above-one"))).toMatchObject({ ok: false, reason: "dropped-construct" });
  });

  it("a check is read by its type only, with args.min / args.max: other names do not read", () => {
    const form = (check: JsonValue): A2uiJsonObject =>
      carrier({
        root: "x",
        elements: { x: { type: "Input", props: { label: "X", value: { $bindState: "/x" }, checks: [check] } } },
        state: { x: "" },
      });
    expect(jsonRenderToA2ui(form({ type: "maxLength", args: { max: 9 } }))).toMatchObject({ dropped: { count: 0 } });
    expect(jsonRenderToA2ui(form({ fn: "maxLength", args: { max: 9 } }))).toMatchObject({ dropped: { count: 1 } });
    expect(jsonRenderToA2ui(form({ type: "maxLength", args: { length: 9 } }))).toMatchObject({ dropped: { count: 1 } });
    expect(jsonRenderToA2ui(form({ type: "minLength", args: { value: 1 } }))).toMatchObject({ dropped: { count: 1 } });
  });
});

describe("guuey#2385 — the README examples", () => {
  it("the form draws natively, every field bound and the submit carrying the values", () => {
    const surface = drawn(caseOf("examples", "form"));
    expect(surface.title).toBe("Contact us");
    expect(Object.keys(surface.fields)).toEqual(["/form/name", "/form/email", "/form/message"]);
    expect(node(surface, "message")).toMatchObject({ inputType: "long", maxLength: 500 });
    expect(node(surface, "send")).toMatchObject({ variant: "primary", action: { name: "submit_contact" } });
    expect(surface.degrade).toEqual({});
  });

  it("the select draws natively, its summary a static template", () => {
    const surface = drawn(caseOf("examples", "select"));
    expect(node(surface, "summary")).toMatchObject({ text: "Current plan: team" });
    expect(surface.degrade).toEqual({});
  });

  it("the watcher example takes the old face: its watcher is dropped on an interactive surface", () => {
    expect(validateA2uiCarrier(caseOf("examples", "watcher"))).toMatchObject({ ok: false, reason: "dropped-construct", level: "component" });
  });
});

describe("guuey#2385 — each expression form degrades, never evaluated", () => {
  it.each<[string, { text?: string; label?: string; variant?: string; alt?: string | null; component?: string }, number]>([
    ["state-in-a-literal-prop", { component: "Button", label: "Read more" }, 0],
    ["state-of-the-wrong-type", { component: "Image", alt: null }, 1],
    ["item-outside-a-repeat", { text: "kept", variant: "body" }, 1],
    ["index-outside-a-repeat", { component: "unknown" }, 1],
    ["cond", { text: "kept", variant: "body" }, 1],
    ["computed", { component: "unknown" }, 1],
    ["template-malformed", { text: "kept", variant: "body" }, 1],
    ["template-object", { component: "unknown" }, 1],
    ["unknown-expression", { component: "unknown" }, 1],
  ])("%s", (name, expected, drops) => {
    const value = caseOf("expressions", name);
    expect(jsonRenderToA2ui(value)).toMatchObject({ dropped: { count: drops } });
    const surface = drawn(value);
    expect(surface.root).toMatchObject(expected);
    expect(surface.degrade["dropped-construct"] ?? 0).toBe(drops);
  });

  it("no eval, no Function, no RegExp from the payload: the adapter's source has none of them", () => {
    const source = readFileSync(new URL("./json-render.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\beval\s*\(|new Function|Function\s*\(|new RegExp|RegExp\s*\(/);
  });
});

describe("guuey#2385 — bounds: the raw carrier and the mapped one", () => {
  it("a raw carrier over the carrier bound is refused before any mapping", () => {
    // The bulk is state no component reads: only the raw bound can see it.
    const value = carrier({ root: "t", elements: { t: { type: "Text", props: { text: "x" } } }, state: { unread: "x".repeat(17_000) } });
    expect(jsonRenderToA2ui(value)).toMatchObject({ ok: false, reason: "too-large", path: "" });
    expect(validateA2uiCarrier(value)).toMatchObject({ ok: false, reason: "too-large", surfaceIds: ["s"] });
  });

  it("a template that inflates past the carrier bound stops the mapping (too-large)", () => {
    const value = carrier({
      root: "t",
      elements: { t: { type: "Text", props: { text: { $template: "${/s}".repeat(500) } } } },
      state: { s: "y".repeat(2_000) },
    });
    expect(validateA2uiCarrier(value)).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("a mapped carrier is measured again: a repeat that unrolls past the carrier bound is too large", () => {
    const value = carrier({
      root: "l",
      elements: {
        l: { type: "List", props: {}, repeat: { statePath: "/rows" }, children: ["t"] },
        t: { type: "Text", props: { text: { $state: "/long" } }, visible: true },
      },
      state: { rows: Array.from({ length: 60 }, (_, i) => i), long: "z".repeat(300) },
    });
    // 60 clones of a binding fit; the state they read does not inflate them.
    expect(validateA2uiCarrier(value).ok).toBe(true);
    const literal = carrier({
      root: "l",
      elements: { l: { type: "List", props: {}, repeat: { statePath: "/rows" }, children: ["t"] }, t: { type: "Button", props: { label: { $state: "/long" } } } },
      state: { rows: Array.from({ length: 100 }, (_, i) => i), long: "z".repeat(190) },
    });
    // A literal read from state is copied into each clone: 100 × ~230 units is past 16 384.
    expect(validateA2uiCarrier(literal)).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("the validator measures the whole mapped carrier: components within the bound plus the state past it is too large", () => {
    const value = carrier({
      root: "l",
      elements: { l: { type: "List", props: {}, repeat: { statePath: "/rows" }, children: ["b"] }, b: { type: "Button", props: { label: { $state: "/l" } } } },
      state: { rows: Array.from({ length: 100 }, (_, i) => i), l: "m".repeat(60), pad: "p".repeat(7_400) },
    });
    expect(a2uiUnits(value)).toBeLessThan(A2UI_LIMITS.carrierUnits);
    const adapted = jsonRenderToA2ui(value);
    expect(adapted.ok).toBe(true);
    // The components alone fit; with the data model the mapped carrier does not.
    expect(a2uiUnits(components(value))).toBeLessThan(A2UI_LIMITS.carrierUnits);
    expect(adapted.ok ? a2uiUnits({ format: "a2ui", version: "v0.9", messages: adapted.messages }) : 0).toBeGreaterThan(A2UI_LIMITS.carrierUnits);
    expect(validateA2uiCarrier(value)).toMatchObject({ ok: false, reason: "too-large", surfaceIds: ["s"] });
  });

  it("an unrolled repeat past the component bound is an envelope fault, and a nested one stops there too", () => {
    const value = carrier({
      root: "l",
      elements: {
        l: { type: "List", props: {}, repeat: { statePath: "/rows" }, children: ["a", "b", "c"] },
        a: { type: "Divider", props: {} },
        b: { type: "Divider", props: {} },
        c: { type: "Divider", props: {} },
      },
      state: { rows: Array.from({ length: 100 }, (_, i) => i) },
    });
    expect(validateA2uiCarrier(value)).toMatchObject({ ok: false, reason: "too-many-components" });
    const started = performance.now();
    expect(validateA2uiCarrier(caseOf("hostile", "nested-repeat"))).toMatchObject({ ok: false, reason: "too-many-components" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("depth: a chain at the tree bound draws, one deeper is an envelope fault", () => {
    const chain = (depth: number): A2uiJsonObject => {
      const elements: A2uiJsonObject = {};
      for (let i = 0; i < depth - 1; i++) elements[`c${i}`] = { type: "Column", props: {}, children: [`c${i + 1}`] };
      elements[`c${depth - 1}`] = { type: "Text", props: { text: "bottom" } };
      return carrier({ root: "c0", elements });
    };
    expect(nodes(drawn(chain(A2UI_LIMITS.treeDepth)).root)).toHaveLength(A2UI_LIMITS.treeDepth);
    expect(validateA2uiCarrier(chain(A2UI_LIMITS.treeDepth + 1))).toMatchObject({ ok: false, reason: "too-deep" });
  });

  it("huge strings inside the bound are cut by the A2UI limits, as for any carrier", () => {
    const surface = drawn(
      carrier({
        root: "c",
        elements: {
          c: { type: "Column", props: {}, children: ["t", "b"] },
          t: { type: "Text", props: { text: "w".repeat(5_000) } },
          b: { type: "Button", props: { label: "l".repeat(500) } },
        },
      }),
    );
    expect((node(surface, "t") as { text: string }).text).toHaveLength(A2UI_LIMITS.textUnits);
    expect((node(surface, "b") as { label: string }).label).toHaveLength(A2UI_LIMITS.labelUnits);
    expect(surface.degrade).toEqual({ "truncated-text": 1, "truncated-label": 1 });
  });
});

describe("guuey#2385 — hostile carriers", () => {
  it("javascript: URLs are never links or images: an inert button, a chip, inert text (in place, spec §5.7)", () => {
    const surface = drawn(caseOf("hostile", "javascript-urls"));
    expect(node(surface, "link")).toMatchObject({ component: "Button", link: null, action: null });
    expect(node(surface, "pic")).toMatchObject({ component: "Image", display: { kind: "chip" } });
    expect(surface.degrade).toMatchObject({ "refused-link": 1, "refused-image": 1 });
  });

  it("prototype keys are data: an element keyed __proto__ draws, inherited names dangle, nothing is polluted", () => {
    const surface = drawn(caseOf("hostile", "prototype-keys"));
    expect(nodes(surface.root).map((n) => [n.id, n.component])).toEqual([
      ["root", "Column"],
      ["__proto__", "Text"],
    ]);
    expect(node(surface, "__proto__")).toMatchObject({ text: { path: "/__proto__/polluted" } });
    expect(surface.degrade).toEqual({ "dangling-child": 2 });
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });

  it("a __proto__ action param is an own context key, never a prototype, and the validator refuses the action", () => {
    const [button] = components(caseOf("hostile", "prototype-params"));
    const action = button?.["action"];
    expect(typeof action === "object" && action !== null && !Array.isArray(action) ? Object.keys(action["context"] ?? {}) : []).toEqual([
      "__proto__",
      "constructor",
    ]);
    expect(({} as { x?: string }).x).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    // The press would otherwise reach the agent without the key: the form takes the old face.
    expect(validateA2uiCarrier(caseOf("hostile", "prototype-params"))).toMatchObject({ ok: false, reason: "bad-prop" });
  });

  it("a type named constructor or __proto__ is an unknown type, a placeholder", () => {
    const surface = drawn(caseOf("hostile", "constructor-type"));
    expect(nodes(surface.root).map((n) => n.component)).toEqual(["Column", "unknown", "unknown"]);
  });

  it("an Input of type password is dropped as an input, so its form takes the old face", () => {
    expect(jsonRenderToA2ui(caseOf("hostile", "password"))).toMatchObject({ dropped: { count: 1, interactive: true } });
    expect(validateA2uiCarrier(caseOf("hostile", "password"))).toMatchObject({ ok: false, reason: "dropped-construct" });
  });
});
