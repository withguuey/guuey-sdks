/**
 * The json-render adapter (guuey#2385, spec §12): a `{ format: "json-render" }`
 * carrier mapped onto the SAME A2UI message list a native carrier holds, so
 * the one validator, the one fold, the planner and the renderers draw it with
 * no second path. The validator then judges the result with every §6 limit:
 * the adapter is never a bypass.
 *
 * It reads the documented `Spec` shape of `@json-render/core@0.21.1`:
 * `{ root, elements: { [key]: { type, props, children?, slots?, visible?, on?,
 * repeat?, watch? } }, state? }`. json-render has no fixed component set, so
 * a type maps by name (case-insensitive, the §12 table); any other type is a
 * labeled `unknown` placeholder.
 *
 * Nothing in the payload is ever evaluated. A `$state`/`$bindState`/`$item`/
 * `$bindItem` is a data path (a binding where the A2UI prop takes one, else a
 * lookup in `spec.state` at conversion time); `$index` is the repeat index;
 * `$template` substitutes `${/path}` lookups and nothing else. `visible` is
 * read once against `spec.state` in the closed forms §12 lists. `$cond`,
 * `$computed`, every other `$` form, built-in state actions, watchers, slots,
 * the follow-up hooks of an action and every check outside the closed list
 * (`pattern` among them: no regex is ever built from the payload) are
 * DROPPED, and each drop is counted (`dropped-construct`, spec §5.7: in place
 * on a read-only surface, the old face on an interactive one).
 *
 * The work is bounded before the validator sees it: the raw carrier is held to
 * the carrier bound, an expansion stops at the component, depth, unit and
 * step bounds (every element visit, hidden and repeated ones included, is a
 * step), the drop count stops at the fault bound, and the mapped carrier is
 * measured again by the validator.
 */
import type { JsonValue } from "@silverprotocol/core";
import { isJsonObject } from "@guuey/mcp-apps-host";
import { A2UI_CARRIER_MAX_UNITS, a2uiCarrierUnits } from "@guuey/mcp-apps-host/narrowing";
import { readA2uiModel } from "./fold.js";
import { A2UI_LIMITS } from "./limits.js";
import {
  A2UI_ID_PATTERN,
  A2UI_VERSION,
  readA2uiDataPath,
  type A2uiComponentName,
  type A2uiEnvelopeFault,
  type A2uiJsonObject,
} from "./schema.js";

/** The carrier `format` this adapter reads. */
export const JSON_RENDER_FORMAT = "json-render";

/** The catalog id a mapped surface is created under. */
export const JSON_RENDER_CATALOG_ID = "guuey.json-render.v1";

/**
 * The json-render versions whose `Spec` shape the adapter knows: the 0.21
 * line (read at 0.21.1). Any other version is an envelope fault, never a guess.
 */
export const JSON_RENDER_VERSION_PATTERN = /^0\.21(\.(0|[1-9][0-9]*))?$/;

/** What the adapter dropped: how many constructs, and whether any of them was an input or an action. */
export interface JsonRenderDropped {
  count: number;
  /** A dropped construct was (or held) an input or an action: the surface is interactive (spec §5.7). */
  interactive: boolean;
}

/** The adapter's result: the mapped A2UI messages, or the envelope fault. */
export type JsonRenderResult =
  | { ok: true; surfaceId: string; messages: A2uiJsonObject[]; dropped: JsonRenderDropped }
  | { ok: false; reason: A2uiEnvelopeFault; path: string; surfaceIds: string[] };

/** json-render type names (lower-cased) → the A2UI component they draw as (the §12 table). */
const TYPE_TABLE: ReadonlyMap<string, A2uiComponentName> = new Map(
  (
    [
      [["row", "hstack", "horizontal"], "Row"],
      [["column", "stack", "vstack", "box", "container", "section", "form"], "Column"],
      [["card"], "Card"],
      [["list"], "List"],
      [["divider", "separator"], "Divider"],
      [["text", "heading", "paragraph", "label", "badge"], "Text"],
      [["image", "img", "avatar"], "Image"],
      [["icon"], "Icon"],
      [["button", "link"], "Button"],
      [["input", "textfield", "textinput", "textarea"], "TextField"],
      [["checkbox", "switch", "toggle"], "CheckBox"],
      [["select", "radiogroup", "dropdown", "choicepicker"], "ChoicePicker"],
    ] as const
  ).flatMap(([names, component]) => names.map((name): [string, A2uiComponentName] => [name, component])),
);

const INPUTS: ReadonlySet<A2uiComponentName> = new Set(["TextField", "CheckBox", "ChoicePicker"]);

/** json-render's built-in client-state actions: no guuey equivalent in V1, so the button is inert. */
const BUILT_IN_ACTIONS: ReadonlySet<string> = new Set(["setState", "pushState", "removeState"]);

/** The hooks an action binding may carry beside its action: dropped (the agent's reply drives the update, §9.4). */
const ACTION_HOOKS = ["onSuccess", "onError", "preventDefault"] as const;

