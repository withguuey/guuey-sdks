// guuey#2381 — writes the frozen preview-a2ui conformance vectors
// (fixtures/preview-a2ui-0.29.0-vectors.json, read by a2ui/conformance.test.ts).
//
//   pnpm vectors:a2ui
//   node src/corpus/a2ui-preview-vectors.mjs [<dir of @ggui-ai/preview-a2ui@0.29.0>]
//
// With no argument the package is found in node_modules the way it is
// installed: this package does not depend on it, @ggui-ai/iframe-runtime
// does, so it is resolved through that package (no dependency is added here).
//
// Version: the spec names preview-a2ui 0.25.0; the lockfile resolves 0.29.0
// (the @ggui-ai family pin), so 0.29.0 is the release a guuey surface meets
// and the one these vectors are judged against.
//
// The verdict is preview's own, per vector: every message of every vector is
// run through the package's parseServerMessage, and the file is not written
// unless each one is accepted. A conformance vector (package-example,
// generated, edge) must then be accepted by guuey and draw every component as
// the same kind; a divergence vector is one preview accepts and guuey refuses
// on purpose, with the refusal it must give.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The installed preview-a2ui's package dir, reached through @ggui-ai/iframe-runtime, the package that depends on it. */
function installedPreviewDir() {
  let runtimeEntry;
  try {
    runtimeEntry = createRequire(import.meta.url).resolve("@ggui-ai/iframe-runtime");
  } catch (cause) {
    throw new Error("@ggui-ai/iframe-runtime is not installed where this package can reach it: install the workspace, or pass the preview-a2ui dir", { cause });
  }
  const previewEntry = createRequire(runtimeEntry).resolve("@ggui-ai/preview-a2ui");
  for (let dir = dirname(previewEntry); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@ggui-ai/preview-a2ui") return dir;
  }
  throw new Error(`no @ggui-ai/preview-a2ui package.json above ${previewEntry}`);
}

const previewDir = process.argv[2] ?? installedPreviewDir();
const previewPkg = JSON.parse(readFileSync(join(previewDir, "package.json"), "utf8"));
if (previewPkg.name !== "@ggui-ai/preview-a2ui" || previewPkg.version !== "0.29.0") {
  throw new Error(`expected @ggui-ai/preview-a2ui@0.29.0, got ${previewPkg.name}@${previewPkg.version}`);
}
const { parseServerMessage } = await import(pathToFileURL(join(previewDir, "dist/messages.js")).href);
const OUT = new URL("./fixtures/preview-a2ui-0.29.0-vectors.json", import.meta.url);

const V = "v0.9";
const CAT = "ggui.preview.v1";
const create = (surfaceId, extra = {}) => ({ version: V, createSurface: { surfaceId, catalogId: CAT, ...extra } });
const update = (surfaceId, components) => ({ version: V, updateComponents: { surfaceId, components } });
const del = (surfaceId) => ({ version: V, deleteSurface: { surfaceId } });
const t = (id, text = "item") => ({ id, component: "Text", text });

const vectors = [];
const add = (name, origin, messages, surfaces) => vectors.push({ name, origin, messages, surfaces });
const drawn = (surfaceId, kinds, carveOuts = {}) => ({ surfaceId, outcome: "drawn", kinds, carveOuts });

// ── The package's own example: the deterministic emitter's frames (dist/emitters/deterministic.js) ──
const heading = (intent) => {
  const first = intent.trim().split(/[.!?\n]/)[0].trim();
  return first.charAt(0).toUpperCase() + first.slice(1);
};
const shells = {
  none: { ids: [], fragments: [] },
  form: {
    ids: ["form-card"],
    fragments: [
      { id: "form-card", component: "Card", child: "form-col" },
      { id: "form-col", component: "Column", children: ["tf", "btn"], gap: "8" },
      { id: "tf", component: "TextField", label: "Input" },
      { id: "btn", component: "Button", label: "Submit" },
    ],
  },
  list: {
    ids: ["list-card"],
    fragments: [
      { id: "list-card", component: "Card", child: "list" },
      { id: "list", component: "List", children: ["l1", "l2", "l3"] },
      { id: "l1", component: "Text", variant: "body", text: "—" },
      { id: "l2", component: "Text", variant: "body", text: "—" },
      { id: "l3", component: "Text", variant: "body", text: "—" },
    ],
  },
};
for (const [shell, intent] of [
  ["none", "plan a weekend in Lisbon."],
  ["form", "build a sign up form for the beta."],
  ["list", "show my todos for today."],
]) {
  const s = "session-1";
  const { ids, fragments } = shells[shell];
  const messages = [
    create(s),
    update(s, [
      { id: "root", component: "Column", children: ["heading"], gap: "12", align: "stretch" },
      { id: "heading", component: "Text", variant: "h2", text: heading(intent) },
    ]),
    update(s, [
      { id: "root", component: "Column", children: ["heading", "body", ...ids], gap: "12", align: "stretch" },
      { id: "body", component: "Text", variant: "caption", text: intent },
      ...fragments,
    ]),
  ];
  const kinds = { root: "Column", heading: "Text", body: "Text" };
  for (const f of fragments) kinds[f.id] = f.component;
  add(`deterministic emitter, ${shell} shell (3 frames)`, "package-example", messages, [drawn(s, kinds)]);
}

