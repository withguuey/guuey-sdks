/**
 * The A2UI surface fold (guuey#2366, spec §5.1, §5.4, §5.7, §6): parsed
 * messages applied onto the surfaces' current state, then each touched
 * surface resolved into the tree a renderer draws.
 *
 * Pure and total. The state is immutable: an application that fails leaves
 * the state it was given untouched, so a carrier that takes the old face
 * never moves a surface.
 *
 * The two fault classes are decided here, on the RESULTING tree (the messages
 * applied onto the surface's current revision, before any degrade):
 *
 *  - over a component, depth or cycle bound: an envelope fault, always the
 *    old face;
 *  - a component fault (a placeholder, a skipped or dropped node, a dropped
 *    prop, a truncation, a refused data-model update) degrades in place on a
 *    read-only surface and takes the old face on an interactive one (an input
 *    component, or a `Button` carrying an `action` key, anywhere on it);
 *  - the closed carve-out list (a refused image, a refused link) stays in
 *    place on every surface.
 */
import type { JsonValue } from "@silverprotocol/core";
import { a2uiCarrierUnits } from "@guuey/mcp-apps-host/narrowing";
import { A2UI_LIMITS, truncateUnits } from "./limits.js";
import {
  A2UI_COMPONENT_FAULTS,
  A2UI_GAP_TOKENS,
  A2UI_TEXT_VARIANTS,
  isA2uiCarveOut,
  readA2uiDataPath,
  type A2uiCarveOut,
  type A2uiComponentFault,
  type A2uiDegradeCounts,
  type A2uiEnvelopeFault,
  type A2uiFieldSpec,
  type A2uiGap,
  type A2uiInvalidReason,
  type A2uiJsonObject,
  type A2uiNode,
  type A2uiParsedComponent,
  type A2uiTextVariant,
} from "./schema.js";
import { a2uiImageDisplay, httpsLink } from "./url-policy.js";

/** One parsed component as the validator hands it on. */
export interface A2uiComponentEntry {
  id: string;
  /** The wire `component` name (kept for an unknown component's placeholder). */
  name: string;
  /** An input component, or a `Button` carrying an `action` key, even one whose props are bad. */
  interactive: boolean;
  parsed: A2uiParsedComponent;
  /** Faults found parsing the entry itself (an unknown name, dropped props). */
  faults: { [K in A2uiComponentFault]?: number };
}

/** One message, past the envelope checks. */
export type A2uiParsedMessage =
  | { kind: "createSurface"; surfaceId: string; catalogId: string; title: string | null }
  | {
      kind: "updateComponents";
      surfaceId: string;
      components: A2uiComponentEntry[];
      /** Entries dropped for an id outside the charset: a component fault on the surface. */
      badIds: { count: number; interactive: boolean };
    }
  | { kind: "updateDataModel"; surfaceId: string; segments: string[]; value: JsonValue }
  | { kind: "deleteSurface"; surfaceId: string };

/** One surface's state between carriers. */
export interface A2uiSurfaceState {
  surfaceId: string;
  catalogId: string;
  title: string | null;
  /** Components by id; replace-by-id keeps the first insertion's position. */
  components: ReadonlyMap<string, A2uiComponentEntry>;
  /** The ids of the surface's first `updateComponents` batch that added a component (the root fallback reads them), or null before one. */
  firstBatch: readonly string[] | null;
  dataModel: A2uiJsonObject;
}

/** Every surface's state, by surface id. */
export type A2uiFoldState = ReadonlyMap<string, A2uiSurfaceState>;

/** The state before any carrier. */
export const EMPTY_A2UI_STATE: A2uiFoldState = new Map();

/** One surface revision, resolved and validated: what an `a2ui` item carries. */
export interface A2uiResolvedSurface {
  surfaceId: string;
  catalogId: string;
  title: string | null;
  root: A2uiNode | null;
  /** The server data model at this revision. */
  dataModel: A2uiJsonObject;
  /** The declared model: data path → the constraint of the input bound there. */
  fields: { [path: string]: A2uiFieldSpec };
  /** At least one input component, or one `Button` carrying an `action` key. */
  interactive: boolean;
  /** Each in-place degrade this revision carries (component faults on a read-only surface, and carve-outs). */
  degrade: A2uiDegradeCounts;
}