/** `Input.type` values with an A2UI input type. Any other is dropped (a `password` input is never drawn as text). */
const INPUT_TYPES: ReadonlyMap<string, "text" | "number" | "email"> = new Map([
  ["text", "text"],
  ["number", "number"],
  ["email", "email"],
]);

/** How deep a `visible` condition's `$and`/`$or` may nest before it reads as unevaluable (hidden). */
const VISIBLE_DEPTH = 8;

/** The fault that stops a conversion: an envelope fault and where. */
class Abort {
  constructor(
    readonly reason: A2uiEnvelopeFault,
    readonly path: string,
  ) {}
}

/** A repeat iteration's context: where its item sits in the state, its index, and the id suffix of its clones. */
interface RepeatContext {
  itemSegments: readonly string[];
  index: number;
}

/** What a prop wants after mapping: a binding where the A2UI prop takes one, else a literal of a type. */
type Want = "string" | "bound-string" | "bound-boolean" | "bound-choice" | "number" | "boolean" | "raw";

/** One prop value mapped: absent, dropped (counted), or its A2UI value. */
type Mapped = { kind: "absent" } | { kind: "dropped" } | { kind: "value"; value: JsonValue };

const ABSENT: Mapped = { kind: "absent" };
const DROPPED: Mapped = { kind: "dropped" };

function escapeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointer(segments: readonly string[]): string {
  return segments.map((s) => `/${escapeSegment(s)}`).join("");
}

