// @vitest-environment jsdom
/**
 * guuey#2382 — the web kit draws the `a2ui` plan item (spec §5.3, §5.4, §7,
 * §9.1.5; S2 RED (a)–(g)).
 *
 * Every fixture goes through the planner from a carrier, so what reaches the
 * renderer is what a real result would hand it: the planner decides what an
 * image loads and which links survive, and the renderer draws what the item
 * says.
 *
 * - (a) each of the 12 components, and each prop mapping through its closed table;
 * - (b) the hostile-payload suite, then a scan of the whole surface for any
 *   element or attribute outside the mapping table;
 * - (c) labels, roles and the keyboard order of the inputs;
 * - (d) no `dangerouslySetInnerHTML` in the renderer;
 * - (e) a link shows its host;
 * - (f) `Text`'s inline-only formatting;
 * - (g) `ChoicePicker`: up to 6 inline, 7 and more behind a field row, the
 *   filter above 12, nothing of the filter in the data.
 * - Local edits are transcript state (§5.4): they survive the row remounting,
 *   and a newer server value wins for its path while untouched edits stay.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgBlock, AgReduceResult, JsonValue } from "@silverprotocol/core";
import { planTranscript } from "../plan.js";
import { calmPolicy, type TranscriptPolicy } from "../policy.js";
import { defaultChatStrings } from "../strings.js";
import { isPolicyAImageSrc } from "../a2ui/url-policy.js";
import type { TranscriptInputs, TranscriptPlan } from "../types.js";
import { Transcript, type TranscriptProps } from "./transcript.js";
import type { A2uiIconProps } from "./a2ui.js";

afterEach(cleanup);

type Json = JsonValue;
const V = "v0.9";
const S = defaultChatStrings;
const on = (policy: TranscriptPolicy = calmPolicy()): TranscriptPolicy => ({ ...policy, a2ui: { render: true } });

const create = (surfaceId: string, title?: string): Json => ({
  version: V,
  createSurface: { surfaceId, catalogId: "guuey.a2ui.v1", ...(title !== undefined ? { title } : {}) },
});
const components = (surfaceId: string, list: Json[]): Json => ({ version: V, updateComponents: { surfaceId, components: list } });
const dataModel = (surfaceId: string, value: Json): Json => ({ version: V, updateDataModel: { surfaceId, value } });
const carrier = (messages: Json[]): Json => ({ format: "a2ui", version: V, messages });

type ToolResultBlock = Extract<AgBlock, { type: "tool-result" }>;

/** One call per carrier, each result in its own tool message: the facet's fold. */
function fold(...carriers: Json[][]): AgReduceResult {
  return {
    messages: carriers.flatMap((messages, i) => {
      const id = `t${i + 1}`;
      const result: ToolResultBlock = {
        type: "tool-result",
        toolCallId: id,
        content: [{ type: "text", text: `summary of ${id}` }],
        structuredContent: { "com.guuey/a2ui": carrier(messages) },
      };
      return [
        { id: `m-${id}`, role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: id, name: "show_form", input: {} }] },
        { id: `r-${id}`, role: "tool" as const, content: [result] },
      ];
    }),
    artifacts: [],
    memory: [],
    turns: [],
  };
}

function inputsOf(result: AgReduceResult): TranscriptInputs {
  return {
    result,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [{ role: "user", text: "go" }],
  };
}

const planOf = (carriers: Json[][], policy: TranscriptPolicy = on()): TranscriptPlan => planTranscript(inputsOf(fold(...carriers)), policy);

const noop = { onToggle: vi.fn(), resolvedMounts: new Map(), onViewPhase: vi.fn() };

function drawPlan(plan: TranscriptPlan, extra: Partial<TranscriptProps> = {}) {
  return render(<Transcript plan={plan} window={false} {...noop} {...extra} />);
}

/** One surface, `root` first, drawn through the planner and the transcript. */
function draw(list: Json[], opts: { model?: Json; title?: string; extra?: Partial<TranscriptProps> } = {}) {
  const messages = [create("s", opts.title), components("s", list)];
  if (opts.model !== undefined) messages.push(dataModel("s", opts.model));
  const plan = planOf([messages]);
  const a2ui = plan.items.filter((i) => i.kind === "a2ui");
  expect(a2ui, "the carrier drew one surface").toHaveLength(1);
  const view = drawPlan(plan, opts.extra);
  const surface = view.container.querySelector<HTMLElement>(".guuey-chat-a2ui");
  if (surface === null) throw new Error("no .guuey-chat-a2ui drawn");
  return { ...view, surface, plan };
}

/** Focusable controls in DOM order: what Tab walks. */
function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select")).filter(
    (el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
  );
}

// ─── (a) the 12 components ──────────────────────────────────────────────