/** What a carrier did to one surface it touched. */
export type A2uiSurfaceOutcome =
  | { kind: "drawn"; surface: A2uiResolvedSurface }
  /** `deleteSurface`: the surface draws nothing. */
  | { kind: "deleted"; surfaceId: string }
  /** An update for a surface with no state that carried no components: nothing to draw. */
  | { kind: "ignored"; surfaceId: string };

/** The result of applying a carrier's messages. */
export type A2uiApplyResult =
  | { ok: true; state: A2uiFoldState; surfaces: A2uiSurfaceOutcome[] }
  | {
      ok: false;
      reason: A2uiInvalidReason;
      /** Where: `/<surfaceId>` or `/<surfaceId>/<componentId>` (or `/<surfaceId>/dataModel`). */
      path: string;
      level: "envelope" | "component";
      /** The surfaces the carrier targets (an open interactive revision of each is closed, spec §9.4). */
      surfaceIds: string[];
    };

/** A value read from a data model at a data path, or `undefined` when nothing is there. */
export function readA2uiModel(model: A2uiJsonObject, path: string | readonly string[]): JsonValue | undefined {
  const read = typeof path === "string" ? readA2uiDataPath(path) : { segments: path };
  if (!("segments" in read)) return undefined;
  let current: JsonValue = model;
  for (const segment of read.segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      const next: JsonValue | undefined = current[Number(segment)];
      if (next === undefined) return undefined;
      current = next;
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, segment)) {
      const next: JsonValue | undefined = current[segment];
      if (next === undefined) return undefined;
      current = next;
    } else {
      return undefined;
    }
  }
  return current;
}

/** `value` written at `segments` under `container`; intermediate objects are created, an array index must exist. */
function writeAt(
  container: JsonValue | undefined,
  segments: readonly string[],
  at: number,
  value: JsonValue,
): { ok: true; value: JsonValue } | { ok: false } {
  if (at === segments.length) return { ok: true, value };
  const segment = segments[at] ?? "";
  if (Array.isArray(container)) {
    if (!/^(0|[1-9][0-9]*)$/.test(segment)) return { ok: false };
    const index = Number(segment);
    if (index >= container.length) return { ok: false };
    const child = writeAt(container[index], segments, at + 1, value);
    if (!child.ok) return child;
    const next = [...container];
    next[index] = child.value;
    return { ok: true, value: next };
  }
  const object: A2uiJsonObject | undefined =
    container === undefined ? {} : typeof container === "object" && container !== null ? container : undefined;
  if (object === undefined) return { ok: false };
  const child = writeAt(Object.hasOwn(object, segment) ? object[segment] : undefined, segments, at + 1, value);
  if (!child.ok) return child;
  // A computed key in a literal defines an own property, `__proto__` included.
  return { ok: true, value: { ...object, [segment]: child.value } };
}

/** A located fault, the first of which names a failed carrier. */
interface Fault {
  fault: A2uiComponentFault | A2uiCarveOut;
  at: string;
}

function freshSurface(surfaceId: string, catalogId: string, title: string | null): A2uiSurfaceState {
  return { surfaceId, catalogId, title, components: new Map(), firstBatch: null, dataModel: {} };
}

/** The component ids an entry references (Row/Column/List children, Card child), in order. */
function childRefs(entry: A2uiComponentEntry): readonly string[] {
  const p = entry.parsed;
  switch (p.component) {
    case "Row":
    case "Column":
    case "List":
      return p.props.children ?? [];
    case "Card":
      return p.props.child !== undefined ? [p.props.child] : [];
    default:
      return [];
  }
}

/** True when the reference graph holds a cycle anywhere (reachable from the root or not). */
function hasCycle(components: ReadonlyMap<string, A2uiComponentEntry>): boolean {
  const state = new Map<string, "open" | "done">();
  for (const start of components.keys()) {
    if (state.has(start)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    state.set(start, "open");
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const entry = components.get(top.id);
      const refs = entry !== undefined ? childRefs(entry) : [];
      if (top.next >= refs.length) {
        state.set(top.id, "done");
        stack.pop();
        continue;
      }
      const ref = refs[top.next++]!;
      if (!components.has(ref)) continue;
      const seen = state.get(ref);
      if (seen === "open") return true;
      if (seen === undefined) {
        state.set(ref, "open");
        stack.push({ id: ref, next: 0 });
      }
    }
  }
  return false;
}