// ── Generated: each of the 12 shapes, required fields only and every field preview defines ──
const shapes = {
  Row: [{ children: ["c1", "c2"] }, { children: ["c1", "c2"], gap: "16", align: "center", justify: "between" }],
  Column: [{}, { children: ["c1", "c2"], gap: "md", align: "end", justify: "evenly" }],
  Card: [{}, { child: "c1" }],
  List: [{}, { children: ["c1", "c2"] }],
  Divider: [{}, { orientation: "vertical" }],
  Text: [{ text: "Hello" }, { text: "Hello", variant: "h1" }],
  Image: [{ src: "data:image/png;base64,iVBORw0KGgo=" }, { src: "data:image/png;base64,iVBORw0KGgo=", alt: "A dot" }],
  Icon: [{ name: "star" }, { name: "star" }],
  Button: [{ label: "Go" }, { label: "Go" }],
  TextField: [{}, { label: "Name", placeholder: "Your name", value: "Ada" }],
  CheckBox: [{}, { label: "Agree", checked: true }],
  ChoicePicker: [
    {},
    {
      label: "Size",
      options: [
        { label: "Small", value: "s" },
        { label: "Large", value: "l" },
      ],
      value: "s",
    },
  ],
};
for (const [component, [min, full]] of Object.entries(shapes)) {
  for (const [variant, props] of [
    ["required only", min],
    ["every preview field", full],
  ]) {
    const s = `gen-${component.toLowerCase()}`;
    const refs = [...(props.children ?? []), ...(props.child ? [props.child] : [])];
    const kinds = { root: component };
    for (const r of refs) kinds[r] = "Text";
    add(`${component}, ${variant}`, "generated", [create(s), update(s, [{ id: "root", component, ...props }, ...refs.map((r) => t(r))])], [
      drawn(s, kinds),
    ]);
  }
}
// Every enum value preview defines, and free-string props with values outside guuey's tokens.
for (const align of ["start", "center", "end", "stretch"]) {
  add(`Row align ${align}`, "generated", [create("g"), update("g", [{ id: "root", component: "Row", align }])], [drawn("g", { root: "Row" })]);
}
for (const justify of ["start", "center", "end", "between", "around", "evenly"]) {
  add(`Column justify ${justify}`, "generated", [create("g"), update("g", [{ id: "root", component: "Column", justify }])], [
    drawn("g", { root: "Column" }),
  ]);
}
for (const orientation of ["horizontal", "vertical"]) {
  add(`Divider ${orientation}`, "generated", [create("g"), update("g", [{ id: "root", component: "Divider", orientation }])], [
    drawn("g", { root: "Divider" }),
  ]);
}
for (const gap of ["", "0", "12", "none", "xl", "calc(1px)"]) {
  add(`Row gap ${JSON.stringify(gap)}`, "generated", [create("g"), update("g", [{ id: "root", component: "Row", gap }])], [drawn("g", { root: "Row" })]);
}
for (const variant of ["", "h3", "caption", "label", "display", "x;color:red"]) {
  add(`Text variant ${JSON.stringify(variant)}`, "generated", [create("g"), update("g", [{ id: "root", component: "Text", text: "Hi", variant }])], [
    drawn("g", { root: "Text" }),
  ]);
}