describe("(a) each component, and each prop through its closed table", () => {
  it("Column and Row: children in order, gap/align/justify as kit classes", () => {
    const { surface } = draw([
      { id: "root", component: "Column", children: ["r"], gap: "lg", align: "center", justify: "between" },
      { id: "r", component: "Row", children: ["a", "b"], gap: "xs", align: "end", justify: "evenly" },
      { id: "a", component: "Text", text: "first" },
      { id: "b", component: "Text", text: "second" },
    ]);
    const column = surface.querySelector(".guuey-chat-a2ui-column")!;
    expect(column.className.split(" ").sort()).toEqual(
      ["guuey-chat-a2ui-column", "guuey-chat-a2ui-gap-lg", "guuey-chat-a2ui-align-center", "guuey-chat-a2ui-justify-between"].sort(),
    );
    const row = column.querySelector(".guuey-chat-a2ui-row")!;
    expect(row.className.split(" ").sort()).toEqual(
      ["guuey-chat-a2ui-row", "guuey-chat-a2ui-gap-xs", "guuey-chat-a2ui-align-end", "guuey-chat-a2ui-justify-evenly"].sort(),
    );
    expect(Array.from(row.children).map((c) => c.textContent)).toEqual(["first", "second"]);
  });

  it("a container with no align/justify gets the gap class only, md when unstated", () => {
    const { surface } = draw([{ id: "root", component: "Row", children: ["a"] }, { id: "a", component: "Text", text: "x" }]);
    expect(surface.querySelector(".guuey-chat-a2ui-row")!.className).toBe("guuey-chat-a2ui-row guuey-chat-a2ui-gap-md");
  });

  it("Card wraps its one child", () => {
    const { surface } = draw([{ id: "root", component: "Card", child: "t" }, { id: "t", component: "Text", text: "inside" }]);
    expect(surface.querySelector(".guuey-chat-a2ui-card")?.textContent).toBe("inside");
  });

  it("List: a list with one item per child", () => {
    const { surface } = draw([
      { id: "root", component: "List", children: ["a", "b", "c"] },
      { id: "a", component: "Text", text: "one" },
      { id: "b", component: "Text", text: "two" },
      { id: "c", component: "Text", text: "three" },
    ]);
    const list = within(surface).getByRole("list");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["one", "two", "three"]);
  });

  it("Divider: a separator, vertical when it says so", () => {
    const { surface } = draw([
      { id: "root", component: "Row", children: ["h", "v"] },
      { id: "h", component: "Divider" },
      { id: "v", component: "Divider", orientation: "vertical" },
    ]);
    const [h, v] = within(surface).getAllByRole("separator");
    expect(h!.getAttribute("aria-orientation")).toBe("horizontal");
    expect(v!.getAttribute("aria-orientation")).toBe("vertical");
    expect(v!.className).toBe("guuey-chat-a2ui-divider guuey-chat-a2ui-divider-vertical");
  });

  it("Text: h1–h6 are headings at their level, the rest paragraphs with a variant class, all in a bidi isolate", () => {
    const { surface } = draw([
      { id: "root", component: "Column", children: ["h", "b", "c", "l"] },
      { id: "h", component: "Text", text: "Title", variant: "h3" },
      { id: "b", component: "Text", text: "Body" },
      { id: "c", component: "Text", text: "Small", variant: "caption" },
      { id: "l", component: "Text", text: "Tag", variant: "label" },
    ]);
    const heading = within(surface).getByRole("heading", { name: "Title" });
    expect(heading.getAttribute("aria-level")).toBe("3");
    expect(heading.className).toBe("guuey-chat-a2ui-text guuey-chat-a2ui-text-h3");
    const texts = Array.from(surface.querySelectorAll(".guuey-chat-a2ui-text"));
    expect(texts.map((t) => [t.tagName, t.className.replace("guuey-chat-a2ui-text ", ""), t.getAttribute("dir")])).toEqual([
      ["DIV", "guuey-chat-a2ui-text-h3", "auto"],
      ["P", "guuey-chat-a2ui-text-body", "auto"],
      ["P", "guuey-chat-a2ui-text-caption", "auto"],
      ["P", "guuey-chat-a2ui-text-label", "auto"],
    ]);
  });

  it("Text bound to a path reads the data model", () => {
    const { surface } = draw([{ id: "root", component: "Text", text: { path: "/greeting" } }], { model: { greeting: "Hello, Ada" } });
    expect(surface.querySelector(".guuey-chat-a2ui-text")?.textContent).toBe("Hello, Ada");
  });

  it("Image: a policy-A source on the media origins loads, full width, with its alt", () => {
    const { surface } = draw([{ id: "root", component: "Image", src: "https://cdn.guueyusercontent.com/a.png", alt: "A chart" }]);
    const img = within(surface).getByRole("img", { name: "A chart" });
    expect(img.getAttribute("src")).toBe("https://cdn.guueyusercontent.com/a.png");
    expect(img.className).toBe("guuey-chat-a2ui-image");
  });

  it("Image: an off-policy https source is a chip with its alt and an Open link that shows the host, never an <img>", () => {
    const { surface } = draw([{ id: "root", component: "Image", src: "https://pics.example/p.png", alt: "Holiday" }]);
    expect(surface.querySelector("img")).toBeNull();
    const chip = surface.querySelector(".guuey-chat-a2ui-image-chip")!;
    expect(chip.textContent).toBe(`Holiday ${S.mediaOpenLink} · pics.example`);
    const open = within(chip as HTMLElement).getByRole("link");
    expect(open.getAttribute("href")).toBe("https://pics.example/p.png");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(open.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("Image: a source that is neither is a plain chip, the alt or the kit's word", () => {
    const { surface } = draw([
      { id: "root", component: "Row", children: ["a", "b"] },
      { id: "a", component: "Image", src: "http://plain.example/p.png", alt: "Plain" },
      { id: "b", component: "Image", src: "ftp://x.example/p.png" },
    ]);
    expect(surface.querySelector("img")).toBeNull();
    expect(surface.querySelector("a")).toBeNull();
    expect(Array.from(surface.querySelectorAll(".guuey-chat-a2ui-image-chip")).map((c) => c.textContent)).toEqual(["Plain", S.a2uiImage]);
  });

  it("Image: an image that fails to load falls back to its chip", () => {
    const { surface } = draw([{ id: "root", component: "Image", src: "https://cdn.guueyusercontent.com/a.png", alt: "A chart" }]);
    fireEvent.error(surface.querySelector("img")!);
    expect(surface.querySelector("img")).toBeNull();
    expect(surface.querySelector(".guuey-chat-a2ui-image-chip")?.textContent).toBe("A chart");
  });

  it("Icon: drawn by the host's icon component with its name and label; with none it draws nothing", () => {
    const list: Json[] = [
      { id: "root", component: "Row", children: ["i", "t"] },
      { id: "i", component: "Icon", name: "star", label: "Favourite" },
      { id: "t", component: "Text", text: "x" },
    ];
    const without = draw(list);
    expect(without.surface.querySelector(".guuey-chat-a2ui-row")!.children).toHaveLength(1);
    cleanup();
    const seen: A2uiIconProps[] = [];
    const HostIcon = (props: A2uiIconProps) => {
      seen.push(props);
      return <span data-testid="host-icon" />;
    };
    const withHost = draw(list, { extra: { a2uiIcon: HostIcon } });
    expect(within(withHost.surface).getByTestId("host-icon")).toBeTruthy();
    expect(seen.at(-1)).toEqual({ name: "star", label: "Favourite" });
  });

  it("Button: an action button is disabled with the one 'Not available here' note it is described by (§9.1.5)", () => {
    const { surface } = draw([
      { id: "root", component: "Row", children: ["a", "b"] },
      { id: "a", component: "Button", label: "Save", action: { name: "save" }, variant: "primary" },
      { id: "b", component: "Button", label: "Discard", action: { name: "discard" }, variant: "danger" },
    ]);
    const save = within(surface).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    const discard = within(surface).getByRole("button", { name: "Discard" }) as HTMLButtonElement;
    expect([save.disabled, discard.disabled]).toEqual([true, true]);
    expect(save.className).toBe("guuey-chat-a2ui-button guuey-chat-a2ui-button-primary");
    expect(discard.className).toBe("guuey-chat-a2ui-button guuey-chat-a2ui-button-danger");
    const notes = surface.querySelectorAll(".guuey-chat-a2ui-unavailable");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toBe(S.a2uiUnavailable);
    expect(save.getAttribute("aria-describedby")).toBe(notes[0]!.id);
    expect(discard.getAttribute("aria-describedby")).toBe(notes[0]!.id);
  });

  it("Button: a link opens in a new tab and shows its host beside its label (§7.3)", () => {
    const { surface } = draw([{ id: "root", component: "Button", label: "Open", href: "https://docs.example/guide" }]);
    const link = within(surface).getByRole("link", { name: "Open · docs.example" });
    expect(link.getAttribute("href")).toBe("https://docs.example/guide");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(link.className).toBe("guuey-chat-a2ui-button guuey-chat-a2ui-button-secondary");
    expect(surface.querySelector(".guuey-chat-a2ui-unavailable")).toBeNull();
  });

  it("Button: with neither action nor link it is inert, drawn disabled, and needs no note", () => {
    const { surface } = draw([{ id: "root", component: "Button", label: "Nothing" }]);
    expect((within(surface).getByRole("button", { name: "Nothing" }) as HTMLButtonElement).disabled).toBe(true);
    expect(surface.querySelector(".guuey-chat-a2ui-unavailable")).toBeNull();
  });

  it("TextField: labelled, typed by inputType, bounded by maxLength/min/max, required as aria-required", () => {
    const { surface } = draw([
      { id: "root", component: "Column", children: ["n", "bio", "age", "mail"] },
      { id: "n", component: "TextField", label: "Name", placeholder: "Your name", value: { path: "/name" }, required: true, maxLength: 40 },
      { id: "bio", component: "TextField", label: "About you", inputType: "long", value: { path: "/bio" } },
      { id: "age", component: "TextField", label: "Age", inputType: "number", min: 18, max: 120, value: { path: "/age" } },
      { id: "mail", component: "TextField", label: "Email", inputType: "email", value: { path: "/mail" } },
    ]);
    const name = within(surface).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect([name.tagName, name.type, name.placeholder, name.maxLength, name.getAttribute("aria-required")]).toEqual([
      "INPUT",
      "text",
      "Your name",
      40,
      "true",
    ]);
    expect(within(surface).getByRole("textbox", { name: "About you" }).tagName).toBe("TEXTAREA");
    const age = within(surface).getByRole("spinbutton", { name: "Age" }) as HTMLInputElement;
    expect([age.type, age.min, age.max]).toEqual(["number", "18", "120"]);
    expect((within(surface).getByRole("textbox", { name: "Email" }) as HTMLInputElement).type).toBe("email");
  });

  it("TextField: typing is a local edit a bound Text reads at once", () => {
    const { surface } = draw(
      [
        { id: "root", component: "Column", children: ["n", "echo"] },
        { id: "n", component: "TextField", label: "Name", value: { path: "/name" } },
        { id: "echo", component: "Text", text: { path: "/name" } },
      ],
      { model: { name: "Ada" } },
    );
    const name = within(surface).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(name.value).toBe("Ada");
    fireEvent.change(name, { target: { value: "Grace" } });
    expect(name.value).toBe("Grace");
    expect(surface.querySelector(".guuey-chat-a2ui-text")?.textContent).toBe("Grace");
  });

  it("TextField: a literal value is an editable initial value", () => {
    const { surface } = draw([{ id: "root", component: "TextField", label: "City", value: "Lisbon" }]);
    const city = within(surface).getByRole("textbox", { name: "City" }) as HTMLInputElement;
    expect(city.value).toBe("Lisbon");
    fireEvent.change(city, { target: { value: "Porto" } });
    expect(city.value).toBe("Porto");
  });

  it("CheckBox: a checkbox named by its label, checked from the model, toggled locally", () => {
    const { surface } = draw(
      [
        { id: "root", component: "Column", children: ["c"] },
        { id: "c", component: "CheckBox", label: "Email me", checked: { path: "/optIn" }, required: true },
      ],
      { model: { optIn: true } },
    );
    const box = within(surface).getByRole("checkbox", { name: "Email me" }) as HTMLInputElement;
    expect([box.checked, box.getAttribute("aria-required")]).toEqual([true, "true"]);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
  });

  it("an unknown component draws the labelled placeholder in place, and its siblings still draw", () => {
    const { surface } = draw([
      { id: "root", component: "Column", children: ["a", "u"] },
      { id: "a", component: "Text", text: "kept" },
      { id: "u", component: "Carousel", items: ["x"] },
    ]);
    expect(surface.querySelector(".guuey-chat-a2ui-text")?.textContent).toBe("kept");
    expect(surface.querySelector(".guuey-chat-a2ui-unknown")?.textContent).toBe(S.unknownLabel);
    expect(surface.textContent).not.toContain("Carousel");
  });

  it("the surface: a group named by its title, with the calm attribution line", () => {
    const { surface } = draw([{ id: "root", component: "Text", text: "x" }], { title: "Your order" });
    expect(surface.getAttribute("role")).toBe("group");
    const title = surface.querySelector(".guuey-chat-a2ui-title")!;
    expect(title.textContent).toBe("Your order");
    expect(surface.getAttribute("aria-labelledby")).toBe(title.id);
    expect(surface.querySelector(".guuey-chat-attribution")?.textContent).toBe(S.viaTool("show form"));
  });

  it("a superseded revision draws only its one-line chip", () => {
    const plan = planOf([
      [create("s", "Status"), components("s", [{ id: "root", component: "Text", text: "first" }])],
      [components("s", [{ id: "root", component: "Text", text: "second" }])],
    ]);
    const { container } = drawPlan(plan);
    const surfaces = container.querySelectorAll(".guuey-chat-a2ui");
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]!.textContent).toContain("second");
    const chip = container.querySelector(".guuey-chat-a2ui-superseded")!;
    expect(chip.textContent).toBe(S.a2uiUpdatedBelow("Status"));
    expect(chip.textContent).not.toContain("first");
  });
});