/** Every id some component references. */
function referencedIds(surface: A2uiSurfaceState): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const entry of surface.components.values()) for (const ref of childRefs(entry)) referenced.add(ref);
  return referenced;
}

/**
 * The root: the component with id `root`, else the first of the first batch
 * nothing references. `null` with components present is the `no-root` fault.
 */
function rootId(surface: A2uiSurfaceState, referenced: ReadonlySet<string>): string | null {
  if (surface.components.has("root")) return "root";
  for (const id of surface.firstBatch ?? []) {
    if (surface.components.has(id) && !referenced.has(id)) return id;
  }
  return null;
}

class EnvelopeAbort {
  constructor(
    readonly reason: A2uiEnvelopeFault,
    readonly path: string,
  ) {}
}

/** Resolve one surface into its tree, its declared model and its faults. */
function resolveSurface(
  surface: A2uiSurfaceState,
  pending: readonly Fault[],
  pendingInteractive: boolean,
): { ok: true; surface: A2uiResolvedSurface; faults: Fault[] } | EnvelopeAbort {
  const where = `/${surface.surfaceId}`;
  if (surface.components.size > A2UI_LIMITS.componentsPerSurface) return new EnvelopeAbort("too-many-components", where);
  if (hasCycle(surface.components)) return new EnvelopeAbort("cycle", where);

  const faults: Fault[] = [...pending];
  const add = (fault: Fault["fault"], at: string, n = 1): void => {
    for (let i = 0; i < n; i++) faults.push({ fault, at });
  };
  const label = (value: string | undefined, at: string): string | null => {
    if (value === undefined) return null;
    const cut = truncateUnits(value, A2UI_LIMITS.labelUnits);
    if (cut.truncated) add("truncated-label", at);
    return cut.text;
  };
  const fields: { [path: string]: A2uiFieldSpec } = {};
  const declare = (path: string, spec: A2uiFieldSpec): void => {
    if (!Object.hasOwn(fields, path)) fields[path] = spec;
  };

  const title = label(surface.title ?? undefined, where);
  const drawnIds = new Set<string>();
  /** Set when a node sits deeper than the bound: an envelope fault for the whole carrier. */
  let tooDeep: EnvelopeAbort | null = null;

  const children = (refs: readonly string[], cap: number, dropFault: A2uiComponentFault, at: string, depth: number) => {
    if (refs.length > cap) add(dropFault, at, refs.length - cap);
    const nodes: A2uiNode[] = [];
    for (const ref of refs.slice(0, cap)) {
      const node = resolve(ref, depth, at);
      if (node !== null) nodes.push(node);
    }
    return nodes;
  };

  const resolve = (id: string, depth: number, parentAt: string): A2uiNode | null => {
    const entry = surface.components.get(id);
    if (entry === undefined) {
      add("dangling-child", parentAt);
      return null;
    }
    if (drawnIds.has(id)) {
      add("shared-child", parentAt);
      return null;
    }
    if (depth > A2UI_LIMITS.treeDepth) {
      tooDeep ??= new EnvelopeAbort("too-deep", `${where}/${id}`);
      return null;
    }
    drawnIds.add(id);
    const at = `${where}/${id}`;
    const p = entry.parsed;
    switch (p.component) {
      case "Row":
      case "Column":
        return {
          id,
          component: p.component,
          children: children(p.props.children ?? [], A2UI_LIMITS.childrenPerContainer, "dropped-children", at, depth + 1),
          gap: gapOf(p.props.gap),
          align: p.props.align ?? null,
          justify: p.props.justify ?? null,
        };
      case "List":
        return { id, component: "List", children: children(p.props.children ?? [], A2UI_LIMITS.listItems, "dropped-items", at, depth + 1) };
      case "Card":
        return { id, component: "Card", child: p.props.child !== undefined ? resolve(p.props.child, depth + 1, at) : null };
      case "Divider":
        return { id, component: "Divider", orientation: p.props.orientation ?? "horizontal" };
      case "Text": {
        const raw = p.props.text ?? "";
        let text = raw;
        if (typeof raw === "string") {
          const cut = truncateUnits(raw, A2UI_LIMITS.textUnits);
          if (cut.truncated) add("truncated-text", at);
          text = cut.text;
        } else {
          const bound = readA2uiModel(surface.dataModel, raw.path);
          if (typeof bound === "string" && bound.length > A2UI_LIMITS.textUnits) add("truncated-text", at);
        }
        return { id, component: "Text", text, variant: variantOf(p.props.variant) };
      }
      case "Image": {
        const display = p.props.src !== undefined ? a2uiImageDisplay(p.props.src) : { kind: "chip" as const };
        if (p.props.src !== undefined && display.kind !== "image") add("refused-image", at);
        return { id, component: "Image", display, alt: label(p.props.alt, at) };
      }
      case "Icon":
        return { id, component: "Icon", name: p.props.name ?? null, label: label(p.props.label, at) };
      case "Button": {
        const link = p.props.href !== undefined ? httpsLink(p.props.href) : null;
        if (p.props.href !== undefined && link === null) add("refused-link", at);
        const confirm = p.props.confirm;
        return {
          id,
          component: "Button",
          label: label(p.props.label, at) ?? "",
          action: p.props.action ?? null,
          link,
          variant: p.props.variant ?? null,
          confirm:
            confirm === undefined
              ? null
              : {
                  title: label(confirm.title, at) ?? "",
                  message: label(confirm.message, at) ?? "",
                  confirmLabel: label(confirm.confirmLabel, at),
                  cancelLabel: label(confirm.cancelLabel, at),
                },
        };
      }
      case "TextField": {
        const node = {
          id,
          component: "TextField" as const,
          label: label(p.props.label, at),
          placeholder: label(p.props.placeholder, at),
          value: p.props.value ?? null,
          inputType: p.props.inputType ?? "text",
          required: p.props.required ?? false,
          maxLength: p.props.maxLength ?? null,
          min: p.props.min ?? null,
          max: p.props.max ?? null,
        };
        if (node.value !== null && typeof node.value !== "string") {
          declare(node.value.path, {
            kind: "text",
            componentId: id,
            label: node.label,
            inputType: node.inputType,
            required: node.required,
            maxLength: node.maxLength,
            min: node.min,
            max: node.max,
          });
        }
        return node;
      }
      case "CheckBox": {
        const node = {
          id,
          component: "CheckBox" as const,
          label: label(p.props.label, at),
          checked: p.props.checked ?? null,
          required: p.props.required ?? false,
        };
        if (node.checked !== null && typeof node.checked !== "boolean") {
          declare(node.checked.path, { kind: "boolean", componentId: id, label: node.label, required: node.required });
        }
        return node;
      }
      case "ChoicePicker": {
        const all = p.props.options ?? [];
        if (all.length > A2UI_LIMITS.choiceOptions) add("dropped-options", at, all.length - A2UI_LIMITS.choiceOptions);
        const options = all.slice(0, A2UI_LIMITS.choiceOptions).map((o) => ({ label: label(o.label, at) ?? "", value: o.value }));
        const value = p.props.value ?? null;
        const node = {
          id,
          component: "ChoicePicker" as const,
          label: label(p.props.label, at),
          options,
          value,
          multiple: p.props.multiple ?? false,
          required: p.props.required ?? false,
        };
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          declare(value.path, {
            kind: "choice",
            componentId: id,
            label: node.label,
            options: options.map((o) => o.value),
            multiple: node.multiple,
            required: node.required,
          });
        }
        return node;
      }
      case "unknown":
        return { id, component: "unknown", name: p.name };
    }
  };

  const referenced = referencedIds(surface);
  const id = rootId(surface, referenced);
  if (id === null && surface.components.size > 0) add("no-root", where);
  const root = id === null ? null : resolve(id, 1, where);
  if (tooDeep !== null) return tooDeep;

  // One population for the class and the faults: every component in the
  // surface. Each is drawn or counted, and any one input or action makes it
  // interactive, reachable or not.
  let interactive = pendingInteractive;
  for (const [cid, entry] of surface.components) {
    const at = `${where}/${cid}`;
    if (entry.interactive) interactive = true;
    for (const fault of A2UI_COMPONENT_FAULTS) add(fault, at, entry.faults[fault] ?? 0);
    if (cid !== id && !referenced.has(cid)) add("unreferenced-component", at);
  }

  const degrade: A2uiDegradeCounts = {};
  for (const { fault } of faults) degrade[fault] = (degrade[fault] ?? 0) + 1;
  return {
    ok: true,
    surface: { surfaceId: surface.surfaceId, catalogId: surface.catalogId, title, root, dataModel: surface.dataModel, fields, interactive, degrade },
    faults,
  };
}