// ── Edge cases ──
add("empty components (a legal no-op)", "edge", [create("e"), update("e", [])], [drawn("e", {})]);
add("updateComponents with no createSurface first (an orphan: accepted, drawn nowhere)", "edge", [update("e", [t("root", "Orphan")])], [
  { surfaceId: "e", outcome: "ignored", kinds: {}, carveOuts: {} },
]);
add("createSurface then deleteSurface", "edge", [create("e"), update("e", [t("root")]), del("e")], [{ surfaceId: "e", outcome: "deleted", kinds: {}, carveOuts: {} }]);
add(
  "unknown extra fields on the message, the payload and each component (stripped)",
  "edge",
  [
    { version: V, createSurface: { surfaceId: "e", catalogId: CAT, theme: { primary: "#000" } }, sentAt: 1 },
    { version: V, updateComponents: { surfaceId: "e", components: [{ id: "root", component: "Column", children: ["a"], weight: 2 }, { id: "a", component: "Text", text: "x", color: "red" }], extra: true } },
  ],
  [drawn("e", { root: "Column", a: "Text" })],
);
add("an id replaced by a later batch (the replace key)", "edge", [create("e"), update("e", [t("root", "one")]), update("e", [{ id: "root", component: "Divider" }])], [
  drawn("e", { root: "Divider" }),
]);
add("empty strings where preview allows them (Text text, Button label, labels)", "edge", [
  create("e"),
  update("e", [
    { id: "root", component: "Column", children: ["a", "b", "c"] },
    { id: "a", component: "Text", text: "" },
    { id: "b", component: "Button", label: "" },
    { id: "c", component: "TextField", label: "", placeholder: "", value: "" },
  ]),
], [drawn("e", { root: "Column", a: "Text", b: "Button", c: "TextField" })]);
add("empty child and option lists", "edge", [
  create("e"),
  update("e", [
    { id: "root", component: "Column", children: ["l", "p"] },
    { id: "l", component: "List", children: [] },
    { id: "p", component: "ChoicePicker", options: [] },
  ]),
], [drawn("e", { root: "Column", l: "List", p: "ChoicePicker" })]);
add("an Image src preview takes and policy A refuses: still an Image (its chip)", "edge", [
  create("e"),
  update("e", [{ id: "root", component: "Image", src: "http://example.com/a.png", alt: "a" }]),
], [drawn("e", { root: "Image" }, { "refused-image": 1 })]);
add("an off-policy https Image: still an Image (a link with its host)", "edge", [
  create("e"),
  update("e", [{ id: "root", component: "Image", src: "https://example.com/a.png" }]),
], [drawn("e", { root: "Image" }, { "refused-image": 1 })]);
add("an unknown Icon name: still an Icon (the host draws nothing)", "edge", [create("e"), update("e", [{ id: "root", component: "Icon", name: "no-such-icon" }])], [
  drawn("e", { root: "Icon" }),
]);
add("two surfaces in one sequence", "edge", [create("a"), create("b"), update("a", [t("root", "A")]), update("b", [t("root", "B")])], [
  drawn("a", { root: "Text" }),
  drawn("b", { root: "Text" }),
]);
add("ids that are valid in both (charset letters, digits, _ . : -)", "edge", [
  create("Surface_1.a:b-c"),
  update("Surface_1.a:b-c", [{ id: "root", component: "Card", child: "x.y:z-0_9" }, t("x.y:z-0_9")]),
], [drawn("Surface_1.a:b-c", { root: "Card", "x.y:z-0_9": "Text" })]);

// ── Deliberate divergences: preview accepts these, guuey refuses them ──
// An interactive surface with a prop guuey types but cannot honour must not
// draw (spec §5.6); preview strips or loosely types these props instead.
const refused = (name, messages, reason, level) => vectors.push({ name, origin: "divergence", messages, refused: { reason, level } });
const one = (component) => [create("d"), update("d", [{ id: "root", ...component }])];
refused("TextField min without inputType number", one({ component: "TextField", label: "Age", min: 1 }), "bad-prop", "component");
refused("TextField min with inputType text", one({ component: "TextField", label: "Age", inputType: "text", min: 1 }), "bad-prop", "component");
refused("Button action as a bare string", one({ component: "Button", label: "Go", action: "go" }), "bad-prop", "component");
refused("Button action as {event}", one({ component: "Button", label: "Go", action: { event: { name: "go" } } }), "bad-prop", "component");
refused("TextField maxLength over guuey's bound (1e9)", one({ component: "TextField", label: "Bio", maxLength: 1e9 }), "bad-prop", "component");
refused(
  "action.context binding whose path does not read (\"nope\")",
  one({ component: "Button", label: "Go", action: { name: "go", context: { a: { path: "nope" } } } }),
  "bad-path",
  "envelope",
);

// ── preview's verdict, per vector ──
for (const vector of vectors) {
  for (const [i, message] of vector.messages.entries()) {
    const verdict = parseServerMessage(message);
    if (!verdict.ok) throw new Error(`preview refuses ${vector.name} message ${i}: ${JSON.stringify(verdict.issues)}`);
  }
  vector.preview = "accepted";
}

const file = {
  source: {
    package: "@ggui-ai/preview-a2ui",
    version: "0.29.0",
    integrity: "sha512-7HdimOlfrhKVctZthdRnzacNI0Wtt9atHyxrCx1FU6/ezJBHXN8QAEJySSZD4nKUPMtA48ZVG9i1nIjso3DmIA==",
    read: ["dist/messages.js", "dist/components.js", "dist/emitters/deterministic.js"],
    generator: "src/corpus/a2ui-preview-vectors.mjs",
  },
  scope:
    "Every vector is a message sequence the package's parseServerMessage accepts, one message at a time (its verdict is recorded per vector). The conformance set keeps to guuey's id charset, its §6 bounds, and reference-complete trees: an id outside the charset, an over-bound value or a dangling child are guuey's refusals or degrades, pinned in validate.test.ts and fold.test.ts. The divergence vectors are guuey's deliberate refusals of what preview accepts (spec §5.6): a TextField min without inputType number, a Button action that is not {name, context?}, a TextField maxLength over guuey's bound, and a binding path that does not read.",
  vectors,
};
writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
console.log(`${vectors.length} vectors, every one accepted by preview-a2ui@0.29.0`);