// ─── §5.4 local edits ───────────────────────────────────────────────────

describe("local edits are transcript state (§5.4)", () => {
  const form = (model: Json): Json[] => [
    create("f", "Details"),
    components("f", [
      { id: "root", component: "Column", children: ["n", "c"] },
      { id: "n", component: "TextField", label: "Name", value: { path: "/name" } },
      { id: "c", component: "TextField", label: "City", value: { path: "/city" } },
    ]),
    dataModel("f", model),
  ];

  it("an edit survives the row unmounting and mounting again", () => {
    const plan = planOf([form({ name: "Ada", city: "Lisbon" })]);
    const { container, rerender } = drawPlan(plan);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Grace" } });
    // The row leaves the DOM (windowed out, or the plan briefly drops it) and comes back.
    rerender(<Transcript plan={{ ...plan, items: plan.items.filter((i) => i.kind !== "a2ui") }} window={false} {...noop} />);
    expect(container.querySelector(".guuey-chat-a2ui")).toBeNull();
    rerender(<Transcript plan={plan} window={false} {...noop} />);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Grace");
  });

  it("a newer server value wins for its path; an untouched edit survives the new revision", () => {
    const first = planOf([form({ name: "Ada", city: "Lisbon" })]);
    const { rerender } = drawPlan(first);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Grace" } });
    fireEvent.change(screen.getByRole("textbox", { name: "City" }), { target: { value: "Porto" } });
    // The agent's next result sets /name only.
    const second = planOf([form({ name: "Ada", city: "Lisbon" }), [dataModel("f", { name: "Lin", city: "Lisbon" })]]);
    rerender(<Transcript plan={second} window={false} {...noop} />);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Lin");
    expect((screen.getByRole("textbox", { name: "City" }) as HTMLInputElement).value).toBe("Porto");
  });

  it("a host's own store receives the edits (the slot the native kit shares)", () => {
    const writes: Array<[string, string, Json]> = [];
    const store = {
      get: () => undefined,
      set: (surfaceId: string, key: string, edit: { value: Json }) => {
        writes.push([surfaceId, key, edit.value]);
      },
    };
    drawPlan(planOf([form({ name: "Ada", city: "Lisbon" })]), { a2uiEdits: store });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Grace" } });
    expect(writes).toEqual([["f", "/name", "Grace"]]);
  });
});