function isScalar(value: JsonValue | undefined): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** An own property of a JSON object, never one it inherits (`constructor`, `__proto__`, …). */
function own(object: A2uiJsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** True when a JSON object holds an expression key (`$…`). */
function isExpression(value: JsonValue | undefined): value is A2uiJsonObject {
  return isJsonObject(value) && Object.keys(value).some((k) => k.startsWith("$"));
}

/** The element keys an element's `slots` name (a slot is a key or a list of keys). */
function slotChildren(slots: JsonValue | undefined): string[] {
  if (!isJsonObject(slots)) return [];
  return Object.values(slots)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((child): child is string => typeof child === "string");
}

/** One JSON-pointer token unescaped, as the package does (`~1` then `~0`). */
function unescapeToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * The segments `$item` reads in the item: the package's `getByPath` over the
 * item, so `""` and `"/"` are the item, and one leading `/` is optional.
 */
function itemSegments(path: string): string[] {
  if (path === "" || path === "/") return [];
  return (path.startsWith("/") ? path.slice(1) : path).split("/").map(unescapeToken);
}

/**
 * The segments `$bindItem` (and an action param's `$item`) add to the item's
 * path: the package's `resolveBindItemPath` joins the two with `/`, so `""` is
 * the item and a leading `/` names an empty key first.
 */
function bindItemSegments(path: string): string[] {
  return path === "" ? [] : path.split("/").map(unescapeToken);
}

/** One json-render conversion. Every method is bounded; `Abort` is the only exit besides the result. */
class Converter {
  /** Element key → its own id (outside any repeat). */
  private readonly ids = new Map<string, string>();
  private readonly taken = new Set<string>();
  private readonly reserved: ReadonlySet<string>;
  /** Context slot → the id emitted there, or null when the element is hidden there. */
  private readonly emitted = new Map<string, string | null>();
  private readonly onPath = new Set<string>();
  /** Element key → its `visible` reading (it reads `spec.state` only, so it is the same in every context). */
  private readonly visibility = new Map<string, boolean | "unevaluable">();
  /** Element key → whether it, or anything under it, is an input or carries an action. */
  private readonly interaction = new Map<string, boolean>();
  private readonly components: A2uiJsonObject[] = [];
  private fresh = 0;
  private units = 0;
  private steps = 0;
  dropped = 0;
  droppedInteractive = false;

  constructor(
    private readonly elements: A2uiJsonObject,
    private readonly rootKey: string,
    private readonly state: A2uiJsonObject,
  ) {
    // The spec's root is always `root`; every other valid key keeps its own
    // name, so a re-keyed id never takes one an element owns.
    const reserved = new Set<string>(["root"]);
    for (const key of Object.keys(elements)) if (key !== rootKey && key !== "root" && A2UI_ID_PATTERN.test(key)) reserved.add(key);
    this.reserved = reserved;
  }

  run(): A2uiJsonObject[] {
    this.emit(this.rootKey, null, "", 1, "/spec/root");
    return this.components;
  }

  /** Count `n` dropped constructs; the count stops at the fault bound, which keeps its meaning. */
  private drop(interactive: boolean, n = 1): void {
    this.dropped = Math.min(this.dropped + n, A2UI_LIMITS.faultsPerMessage);
    if (interactive) this.droppedInteractive = true;
  }

  /** One step of the conversion's work: past the step bound the conversion stops (`too-large`). */
  private step(at: string): void {
    this.steps += 1;
    if (this.steps > A2UI_LIMITS.jsonRenderSteps) throw new Abort("too-large", at);
  }

  /** Spend `n` units of the mapped carrier's budget: past the carrier bound the conversion stops (`too-large`). */
  private spend(n: number): void {
    this.units += n;
    if (this.units > A2UI_CARRIER_MAX_UNITS) throw new Abort("too-large", "/spec");
  }

  /**
   * A deterministic, collision-free id: `base` when it is a free id (an
   * element's own reserved key only for that element), else the next free `e<n>`.
   */
  private claim(base: string, ownKey = false): string {
    if (A2UI_ID_PATTERN.test(base) && !this.taken.has(base) && (ownKey || !this.reserved.has(base))) {
      this.taken.add(base);
      return base;
    }
    for (;;) {
      const id = `e${this.fresh++}`;
      if (!this.taken.has(id) && !this.reserved.has(id)) {
        this.taken.add(id);
        return id;
      }
    }
  }

  /** An element key's own id: `root` for the spec's root, the key itself when it is a free id, else re-keyed. */
  private idOf(key: string): string {
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    // An element keyed `root` that is not the spec's root, or a key outside the charset, is re-keyed.
    const id = key === this.rootKey ? this.claim("root", true) : key === "root" ? this.claim("") : this.claim(key, true);
    this.ids.set(key, id);
    return id;
  }

  /** An element's id in a repeat iteration: its own id with the iteration path, or re-keyed when that does not fit. */
  private cloneId(key: string, suffix: string): string {
    return suffix === "" ? this.idOf(key) : this.claim(`${this.idOf(key)}${suffix}`);
  }

  private element(key: string): A2uiJsonObject | undefined {
    const element = own(this.elements, key);
    return isJsonObject(element) ? element : undefined;
  }

  /**
   * Whether an element, or anything under it (children and slots), is an
   * input or carries an action. Read once per key. Past the tree bound (a
   * cycle among it) the answer is the safe one: it may hold one.
   */
  private holdsInteraction(key: string, depth = 0): boolean {
    const known = this.interaction.get(key);
    if (known !== undefined) return known;
    if (depth > A2UI_LIMITS.treeDepth) return true;
    this.step(`/spec/elements/${escapeSegment(key)}`);
    const element = this.element(key);
    let holds = false;
    if (element !== undefined) {
      const type = own(element, "type");
      const mapped = typeof type === "string" ? TYPE_TABLE.get(type.toLowerCase()) : undefined;
      holds =
        (mapped !== undefined && INPUTS.has(mapped)) ||
        isJsonObject(own(element, "on")) ||
        own(element, "watch") !== undefined ||
        [...this.childKeys(element), ...slotChildren(own(element, "slots"))].some((child) => this.holdsInteraction(child, depth + 1));
    }
    this.interaction.set(key, holds);
    return holds;
  }

  private childKeys(element: A2uiJsonObject): string[] {
    const children = own(element, "children");
    return Array.isArray(children) ? children.filter((c): c is string => typeof c === "string") : [];
  }

  /**
   * Emit one element (and what it holds) for a context; its id, or null when
   * it is hidden. An element already emitted in the same context is referenced
   * again (the validator draws it once, a shared child); one on the current
   * path is a cycle. Every visit is a step, a repeated or hidden one too.
   */
  private emit(key: string, repeat: RepeatContext | null, suffix: string, depth: number, at: string): string | null {
    this.step(at);
    if (depth > A2UI_LIMITS.treeDepth) throw new Abort("too-deep", at);
    const slot = `${suffix}\u0000${key}`;
    if (this.onPath.has(slot)) throw new Abort("cycle", at);
    const again = this.emitted.get(slot);
    if (again !== undefined) return again;
    const raw = own(this.elements, key);
    if (raw === undefined) {
      // A dangling reference: an id no component holds, so the validator skips it (`dangling-child`).
      const id = this.cloneId(key, suffix);
      this.emitted.set(slot, id);
      return id;
    }
    if (!isJsonObject(raw)) throw new Abort("bad-shape", `/spec/elements/${escapeSegment(key)}`);
    const type = own(raw, "type");
    if (typeof type !== "string") throw new Abort("bad-shape", `/spec/elements/${escapeSegment(key)}/type`);

    const visible = this.visibleOf(key, raw);
    if (visible !== true) {
      // Hidden in this context: a reference to it again is neither read nor counted again.
      this.emitted.set(slot, null);
      if (visible === "unevaluable") this.drop(this.holdsInteraction(key));
      return null;
    }

    const id = this.cloneId(key, suffix);
    this.emitted.set(slot, id);
    this.onPath.add(slot);
    if (this.components.length >= A2UI_LIMITS.componentsPerSurface) throw new Abort("too-many-components", "/spec/elements");
    const component: A2uiJsonObject = { id };
    this.components.push(component);
    const where = `/spec/elements/${escapeSegment(key)}`;
    const given = own(raw, "props");
    if (given !== undefined && !isJsonObject(given)) this.drop(false);
    const props = isJsonObject(given) ? given : {};
    const mapped = this.honoured(TYPE_TABLE.get(type.toLowerCase()), type.toLowerCase(), props);

    this.dropUnmapped(raw, mapped);

    if (mapped === undefined) {
      // A labeled placeholder; what it holds is not drawn through it, and an
      // input or an action among that is an interactive drop (slots count in `dropUnmapped`).
      component["component"] = type;
      if (this.childKeys(raw).some((child) => this.holdsInteraction(child))) this.drop(true);
    } else {
      component["component"] = mapped;
      const children = (): string[] => this.children(raw, repeat, suffix, depth, where);
      Object.assign(component, this.props(mapped, type.toLowerCase(), props, raw, repeat, children, id));
    }
    this.onPath.delete(slot);
    this.spend(a2uiCarrierUnits(component));
    return id;
  }

  /**
   * The A2UI kind an element draws as, or undefined for a placeholder. An
   * Input whose `type` has no A2UI input type (`password` among them: a
   * secret is never drawn as plain text) is an input the kit cannot honour:
   * a placeholder, its drop counted as an input's.
   */
  private honoured(mapped: A2uiComponentName | undefined, type: string, props: A2uiJsonObject): A2uiComponentName | undefined {
    if (mapped !== "TextField" || type === "textarea") return mapped;
    const inputType = own(props, "type");
    if (inputType === undefined || (typeof inputType === "string" && INPUT_TYPES.has(inputType))) return mapped;
    this.drop(true);
    return undefined;
  }

  /** Drop (and count) the element-level constructs no A2UI component carries. */
  private dropUnmapped(raw: A2uiJsonObject, mapped: A2uiComponentName | undefined): void {
    const watch = own(raw, "watch");
    if (watch !== undefined) this.drop(true);
    const slots = own(raw, "slots");
    if (slots !== undefined) this.drop(slotChildren(slots).some((child) => this.holdsInteraction(child)));
    const on = own(raw, "on");
    if (on === undefined) return;
    if (!isJsonObject(on)) {
      this.drop(true);
      return;
    }
    for (const event of Object.keys(on)) {
      // `press` on a Button is mapped (`action`); every other binding is dropped.
      if (event === "press" && mapped === "Button") continue;
      this.drop(true);
    }
  }

  /** A container's children for a context: unrolled per repeat item when the element repeats. */
  private children(raw: A2uiJsonObject, repeat: RepeatContext | null, suffix: string, depth: number, where: string): string[] {
    const keys = this.childKeys(raw);
    const out: string[] = [];
    const spec = own(raw, "repeat");
    if (spec === undefined) {
      for (const [i, child] of keys.entries()) {
        const id = this.emit(child, repeat, suffix, depth + 1, `${where}/children/${i}`);
        if (id !== null) out.push(id);
      }
      return out;
    }
    const statePath = isJsonObject(spec) ? own(spec, "statePath") : undefined;
    const read = typeof statePath === "string" ? readA2uiDataPath(statePath) : null;
    if (read === null || "fault" in read) {
      // A repeat that does not name a readable state path draws nothing of what it holds.
      this.drop(keys.some((k) => this.holdsInteraction(k)));
      return out;
    }
    const items = readA2uiModel(this.state, read.segments);
    if (!Array.isArray(items)) return out;
    const shown = Math.min(items.length, A2UI_LIMITS.listItems);
    for (let i = 0; i < shown; i++) {
      const context: RepeatContext = { itemSegments: [...read.segments, String(i)], index: i };
      for (const [c, child] of keys.entries()) {
        const id = this.emit(child, context, `${suffix}.${i}`, depth + 1, `${where}/children/${c}`);
        if (id !== null) out.push(id);
      }
    }
    // Each item past the cap is a drop (the count clamped at the fault bound).
    if (items.length > shown) this.drop(keys.some((k) => this.holdsInteraction(k)), items.length - shown);
    return out;
  }

  /** An element's `visible`, read once per element: it reads `spec.state` only, so every context reads the same. */
  private visibleOf(key: string, raw: A2uiJsonObject): boolean | "unevaluable" {
    const known = this.visibility.get(key);
    if (known !== undefined) return known;
    const read = this.visible(own(raw, "visible"), 0, `/spec/elements/${escapeSegment(key)}/visible`);
    this.visibility.set(key, read);
    return read;
  }

  /**
   * `visible`, read against `spec.state`: a literal boolean; one `$state`
   * with `eq`, `neq` or `not`, or its truthiness; `$and`/`$or` of those, read
   * in order up to the first term that settles them (as the package's own
   * evaluator does). Any other form it reads is unevaluable, and hides the
   * element. Each term read is a step.
   */
  private visible(value: JsonValue | undefined, depth: number, at: string): boolean | "unevaluable" {
    this.step(at);
    if (value === undefined || value === true) return true;
    if (value === false) return false;
    if (!isJsonObject(value) || depth >= VISIBLE_DEPTH) return "unevaluable";
    const keys = Object.keys(value);
    if (keys.length === 1 && (keys[0] === "$and" || keys[0] === "$or")) {
      const list = own(value, keys[0]);
      if (!Array.isArray(list) || list.length === 0) return "unevaluable";
      const all = keys[0] === "$and";
      for (const term of list) {
        const read = this.visible(term, depth + 1, at);
        // A false term settles `$and`, a true one `$or`.
        if (read === "unevaluable" || read !== all) return read;
      }
      return all;
    }
    const allowed = new Set(["$state", "eq", "neq", "not"]);
    if (!keys.every((k) => allowed.has(k))) return "unevaluable";
    const path = own(value, "$state");
    if (typeof path !== "string") return "unevaluable";
    const read = readA2uiDataPath(path);
    if ("fault" in read) return "unevaluable";
    const eq = own(value, "eq");
    const neq = own(value, "neq");
    const not = own(value, "not");
    if (eq !== undefined && neq !== undefined) return "unevaluable";
    if (not !== undefined && typeof not !== "boolean") return "unevaluable";
    if ((eq !== undefined && !isScalar(eq)) || (neq !== undefined && !isScalar(neq))) return "unevaluable";
    const current = readA2uiModel(this.state, read.segments);
    const truth =
      eq !== undefined
        ? current === eq
        : neq !== undefined
          ? current !== neq
          : !(current === undefined || current === null || current === false || current === 0 || current === "");
    return not === true ? !truth : truth;
  }

  /** A data path an expression names, against the repeat context for `$item`/`$bindItem`. */
  private expressionPath(expression: A2uiJsonObject, repeat: RepeatContext | null): string[] | null {
    const state = own(expression, "$state") ?? own(expression, "$bindState");
    if (typeof state === "string") {
      const read = readA2uiDataPath(state);
      return "fault" in read ? null : read.segments;
    }
    if (repeat === null) return null;
    const item = own(expression, "$item");
    if (typeof item === "string") return this.bounded([...repeat.itemSegments, ...itemSegments(item)]);
    const bound = own(expression, "$bindItem");
    if (typeof bound === "string") return this.bounded([...repeat.itemSegments, ...bindItemSegments(bound)]);
    return null;
  }

  /** A data path within the §6 path bounds (depth, segment units), or null: a path past them is dropped. */
  private bounded(segments: string[]): string[] | null {
    if (segments.length > A2UI_LIMITS.dataPathDepth) return null;
    return segments.every((s) => s.length <= A2UI_LIMITS.dataPathSegmentUnits) ? segments : null;
  }

  /** `${/path}` lookups in a template, against `spec.state`; null when one does not read as a path. */
  private template(text: string): string | null {
    let out = "";
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("${", i);
      if (open === -1) {
        out += text.slice(i);
        break;
      }
      const close = text.indexOf("}", open + 2);
      if (close === -1) return null;
      out += text.slice(i, open);
      const read = readA2uiDataPath(text.slice(open + 2, close));
      if ("fault" in read || read.segments.length === 0) return null;
      const value = readA2uiModel(this.state, read.segments);
      if (value !== undefined && value !== null && !isScalar(value)) return null;
      out += value === undefined || value === null ? "" : String(value);
      // A template cannot grow past the carrier bound, whatever it repeats.
      if (out.length > A2UI_CARRIER_MAX_UNITS) throw new Abort("too-large", "/spec");
      i = close + 1;
    }
    return out;
  }

  /** One prop value mapped to what its A2UI prop wants. */
  private value(value: JsonValue | undefined, want: Want, repeat: RepeatContext | null): Mapped {
    if (value === undefined) return ABSENT;
    if (!isExpression(value)) return { kind: "value", value };
    const keys = Object.keys(value);
    const one = keys.length === 1 ? keys[0] : undefined;
    if (one === "$template") {
      const text = own(value, "$template");
      const out = typeof text === "string" ? this.template(text) : null;
      if (out === null || want === "number" || want === "boolean") return DROPPED;
      return { kind: "value", value: out };
    }
    if (one === "$index") {
      // The package reads `{ $index: true }` only.
      if (repeat === null || own(value, "$index") !== true) return DROPPED;
      if (want === "number" || want === "raw") return { kind: "value", value: repeat.index };
      if (want === "string" || want === "bound-string") return { kind: "value", value: String(repeat.index) };
      return DROPPED;
    }
    if (one === "$state" || one === "$bindState" || one === "$item" || one === "$bindItem") {
      const segments = this.expressionPath(value, repeat);
      if (segments === null) return DROPPED;
      if (want.startsWith("bound-")) return { kind: "value", value: { path: pointer(segments) } };
      // A prop A2UI cannot bind: the value read from `spec.state` now, when its type fits.
      const read = readA2uiModel(this.state, segments);
      if (read === undefined) return ABSENT;
      if (want === "raw") return { kind: "value", value: read };
      if (want === "string" && typeof read === "string") return { kind: "value", value: read };
      if (want === "number" && typeof read === "number") return { kind: "value", value: read };
      if (want === "boolean" && typeof read === "boolean") return { kind: "value", value: read };
      return DROPPED;
    }
    // `$cond`/`$then`/`$else`, `$computed`, and every other form: never evaluated.
    return DROPPED;
  }

  /** Map one prop into `out[target]`, counting a drop. */
  private put(out: A2uiJsonObject, target: string, value: JsonValue | undefined, want: Want, repeat: RepeatContext | null): void {
    const mapped = this.value(value, want, repeat);
    if (mapped.kind === "dropped") this.drop(false);
    if (mapped.kind === "value") out[target] = mapped.value;
  }

  /** The first prop present among `names`. */
  private first(props: A2uiJsonObject, names: readonly string[]): JsonValue | undefined {
    for (const name of names) {
      const value = own(props, name);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  private props(
    mapped: A2uiComponentName,
    type: string,
    props: A2uiJsonObject,
    raw: A2uiJsonObject,
    repeat: RepeatContext | null,
    children: () => string[],
    id: string,
  ): A2uiJsonObject {
    const out: A2uiJsonObject = {};
    switch (mapped) {
      case "Row":
      case "Column":
        for (const prop of ["gap", "align", "justify"]) this.put(out, prop, own(props, prop), "string", repeat);
        out["children"] = children();
        break;
      case "List":
        out["children"] = children();
        break;
      case "Card":
        this.card(out, props, repeat, children, id);
        break;
      case "Divider":
        this.put(out, "orientation", own(props, "orientation"), "string", repeat);
        break;
      case "Text":
        this.put(out, "text", this.first(props, ["text", "content", "label", "title"]), "bound-string", repeat);
        if (type === "heading") out["variant"] = this.headingVariant(own(props, "level"));
        else this.put(out, "variant", own(props, "variant"), "string", repeat);
        break;
      case "Image":
        this.put(out, "src", own(props, "src"), "string", repeat);
        this.put(out, "alt", type === "avatar" ? this.first(props, ["alt", "name"]) : own(props, "alt"), "string", repeat);
        break;
      case "Icon":
        this.put(out, "name", own(props, "name"), "string", repeat);
        this.put(out, "label", own(props, "label"), "string", repeat);
        break;
      case "Button":
        this.button(out, props, raw, repeat);
        break;
      case "TextField":
        this.textField(out, type, props, repeat);
        break;
      case "CheckBox":
        this.put(out, "label", own(props, "label"), "string", repeat);
        this.put(out, "checked", this.first(props, ["checked", "value"]), "bound-boolean", repeat);
        this.put(out, "required", own(props, "required"), "boolean", repeat);
        this.checks(out, mapped, props);
        break;
      case "ChoicePicker":
        this.choicePicker(out, type, props, repeat);
        this.checks(out, mapped, props);
        break;
    }
    return out;
  }

  /** A Card holds one child: its only child, or a Column of its title and children. */
  private card(
    out: A2uiJsonObject,
    props: A2uiJsonObject,
    repeat: RepeatContext | null,
    children: () => string[],
    id: string,
  ): void {
    const title = this.value(own(props, "title"), "bound-string", repeat);
    if (title.kind === "dropped") this.drop(false);
    const kids = children();
    if (title.kind !== "value" && kids.length <= 1) {
      if (kids[0] !== undefined) out["child"] = kids[0];
      return;
    }
    // The wrapper adds a level under the card; the validator's depth bound judges the result.
    const body: A2uiJsonObject = { id: this.claim(`${id}.body`), component: "Column", children: [] };
    const list: string[] = [];
    if (title.kind === "value") {
      const heading: A2uiJsonObject = { id: this.claim(`${id}.title`), component: "Text", text: title.value, variant: "h3" };
      this.push(heading);
      list.push(String(heading["id"]));
    }
    list.push(...kids);
    body["children"] = list;
    this.push(body);
    out["child"] = body["id"] ?? null;
  }

  private push(component: A2uiJsonObject): void {
    if (this.components.length >= A2UI_LIMITS.componentsPerSurface) throw new Abort("too-many-components", "/spec/elements");
    this.components.push(component);
    this.spend(a2uiCarrierUnits(component));
  }

  private headingVariant(level: JsonValue | undefined): string {
    if (level === undefined) return "h2";
    if (typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 6) return `h${level}`;
    if (typeof level === "string" && /^h[1-6]$/.test(level)) return level;
    this.drop(false);
    return "h2";
  }

  private button(out: A2uiJsonObject, props: A2uiJsonObject, raw: A2uiJsonObject, repeat: RepeatContext | null): void {
    this.put(out, "label", this.first(props, ["label", "text", "title"]), "string", repeat);
    this.put(out, "href", own(props, "href"), "string", repeat);
    this.put(out, "variant", own(props, "variant"), "string", repeat);
    const on = own(raw, "on");
    const press = isJsonObject(on) ? own(on, "press") : undefined;
    if (press === undefined) return;
    if (!isJsonObject(press)) {
      this.drop(true);
      return;
    }
    for (const hook of ACTION_HOOKS) if (own(press, hook) !== undefined) this.drop(false);
    const name = own(press, "action");
    if (typeof name !== "string" || BUILT_IN_ACTIONS.has(name)) {
      this.drop(true);
      return;
    }
    const action: A2uiJsonObject = { name };
    const params = own(press, "params");
    if (params !== undefined) {
      if (!isJsonObject(params)) {
        this.drop(true);
      } else {
        const entries: Array<[string, JsonValue]> = [];
        for (const [key, value] of Object.entries(params)) {
          const mapped = this.param(value, repeat);
          if (mapped.kind === "value") entries.push([key, mapped.value]);
          else if (mapped.kind === "dropped") this.drop(true);
        }
        // fromEntries defines own properties: a `__proto__` key is data, never a prototype.
        action["context"] = Object.fromEntries(entries);
      }
    }
    out["action"] = action;
    const confirm = own(press, "confirm");
    if (isJsonObject(confirm)) {
      const mapped: A2uiJsonObject = {};
      for (const prop of ["title", "message", "confirmLabel", "cancelLabel"]) this.put(mapped, prop, own(confirm, prop), "string", repeat);
      out["confirm"] = mapped;
      if (own(confirm, "variant") === "danger" && out["variant"] === undefined) out["variant"] = "danger";
    } else if (confirm !== undefined) {
      this.drop(false);
    }
  }

  /**
   * One action param, as the package's `resolveActionParam` reads it: `$item`
   * is the item's absolute state path as a string (`resolveBindItemPath`),
   * `$index` the index number; any other expression maps as a prop does
   * (`$state`, `$bindState` and `$bindItem` to bindings). A literal param is a scalar.
   */
  private param(value: JsonValue, repeat: RepeatContext | null): Mapped {
    if (!isExpression(value)) return isScalar(value) ? { kind: "value", value } : DROPPED;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$item") {
      const item = own(value, "$item");
      if (repeat === null || typeof item !== "string") return DROPPED;
      const segments = this.bounded([...repeat.itemSegments, ...bindItemSegments(item)]);
      return segments === null ? DROPPED : { kind: "value", value: pointer(segments) };
    }
    if (keys.length === 1 && keys[0] === "$index") return this.value(value, "number", repeat);
    return this.value(value, "bound-string", repeat);
  }

  private textField(out: A2uiJsonObject, type: string, props: A2uiJsonObject, repeat: RepeatContext | null): void {
    this.put(out, "label", own(props, "label"), "string", repeat);
    this.put(out, "placeholder", own(props, "placeholder"), "string", repeat);
    this.put(out, "value", own(props, "value"), "bound-string", repeat);
    this.put(out, "maxLength", own(props, "maxLength"), "number", repeat);
    this.put(out, "required", own(props, "required"), "boolean", repeat);
    if (type === "textarea") {
      out["inputType"] = "long";
    } else {
      // `honoured` let only a known type (or none) through.
      const inputType = own(props, "type");
      const known = typeof inputType === "string" ? INPUT_TYPES.get(inputType) : undefined;
      if (known !== undefined) out["inputType"] = known;
    }
    this.checks(out, "TextField", props);
  }

  private choicePicker(out: A2uiJsonObject, type: string, props: A2uiJsonObject, repeat: RepeatContext | null): void {
    this.put(out, "label", own(props, "label"), "string", repeat);
    this.put(out, "value", own(props, "value"), "bound-choice", repeat);
    this.put(out, "required", own(props, "required"), "boolean", repeat);
    if (type !== "radiogroup") this.put(out, "multiple", own(props, "multiple"), "boolean", repeat);
    const options = this.value(own(props, "options"), "raw", repeat);
    if (options.kind === "dropped") this.drop(false);
    if (options.kind !== "value") return;
    if (!Array.isArray(options.value)) {
      // Not a list: the validator drops it (`bad-prop`).
      out["options"] = options.value;
      return;
    }
    const list: JsonValue[] = [];
    for (const option of options.value) {
      if (typeof option === "string") {
        list.push({ label: option, value: option });
      } else if (isJsonObject(option)) {
        const mapped: A2uiJsonObject = {};
        this.put(mapped, "label", own(option, "label"), "string", repeat);
        this.put(mapped, "value", own(option, "value"), "string", repeat);
        list.push(mapped);
      } else {
        list.push(option);
      }
    }
    out["options"] = list;
  }

  /**
   * Validation checks onto field constraints (§12). A check is json-render's
   * `{ type, args?, message }`; its numbers are `args.min` / `args.max`, as
   * the package's built-in functions read them. Mapped: `required`,
   * `minLength` at most 1 (1 is `required`), `maxLength`, `min`, `max`,
   * `email`, `numeric`. Any other check (`minLength` above 1, since A2UI has
   * no minimum length and `required` would accept what the producer refuses;
   * `pattern`, `matches`, `requiredIf`, `url`, a custom one) is dropped:
   * nothing in it is compiled or run.
   */
  private checks(out: A2uiJsonObject, mapped: A2uiComponentName, props: A2uiJsonObject): void {
    const validation = own(props, "validation");
    const lists = [own(props, "checks"), isJsonObject(validation) ? own(validation, "checks") : undefined];
    for (const list of lists) {
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        this.drop(false);
        continue;
      }
      for (const check of list) this.check(out, mapped, check);
    }
  }

  private check(out: A2uiJsonObject, mapped: A2uiComponentName, check: JsonValue): void {
    const kind = isJsonObject(check) ? own(check, "type") : undefined;
    const args = isJsonObject(check) ? own(check, "args") : undefined;
    const arg = (name: "min" | "max"): number | null => {
      if (!isJsonObject(args)) return null;
      const value = own(args, name);
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    const field = mapped === "TextField";
    switch (kind) {
      case "required":
        out["required"] = true;
        return;
      case "minLength": {
        // length ≥ n: n ≤ 0 always holds; 0 < n ≤ 1 is non-empty, which is `required`; above 1 has no A2UI face.
        const n = arg("min");
        if (n === null || n > 1) break;
        if (n > 0) out["required"] = true;
        return;
      }
      case "maxLength": {
        const n = arg("max");
        if (n === null || !field) break;
        out["maxLength"] = n;
        return;
      }
      case "min":
      case "max": {
        const n = arg(kind);
        if (n === null || !field) break;
        out[kind] = n;
        return;
      }
      case "email":
        if (!field) break;
        out["inputType"] = "email";
        return;
      case "numeric":
        if (!field) break;
        out["inputType"] = "number";
        return;
    }
    // `minLength` above 1, `pattern`, `matches`, `requiredIf`, `url`, a custom check, or one that does not read.
    this.drop(false);
  }
}

/** The surface id a json-render carrier names, when it is one (what a carrier that takes the old face closes). */
export function namedJsonRenderSurfaceIds(carrier: JsonValue): string[] {
  if (!isJsonObject(carrier)) return [];
  const id = own(carrier, "surfaceId");
  return typeof id === "string" && A2UI_ID_PATTERN.test(id) ? [id] : [];
}

/**
 * A json-render carrier mapped onto A2UI messages: `createSurface` (its
 * `surfaceId` and `title`), `updateDataModel` (from `spec.state`) and
 * `updateComponents`. The caller judges the messages with the validator; an
 * envelope fault found here is returned instead.
 */
export function jsonRenderToA2ui(carrier: JsonValue): JsonRenderResult {
  const surfaceIds = namedJsonRenderSurfaceIds(carrier);
  const fail = (reason: A2uiEnvelopeFault, path: string): JsonRenderResult => ({ ok: false, reason, path, surfaceIds });
  if (a2uiCarrierUnits(carrier) > A2UI_CARRIER_MAX_UNITS) return fail("too-large", "");
  if (!isJsonObject(carrier)) return fail("not-object", "");
  if (own(carrier, "format") !== JSON_RENDER_FORMAT) return fail("unsupported-format", "/format");
  const version = own(carrier, "version");
  if (typeof version !== "string" || !JSON_RENDER_VERSION_PATTERN.test(version)) return fail("bad-version", "/version");
  const surfaceId = own(carrier, "surfaceId");
  if (typeof surfaceId !== "string" || !A2UI_ID_PATTERN.test(surfaceId)) return fail("bad-surface-id", "/surfaceId");
  const spec = own(carrier, "spec");
  if (!isJsonObject(spec)) return fail("bad-shape", "/spec");
  const elements = own(spec, "elements");
  if (!isJsonObject(elements)) return fail("bad-shape", "/spec/elements");
  const root = own(spec, "root");
  if (typeof root !== "string" || !Object.hasOwn(elements, root)) return fail("bad-shape", "/spec/root");
  const state = own(spec, "state");
  if (state !== undefined && !isJsonObject(state)) return fail("bad-shape", "/spec/state");

  const converter = new Converter(elements, root, state ?? {});
  let components: A2uiJsonObject[];
  try {
    components = converter.run();
  } catch (error) {
    if (error instanceof Abort) return fail(error.reason, error.path);
    throw error;
  }

  const title = own(carrier, "title");
  const messages: A2uiJsonObject[] = [
    {
      version: A2UI_VERSION,
      createSurface: { surfaceId, catalogId: JSON_RENDER_CATALOG_ID, ...(title !== undefined ? { title } : {}) },
    },
  ];
  if (state !== undefined) messages.push({ version: A2UI_VERSION, updateDataModel: { surfaceId, value: state } });
  messages.push({ version: A2UI_VERSION, updateComponents: { surfaceId, components } });
  return {
    ok: true,
    surfaceId,
    messages,
    dropped: { count: converter.dropped, interactive: converter.droppedInteractive },
  };
}