function gapOf(gap: string | undefined): A2uiGap {
  return A2UI_GAP_TOKENS.find((t) => t === gap) ?? "md";
}

function variantOf(variant: string | undefined): A2uiTextVariant {
  return A2UI_TEXT_VARIANTS.find((v) => v === variant) ?? "body";
}

/**
 * Apply one carrier's parsed messages onto `state`. The carrier is atomic: an
 * envelope fault, or a component fault on any interactive surface it targets,
 * fails it whole and leaves `state` as it was.
 */
export function applyA2uiMessages(state: A2uiFoldState, messages: readonly A2uiParsedMessage[]): A2uiApplyResult {
  const working = new Map(state);
  const order: string[] = [];
  const touch = (surfaceId: string): void => {
    if (!order.includes(surfaceId)) order.push(surfaceId);
  };
  const pending = new Map<string, Fault[]>();
  const pendingInteractive = new Set<string>();
  const fault = (surfaceId: string, f: Fault): void => {
    pending.set(surfaceId, [...(pending.get(surfaceId) ?? []), f]);
  };

  for (const message of messages) {
    const id = message.surfaceId;
    touch(id);
    switch (message.kind) {
      case "createSurface":
        working.set(id, freshSurface(id, message.catalogId, message.title));
        pending.delete(id);
        pendingInteractive.delete(id);
        break;
      case "updateComponents": {
        // An update for a surface no createSurface opened is an orphan: ignored.
        const surface = working.get(id);
        if (surface === undefined) break;
        const components = new Map(surface.components);
        for (const entry of message.components) components.set(entry.id, entry);
        for (let i = 0; i < message.badIds.count; i++) fault(id, { fault: "bad-id", at: `/${id}` });
        if (message.badIds.interactive) pendingInteractive.add(id);
        const batch = message.components.map((c) => c.id);
        working.set(id, { ...surface, components, firstBatch: surface.firstBatch ?? (batch.length > 0 ? batch : null) });
        break;
      }
      case "updateDataModel": {
        const surface = working.get(id);
        if (surface === undefined) break;
        const written = writeAt(surface.dataModel, message.segments, 0, message.value);
        const model = written.ok && typeof written.value === "object" && written.value !== null && !Array.isArray(written.value) ? written.value : null;
        if (model === null) {
          fault(id, { fault: "data-model-refused", at: `/${id}/dataModel` });
        } else if (a2uiCarrierUnits(model) > A2UI_LIMITS.dataModelUnits) {
          fault(id, { fault: "data-model-too-large", at: `/${id}/dataModel` });
        } else {
          working.set(id, { ...surface, dataModel: model });
        }
        break;
      }
      case "deleteSurface":
        working.delete(id);
        pending.delete(id);
        pendingInteractive.delete(id);
        break;
    }
  }

  const deleted = new Set(messages.filter((m) => m.kind === "deleteSurface").map((m) => m.surfaceId));
  const surfaces: A2uiSurfaceOutcome[] = [];
  for (const id of order) {
    const surface = working.get(id);
    if (surface === undefined) {
      surfaces.push(deleted.has(id) ? { kind: "deleted", surfaceId: id } : { kind: "ignored", surfaceId: id });
      continue;
    }
    const resolved = resolveSurface(surface, pending.get(id) ?? [], pendingInteractive.has(id));
    if (resolved instanceof EnvelopeAbort) {
      return { ok: false, reason: resolved.reason, path: resolved.path, level: "envelope", surfaceIds: order };
    }
    if (resolved.surface.interactive) {
      for (const { fault, at } of resolved.faults) {
        if (!isA2uiCarveOut(fault)) return { ok: false, reason: fault, path: at, level: "component", surfaceIds: order };
      }
    }
    surfaces.push({ kind: "drawn", surface: resolved.surface });
  }
  return { ok: true, state: working, surfaces };
}