// ─── (b) hostile payloads ───────────────────────────────────────────────

/** The mapping table: every element and attribute the renderer may put in the DOM. */
const ALLOWED_ELEMENTS = new Set([
  "DIV", "P", "SPAN", "UL", "LI", "HR", "IMG", "A", "BUTTON", "LABEL", "INPUT", "TEXTAREA",
  "FIELDSET", "LEGEND", "STRONG", "EM", "CODE", "BR",
]);
const ALLOWED_ATTRIBUTES = new Set([
  "class", "id", "dir", "role", "aria-level", "aria-label", "aria-labelledby", "aria-describedby",
  "aria-orientation", "aria-required", "aria-expanded", "aria-controls", "aria-hidden", "href", "target",
  "rel", "referrerpolicy", "src", "alt", "type", "name", "value", "placeholder", "maxlength", "min", "max",
  "disabled", "readonly", "checked", "for", "autocomplete",
]);

function scan(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
    if (!ALLOWED_ELEMENTS.has(el.tagName)) out.push(`element <${el.tagName.toLowerCase()}>`);
    for (const attr of Array.from(el.attributes)) {
      if (!ALLOWED_ATTRIBUTES.has(attr.name)) out.push(`<${el.tagName.toLowerCase()} ${attr.name}="${attr.value}">`);
    }
    const href = el.getAttribute("href");
    if (href !== null && !href.startsWith("https://")) out.push(`href ${href}`);
    const src = el.getAttribute("src");
    if (src !== null && !isPolicyAImageSrc(src)) out.push(`src ${src}`);
    for (const cls of (el.getAttribute("class") ?? "").split(" ").filter(Boolean)) {
      if (!/^guuey-chat-(a2ui|attribution)(-[a-z0-9]+)*$/.test(cls)) out.push(`class ${cls}`);
    }
  }
  return out;
}

const BIDI = /[؜‎‏‪-‮⁦-⁩]/;

describe("(b) the hostile-payload suite: nothing agent-written becomes markup, style, a load or a link", () => {
  const LONG = "a".repeat(4_001);
  const readOnly: Json[] = [
    { id: "root", component: "Column", children: ["s", "img", "js", "html", "svg", "pix", "long", "gap", "variant", "md", "user"], gap: "calc(100% - 1px)" },
    { id: "s", component: "Text", text: "<script>alert(1)</script>" },
    { id: "img", component: "Text", text: '<img src=x onerror="alert(1)">' },
    { id: "js", component: "Button", label: "Run", href: "javascript:alert(1)" },
    { id: "html", component: "Image", src: "data:text/html,<script>alert(1)</script>", alt: "html" },
    { id: "svg", component: "Image", src: "data:image/svg+xml;base64,PHN2Zy8+", alt: "svg" },
    { id: "pix", component: "Image", src: "https://tracker.example/pixel.gif", alt: "pixel" },
    { id: "long", component: "Text", text: LONG },
    { id: "gap", component: "Row", children: [], gap: "calc(100% - 1px)", align: "x;color:red", justify: "url(javascript:alert(1))" },
    { id: "variant", component: "Text", text: "styled?", variant: "x;color:red" },
    { id: "md", component: "Text", text: "[x](javascript:alert(1)) [y](data:text/html,hi) ![p](http://h.example/p.png)" },
    { id: "user", component: "Button", label: "Login", href: "https://user:pw@evil.example/" },
  ];

  it("script-ish strings are literal text, and no element or attribute outside the mapping table appears", () => {
    const { surface } = draw(readOnly);
    expect(surface.textContent).toContain("<script>alert(1)</script>");
    expect(surface.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(surface.querySelector("script")).toBeNull();
    expect(scan(surface)).toEqual([]);
  });

  it("no style attribute anywhere, and closed tables map free strings to the defaults", () => {
    const { surface } = draw(readOnly);
    expect(surface.querySelectorAll("[style]")).toHaveLength(0);
    expect(surface.querySelector(".guuey-chat-a2ui-column")!.className).toBe("guuey-chat-a2ui-column guuey-chat-a2ui-gap-md");
    expect(surface.querySelector(".guuey-chat-a2ui-row")!.className).toBe("guuey-chat-a2ui-row guuey-chat-a2ui-gap-md");
    expect(within(surface).getByText("styled?").closest(".guuey-chat-a2ui-text")?.className).toBe("guuey-chat-a2ui-text guuey-chat-a2ui-text-body");
    expect(surface.innerHTML).not.toContain("color:red");
    expect(surface.innerHTML).not.toContain("calc(");
  });

  it("javascript:, data: and userinfo URLs never reach an href; refused images never reach an <img>", () => {
    const { surface } = draw(readOnly);
    expect(surface.querySelectorAll("img")).toHaveLength(0);
    for (const a of Array.from(surface.querySelectorAll("a"))) expect(a.getAttribute("href")).toMatch(/^https:\/\/[^@/]+\//);
    expect(surface.innerHTML).not.toContain("javascript:");
    expect(surface.innerHTML).not.toContain("data:");
    expect(surface.innerHTML).not.toContain("user:pw");
    // The refused links are inert buttons; the off-policy pixel is a chip that offers to open, never loads.
    expect((within(surface).getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(surface).getByRole("button", { name: "Login" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(surface).getByRole("link", { name: `${S.mediaOpenLink} · tracker.example` }).getAttribute("href")).toBe(
      "https://tracker.example/pixel.gif",
    );
  });

  it("a 4,001-unit text draws at most the 4,000-unit bound", () => {
    const { surface } = draw(readOnly);
    const longest = Math.max(...Array.from(surface.querySelectorAll(".guuey-chat-a2ui-text")).map((t) => t.textContent?.length ?? 0));
    expect(longest).toBeLessThanOrEqual(4_000);
    expect(longest).toBeGreaterThan(3_990);
  });

  it("a bidi override in a label reads as no words; agent text sits in a bidi isolate", () => {
    const { surface } = draw([
      { id: "root", component: "Column", children: ["t", "f", "c"] },
      { id: "t", component: "Text", text: "‮evil‬ text" },
      { id: "f", component: "TextField", label: "‮gnp.exe", placeholder: "Name", value: { path: "/n" } },
      { id: "c", component: "CheckBox", label: "Agree⁧", checked: { path: "/ok" } },
    ]);
    const labels = Array.from(surface.querySelectorAll(".guuey-chat-a2ui-label, legend")).map((l) => l.textContent ?? "");
    expect(labels.some((l) => BIDI.test(l))).toBe(false);
    expect(surface.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("Name");
    for (const el of Array.from(surface.querySelectorAll(".guuey-chat-a2ui-text, .guuey-chat-a2ui-label"))) {
      expect(el.getAttribute("dir")).toBe("auto");
    }
    expect(scan(surface)).toEqual([]);
  });

  it("deep nesting at the bound draws every level, and nothing from the payload becomes a style", () => {
    const depth = 12;
    const list: Json[] = [];
    for (let i = 0; i < depth - 1; i++) list.push({ id: i === 0 ? "root" : `c${i}`, component: i % 2 === 0 ? "Column" : "Row", children: [`c${i + 1}`] });
    list.push({ id: `c${depth - 1}`, component: "Text", text: "bottom" });
    const { surface } = draw(list);
    expect(surface.querySelector(".guuey-chat-a2ui-text")?.textContent).toBe("bottom");
    expect(surface.querySelectorAll(".guuey-chat-a2ui-row, .guuey-chat-a2ui-column")).toHaveLength(depth - 1);
    expect(scan(surface)).toEqual([]);
  });

  it("RTL and mixed-direction text draws as written, isolated", () => {
    const { surface } = draw([{ id: "root", component: "Text", text: "שלום world مرحبا" }]);
    const text = surface.querySelector(".guuey-chat-a2ui-text")!;
    expect(text.textContent).toBe("שלום world مرحبا");
    expect(text.getAttribute("dir")).toBe("auto");
  });
});

// ─── (c) a11y ───────────────────────────────────────────────────────────

describe("(c) labels, roles, and the keyboard order", () => {
  it("every input is reachable by Tab in the surface's order; disabled action buttons are not", () => {
    const { surface } = draw([
      { id: "root", component: "Column", children: ["n", "c", "p", "l", "go"] },
      { id: "n", component: "TextField", label: "Name", value: { path: "/name" } },
      { id: "c", component: "CheckBox", label: "Agree", checked: { path: "/ok" } },
      { id: "p", component: "ChoicePicker", label: "Size", options: [{ label: "S", value: "s" }, { label: "M", value: "m" }], value: { path: "/size" } },
      { id: "l", component: "Button", label: "Read more", href: "https://docs.example/" },
      { id: "go", component: "Button", label: "Send", action: { name: "submit" } },
    ]);
    const order = tabbables(surface).map((el) => el.getAttribute("aria-label") ?? el.closest("label")?.textContent ?? el.textContent);
    expect(order).toEqual(["Name", "Agree", "S", "M", "Read more · docs.example"]);
    for (const el of tabbables(surface)) {
      el.focus();
      expect(document.activeElement).toBe(el);
    }
  });

  it("a picker's options are a named group; no required error shows before a submit attempt", () => {
    const { surface } = draw([
      { id: "root", component: "Column", children: ["p", "n"] },
      { id: "p", component: "ChoicePicker", label: "Size", required: true, options: [{ label: "S", value: "s" }, { label: "M", value: "m" }], value: { path: "/size" } },
      { id: "n", component: "TextField", label: "Name", required: true, value: { path: "/name" } },
    ]);
    expect(within(surface).getByRole("group", { name: "Size" })).toBeTruthy();
    expect(surface.querySelector("[aria-invalid]")).toBeNull();
    expect(surface.querySelector('[role="alert"]')).toBeNull();
  });
});

// ─── (d) no raw markup ──────────────────────────────────────────────────

describe("(d) the renderer never writes markup", () => {
  it("react/a2ui.tsx has no dangerouslySetInnerHTML, innerHTML or style prop", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "a2ui.tsx"), "utf8");
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).not.toMatch(/\.innerHTML|outerHTML|insertAdjacentHTML/);
    expect(source).not.toMatch(/\bstyle=\{/);
  });
});

// ─── (e) and (f) links and Text's inline formatting ─────────────────────

describe("(e)(f) Text's inline-only formatting, and a link shows its host", () => {
  const textOf = (text: string) => draw([{ id: "root", component: "Text", text }]).surface.querySelector<HTMLElement>(".guuey-chat-a2ui-text")!;

  it("bold, italic and inline code draw as structure", () => {
    const t = textOf("**bold** and *it* and `code`");
    expect(t.querySelector("strong")?.textContent).toBe("bold");
    expect(t.querySelector("em")?.textContent).toBe("it");
    expect(t.querySelector("code")?.textContent).toBe("code");
  });

  it("an https link opens in a new tab and shows its host", () => {
    const t = textOf("see [the guide](https://docs.example/guide)");
    const a = within(t).getByRole("link", { name: "the guide · docs.example" });
    expect(a.getAttribute("href")).toBe("https://docs.example/guide");
    expect([a.getAttribute("target"), a.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer nofollow"]);
  });

  it("image syntax is '!' and an https link with its host, never an <img>", () => {
    const t = textOf("![a chart](https://h.example/x.png)");
    expect(t.querySelector("img")).toBeNull();
    expect(t.textContent).toBe("!a chart · h.example");
    expect(within(t).getByRole("link").getAttribute("href")).toBe("https://h.example/x.png");
  });

  it("http:, javascript: and mailto: links, and non-https image syntax, draw inert (no href)", () => {
    const t = textOf("[a](http://h.example) [b](javascript:alert(1)) [c](mailto:x@y.example) ![d](http://h.example/x.png)");
    expect(t.querySelector("a")).toBeNull();
    expect(t.textContent).toContain("!d");
  });

  it("a bare https URL links with its host; a bare http URL stays text", () => {
    const t = textOf("at https://bare.example/x. or http://plain.example/y");
    const links = within(t).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://bare.example/x"]);
    expect(links[0]!.textContent).toBe("https://bare.example/x · bare.example");
    expect(t.textContent).toContain("http://plain.example/y");
  });

  it("raw HTML, headings, lists, tables and code fences draw as their literal source", () => {
    const source = "<b>hi</b>\n# Title\n- one\n- two\n| a | b |\n|---|---|\n```ts\nconst x = 1;\n```";
    const t = textOf(source);
    expect(t.querySelector("b, h1, ul, li, table, pre")).toBeNull();
    expect(t.querySelector("code")).toBeNull();

    const lines = Array.from(t.childNodes)
      .map((n) => (n.nodeName === "BR" ? "\n" : (n.textContent ?? "")))
      .join("");
    expect(lines).toBe(source);
  });

  it("**x** in a label stays literal asterisks", () => {
    const { surface } = draw([{ id: "root", component: "TextField", label: "**Name**", value: { path: "/n" } }]);
    expect(within(surface).getByRole("textbox", { name: "**Name**" })).toBeTruthy();
    expect(surface.querySelector("strong")).toBeNull();
  });
});

// ─── (g) ChoicePicker ───────────────────────────────────────────────────

const opts = (n: number): Json[] => Array.from({ length: n }, (_, i) => ({ label: `Option ${i + 1}`, value: `o${i + 1}` }));

describe("(g) ChoicePicker", () => {
  it("6 options draw inline as radio rows; the whole row is the label; the chosen row is marked", () => {
    const { surface } = draw(
      [{ id: "root", component: "ChoicePicker", label: "Pick", options: opts(6), value: { path: "/p" } }],
      { model: { p: "o2" } },
    );
    const group = within(surface).getByRole("group", { name: "Pick" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(6);
    expect(radios.map((r) => r.checked)).toEqual([false, true, false, false, false, false]);
    expect(radios[1]!.closest("label")!.className).toBe("guuey-chat-a2ui-option guuey-chat-a2ui-option-selected");
    fireEvent.click(radios[4]!);
    expect((within(group).getAllByRole("radio") as HTMLInputElement[]).map((r) => r.checked)).toEqual([false, false, false, false, true, false]);
    expect(surface.querySelector(".guuey-chat-a2ui-picker")).toBeNull();
  });

  it("multiple: checkbox rows, each toggled on its own", () => {
    const { surface } = draw(
      [{ id: "root", component: "ChoicePicker", label: "Toppings", multiple: true, options: opts(3), value: { path: "/t" } }],
      { model: { t: ["o1"] } },
    );
    const boxes = within(surface).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);
    fireEvent.click(boxes[2]!);
    expect((within(surface).getAllByRole("checkbox") as HTMLInputElement[]).map((b) => b.checked)).toEqual([true, false, true]);
  });

  it("7 options: a field row that opens the kit's list, naming the choice when there is one", () => {
    const { surface } = draw(
      [{ id: "root", component: "ChoicePicker", label: "Pick", options: opts(7), value: { path: "/p" } }],
      { model: { p: "o3" } },
    );
    expect(within(surface).queryAllByRole("radio")).toHaveLength(0);
    const field = within(surface).getByRole("button", { name: /Pick/ });
    expect(field.className).toBe("guuey-chat-a2ui-picker");
    expect(field.getAttribute("aria-expanded")).toBe("false");
    expect(field.textContent).toContain("Option 3");
    fireEvent.click(field);
    expect(field.getAttribute("aria-expanded")).toBe("true");
    const panel = surface.querySelector(`#${field.getAttribute("aria-controls")}`)!;
    expect(within(panel as HTMLElement).getAllByRole("radio")).toHaveLength(7);
    expect(surface.querySelector(".guuey-chat-a2ui-filter")).toBeNull();
  });

  it("with nothing chosen the field row says Choose", () => {
    const { surface } = draw([{ id: "root", component: "ChoicePicker", label: "Pick", options: opts(8), value: { path: "/p" } }]);
    expect(surface.querySelector(".guuey-chat-a2ui-picker")?.textContent).toContain(S.a2uiChoose);
  });

  it("above 12 options the open list has a local filter, and the filter text never reaches the data", () => {
    const { surface } = draw(
      [
        { id: "root", component: "Column", children: ["p", "echo"] },
        { id: "p", component: "ChoicePicker", label: "Country", options: opts(13), value: { path: "/c" } },
        { id: "echo", component: "Text", text: { path: "/c" } },
      ],
      { model: { c: "o1" } },
    );
    fireEvent.click(within(surface).getByRole("button", { name: /Country/ }));
    const filter = within(surface).getByRole("searchbox", { name: S.a2uiFilter });
    fireEvent.change(filter, { target: { value: "Option 1" } });
    // "Option 1", "Option 10" … "Option 13" match.
    expect(within(surface).getAllByRole("radio").map((r) => r.closest("label")?.textContent)).toEqual([
      "Option 1",
      "Option 10",
      "Option 11",
      "Option 12",
      "Option 13",
    ]);
    fireEvent.click(within(surface).getAllByRole("radio")[2]!);
    expect(surface.querySelector(".guuey-chat-a2ui-text")?.textContent).toBe("o11");
    expect(surface.querySelector(".guuey-chat-a2ui-text")?.textContent).not.toContain("Option 1");
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(within(surface).queryAllByRole("radio")).toHaveLength(0);
    expect(surface.textContent).toContain(S.a2uiNoMatch);
  });
});

// ─── the render gate ────────────────────────────────────────────────────

describe("the render gate: the web kit draws the item and the tool row's old face is gone", () => {
  const messages = [create("s", "Status"), components("s", [{ id: "root", component: "Text", text: "Ready" }])];

  it("render on: the surface draws, attributed, and no tool row or data preview is left", () => {
    const { container } = drawPlan(planOf([messages]));
    expect(container.querySelector(".guuey-chat-a2ui")?.textContent).toContain("Ready");
    expect(container.querySelector(".guuey-chat-tool")).toBeNull();
    expect(container.querySelector(".guuey-chat-data")).toBeNull();
    expect(container.textContent).not.toContain("com.guuey/a2ui");
  });

  it("render off: today's tool row with its data preview, and no surface", () => {
    const { container } = drawPlan(planOf([messages], calmPolicy()));
    expect(container.querySelector(".guuey-chat-a2ui")).toBeNull();
    expect(container.querySelector(".guuey-chat-tool")).not.toBeNull();
  });

  it("a host's own a2ui slot replaces the kit's renderer", () => {
    const Mine = () => <p data-testid="mine">mine</p>;
    const { container } = drawPlan(planOf([messages]), { components: { a2ui: Mine } });
    expect(screen.getByTestId("mine")).toBeTruthy();
    expect(container.querySelector(".guuey-chat-a2ui")).toBeNull();
  });
});
