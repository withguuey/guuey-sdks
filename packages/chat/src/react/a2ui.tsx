/**
 * The web kit's A2UI renderer (guuey#2382): draws an `a2ui` plan item with
 * the kit's own DOM, in the embedder's origin, so this module is a trust
 * boundary (spec §7).
 *
 * - Every agent string reaches the screen as a text node. `Text` alone
 *   carries inline formatting, through the kit's inline-only rich text with
 *   the https link gate; every other string is plain, and every label goes
 *   through the tap-label normalizer (a control or bidi formatting character
 *   reads as no words). Agent text sits in a bidi isolate (`dir="auto"`).
 * - Nothing from the payload becomes a style, a class or an attribute except
 *   through a closed table here: gap, align, justify, variant and orientation
 *   map to kit classes; `alt` → `alt`, `label` → `aria-label` or a `<label>`.
 * - What an image loads and which links survive were decided by the planner
 *   (policy A, narrowed by the host's media policy). The renderer draws the
 *   item's display and never derives a URL.
 * - Inputs edit the surface's LOCAL data model, held by the host at
 *   transcript level ({@link A2uiEditStore}, spec §5.4), so a row that
 *   unmounts keeps its edits. An edit lives while the revision it was made
 *   on is in the plan and every later revision keeps the server value it was
 *   made against: a newer, different server value drops it for good, and a
 *   deleted surface drops its edits. Untouched edits survive.
 * - Actions (guuey#2384, §9): a press opens the kit's own confirm when the
 *   button declares one, validates the payload against the declared model
 *   (each failing field says why, nothing is sent), then hands the resolved
 *   record to the host's send path (`onA2uiAction`), which says what it did.
 *   A surface whose action turn is on its way, or answered, is locked;
 *   "Edit answers" reopens a submitted one here, through the host's store.
 *   With no action path wired, each action button is drawn disabled and
 *   described by its own "Not available here" note, beside it (§9.1.5).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { JsonValue } from "@silverprotocol/core";
import { tapText } from "@guuey/mcp-apps-host/narrowing";
import { A2UI_LIMITS, truncateUnits } from "../a2ui/limits.js";
import { readA2uiModel } from "../a2ui/fold.js";
import { asText, checkA2uiAction, type A2uiActionOutcome, type A2uiActionRequest, type A2uiFieldError } from "../a2ui/action.js";
import { httpsLink } from "../a2ui/url-policy.js";
import { isA2uiPathBinding } from "../a2ui/schema.js";
import type {
  A2uiAlign,
  A2uiBound,
  A2uiButtonVariant,
  A2uiChoiceOption,
  A2uiFieldSpec,
  A2uiGap,
  A2uiJustify,
  A2uiNode,
  A2uiOrientation,
  A2uiTextVariant,
} from "../a2ui/schema.js";
import type { A2uiItem, DisplayItem, ItemKey } from "../types.js";
import type { ChatStrings } from "../strings.js";
import { GatedLink, InlineRichText, type InlineLinkGate } from "./markdown.js";

// ─── The host-owned edit store (§5.4) ───────────────────────────────────

/** One local edit, with the revision and the server value it was made against. */
export interface A2uiLocalEdit {
  value: JsonValue;
  /** The server value at that key when the edit was made: a later, different server value drops the edit. */
  base: JsonValue | null;
  /** The plan item (the surface's revision) the edit was made on: when it leaves the plan, so does the edit. */
  at: ItemKey;
}

/**
 * A surface's local edits, held at transcript level (spec §5.4). `key` is the
 * data path an input is bound to (`/name`), or `#<componentId>` for an input
 * with a literal value (editable, never addressable by an action).
 *
 * `get` answers only a LIVE edit ({@link useA2uiEditStore} holds the rule); a
 * host that supplies its own store keeps the same rule. `clear` forgets every
 * edit: the host calls it when the conversation is cleared or replaced.
 *
 * guuey#2384: the store also holds "Edit answers": `reopen` reopens a
 * submitted surface here against the action turn that answered it
 * (`A2uiItem.actionId`), and `reopened` names that turn, so a later submit
 * (a new action id) closes the surface again. `clear` forgets it too.
 */
export interface A2uiEditStore {
  get(surfaceId: string, key: string): A2uiLocalEdit | undefined;
  set(surfaceId: string, key: string, edit: A2uiLocalEdit): void;
  reopened(surfaceId: string): string | undefined;
  reopen(surfaceId: string, actionId: string): void;
  clear(): void;
}

/** What a host's icon component receives: the registry name and the accessible name (§5.3). */
export interface A2uiIconProps {
  name: string;
  label: string | null;
}

interface StoredEdit {
  surfaceId: string;
  key: string;
  edit: A2uiLocalEdit;
}

const entryId = (surfaceId: string, key: string): string => JSON.stringify([surfaceId, key]);

/** The first node of a tree with this id. */
function findNode(node: A2uiNode | null, id: string): A2uiNode | null {
  if (node === null) return null;
  if (node.id === id) return node;
  switch (node.component) {
    case "Row":
    case "Column":
    case "List":
      for (const child of node.children) {
        const found = findNode(child, id);
        if (found !== null) return found;
      }
      return null;
    case "Card":
      return findNode(node.child, id);
    default:
      return null;
  }
}

/**
 * The server value a revision holds at an edit key, or `undefined` when the
 * key no longer names an input there (the component is gone, or now reads a
 * path): the edit has nothing left to stand over.
 */
function serverAt(item: A2uiItem, key: string): JsonValue | null | undefined {
  if (!key.startsWith("#")) return readA2uiModel(item.dataModel, key) ?? null;
  const node = findNode(item.root, key.slice(1));
  const bound =
    node?.component === "TextField" || node?.component === "ChoicePicker" ? node.value : node?.component === "CheckBox" ? node.checked : undefined;
  if (bound === undefined) return undefined;
  const server = serverValue(item, bound);
  return server.key === null ? server.value : undefined;
}

/**
 * The edits that are dead under this plan: the revision an edit was made on
 * is no longer in it (the surface was deleted, or the transcript cleared), or
 * a later revision of the surface holds a different server value at its key.
 * A dead edit never comes back, even if the value returns to its base.
 */
function deadEdits(edits: ReadonlyMap<string, StoredEdit>, items: readonly DisplayItem[]): ReadonlyMap<string, StoredEdit> {
  const dead = new Map<string, StoredEdit>();
  if (edits.size === 0) return dead;
  const revisions = new Map<string, A2uiItem[]>();
  for (const item of items) {
    if (item.kind === "a2ui") revisions.set(item.surfaceId, [...(revisions.get(item.surfaceId) ?? []), item]);
  }
  for (const [id, stored] of edits) {
    const list = revisions.get(stored.surfaceId) ?? [];
    const at = list.findIndex((item) => item.key === stored.edit.at);
    const overridden = (later: A2uiItem): boolean => {
      const server = serverAt(later, stored.key);
      return server === undefined || !sameJson(server, stored.edit.base);
    };
    if (at < 0 || list.slice(at + 1).some(overridden)) dead.set(id, stored);
  }
  return dead;
}

/**
 * The kit's edit store over a plan's items: a transcript-level map, each
 * write a new map so the rows re-render. `get` hides a dead edit at once (a
 * pure read of the plan), and an effect then removes it from the map, so it
 * cannot come back; nothing is written during render.
 */
export function useA2uiEditStore(items: readonly DisplayItem[]): A2uiEditStore {
  const [edits, setEdits] = useState<ReadonlyMap<string, StoredEdit>>(() => new Map());
  const [reopens, setReopens] = useState<ReadonlyMap<string, string>>(() => new Map());
  const dead = useMemo(() => deadEdits(edits, items), [edits, items]);
  useEffect(() => {
    if (dead.size === 0) return;
    setEdits((prev) => {
      const next = new Map(prev);
      // Only the entry judged dead: an edit written since then stays.
      for (const [id, stored] of dead) if (next.get(id) === stored) next.delete(id);
      return next;
    });
  }, [dead]);
  const clear = useCallback(() => {
    setEdits(new Map());
    setReopens(new Map());
  }, []);
  return useMemo(
    () => ({
      get: (surfaceId, key) => {
        const id = entryId(surfaceId, key);
        return dead.has(id) ? undefined : edits.get(id)?.edit;
      },
      set: (surfaceId, key, edit) => setEdits((prev) => new Map(prev).set(entryId(surfaceId, key), { surfaceId, key, edit })),
      reopened: (surfaceId) => reopens.get(surfaceId),
      reopen: (surfaceId, actionId) => setReopens((prev) => new Map(prev).set(surfaceId, actionId)),
      clear,
    }),
    [edits, dead, reopens, clear],
  );
}

/** The slice of the transcript context the renderer reads. */
export interface A2uiRenderContext {
  strings: ChatStrings;
  a2uiEdits?: A2uiEditStore;
  a2uiIcon?: ComponentType<A2uiIconProps>;
  onA2uiAction?: (item: A2uiItem, request: A2uiActionRequest) => A2uiActionOutcome;
  /** Whether the host would take a press now; true clears a "wait" note. */
  a2uiActionsReady?: boolean;
}

// ─── Closed tables: the only way a payload word becomes a class ─────────

const GAP_CLASS: { [G in A2uiGap]: string } = {
  none: "guuey-chat-a2ui-gap-none",
  xs: "guuey-chat-a2ui-gap-xs",
  sm: "guuey-chat-a2ui-gap-sm",
  md: "guuey-chat-a2ui-gap-md",
  lg: "guuey-chat-a2ui-gap-lg",
  xl: "guuey-chat-a2ui-gap-xl",
};
const ALIGN_CLASS: { [A in A2uiAlign]: string } = {
  start: "guuey-chat-a2ui-align-start",
  center: "guuey-chat-a2ui-align-center",
  end: "guuey-chat-a2ui-align-end",
  stretch: "guuey-chat-a2ui-align-stretch",
};
const JUSTIFY_CLASS: { [J in A2uiJustify]: string } = {
  start: "guuey-chat-a2ui-justify-start",
  center: "guuey-chat-a2ui-justify-center",
  end: "guuey-chat-a2ui-justify-end",
  between: "guuey-chat-a2ui-justify-between",
  around: "guuey-chat-a2ui-justify-around",
  evenly: "guuey-chat-a2ui-justify-evenly",
};
const TEXT_CLASS: { [V in A2uiTextVariant]: string } = {
  h1: "guuey-chat-a2ui-text guuey-chat-a2ui-text-h1",
  h2: "guuey-chat-a2ui-text guuey-chat-a2ui-text-h2",
  h3: "guuey-chat-a2ui-text guuey-chat-a2ui-text-h3",
  h4: "guuey-chat-a2ui-text guuey-chat-a2ui-text-h4",
  h5: "guuey-chat-a2ui-text guuey-chat-a2ui-text-h5",
  h6: "guuey-chat-a2ui-text guuey-chat-a2ui-text-h6",
  body: "guuey-chat-a2ui-text guuey-chat-a2ui-text-body",
  caption: "guuey-chat-a2ui-text guuey-chat-a2ui-text-caption",
  label: "guuey-chat-a2ui-text guuey-chat-a2ui-text-label",
};
const HEADING_LEVEL: { [V in A2uiTextVariant]: number | null } = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
  body: null,
  caption: null,
  label: null,
};
const DIVIDER_CLASS: { [O in A2uiOrientation]: string } = {
  horizontal: "guuey-chat-a2ui-divider",
  vertical: "guuey-chat-a2ui-divider guuey-chat-a2ui-divider-vertical",
};
const BUTTON_CLASS: { [B in A2uiButtonVariant]: string } = {
  primary: "guuey-chat-a2ui-button guuey-chat-a2ui-button-primary",
  secondary: "guuey-chat-a2ui-button guuey-chat-a2ui-button-secondary",
  danger: "guuey-chat-a2ui-button guuey-chat-a2ui-button-danger",
};

/** Above this many options a choice is a field row that opens the kit's list (§5.3). */
const INLINE_OPTIONS = 6;
/** Above this many options the open list carries a local filter (§5.3). */
const FILTER_OPTIONS = 12;

/** `Text`'s link rule (§7.1, §7.3): https only, no userinfo, the host shown. */
const TEXT_LINK: InlineLinkGate = (url) => httpsLink(url);

/** A label, placeholder, alt, title or option label: normalized, or `null` when it reads as no words. */
function words(raw: string | null): string | null {
  return raw === null ? null : tapText(raw);
}

/** Two JSON values are the same value (key order kept, as the model stores it). */
function sameJson(a: JsonValue | null, b: JsonValue | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── The surface ────────────────────────────────────────────────────────

interface Env {
  item: A2uiItem;
  strings: ChatStrings;
  icon: ComponentType<A2uiIconProps> | undefined;
  /** The value the surface shows at `key`: the local edit while its base is still the server's value. */
  read(key: string, server: JsonValue | null): JsonValue | null;
  write(key: string, value: JsonValue, server: JsonValue | null): void;
  /** Inputs take no edits while an action for the surface is in flight or answered. */
  locked: boolean;
  /** The host's send path; absent, action buttons draw disabled with their own note. */
  send: ((node: NodeOf<"Button">) => string | null) | undefined;
  /** The error a field shows since the last press, by its data path. */
  errors: { readonly [path: string]: string };
  /** The host would take a press now. */
  ready: boolean;
  /** A unique, DOM-safe id for a component's part. */
  idFor(componentId: string, part: string): string;
}

const ID_ESCAPES: { readonly [c: string]: string } = { _: "__", ".": "_d", ":": "_c" };

/**
 * A component id as a DOM id segment, injectively: `_` is the escape, so
 * `size.a`, `size:a` and `size_a` stay three ids (and three radio groups).
 * The id grammar admits only `[A-Za-z0-9_.:-]`; anything else would still
 * map one-to-one as `_x<hex>_`.
 */
function domIdSegment(componentId: string): string {
  return componentId.replace(/[^A-Za-z0-9-]/g, (c) => ID_ESCAPES[c] ?? `_x${(c.codePointAt(0) ?? 0).toString(16)}_`);
}

/**
 * A Button that draws as an action press: it has words, an action and no
 * link. With no action path wired it is drawn disabled and described by its
 * own "Not available here" note, beside it.
 */
function isActionButton(node: NodeOf<"Button">): boolean {
  return node.action !== null && node.link === null && words(node.label) !== null;
}

/** A field error's words. */
function fieldError(error: A2uiFieldError, strings: ChatStrings): string {
  switch (error.kind) {
    case "required":
      return strings.a2uiRequired;
    case "too-long":
      return strings.a2uiFieldTooLong(error.max);
    case "not-a-number":
      return strings.a2uiFieldNumber;
    case "too-small":
      return strings.a2uiFieldMin(error.min);
    case "too-large":
      return strings.a2uiFieldMax(error.max);
    case "not-an-email":
      return strings.a2uiFieldEmail;
    case "not-an-option":
      return strings.a2uiFieldChoice;
  }
}

/** A sent value as the action turn's human line says it: a box as yes or no, a choice by its options' words. */
function shownValue(item: A2uiItem, spec: A2uiFieldSpec, value: JsonValue, strings: ChatStrings): string {
  if (spec.kind === "boolean") return value === true ? strings.a2uiYes : strings.a2uiNo;
  if (spec.kind === "text") return asText(value);
  const node = findNode(item.root, spec.componentId);
  const options = node?.component === "ChoicePicker" ? drawnOptions(node.options) : [];
  return (Array.isArray(value) ? value : [value])
    .map((v) => options.find((o) => o.value === v)?.label ?? asText(v))
    .filter((v) => v !== "")
    .join(", ");
}

/** The kit's default `a2ui` slot. */
export function DefaultA2ui({ item, ctx }: { item: A2uiItem; ctx: A2uiRenderContext }): ReactNode {
  // A row drawn outside a transcript keeps its own edits over itself alone.
  const ownItems = useMemo(() => [item], [item]);
  const own = useA2uiEditStore(ownItems);
  const store = ctx.a2uiEdits ?? own;
  const base = useId();
  // The errors the last press found, by data path: an edit clears its path's.
  const [errors, setErrors] = useState<{ readonly [path: string]: string }>({});
  const root = useRef<HTMLDivElement>(null);
  // A press that found errors moves focus to the first field it names, once drawn.
  const jump = useRef(false);
  useEffect(() => {
    if (!jump.current) return;
    jump.current = false;
    const error = root.current?.querySelector(".guuey-chat-a2ui-error");
    const field = error ? root.current?.querySelector<HTMLElement>(`[aria-describedby~="${error.id}"]`) : null;
    // The field itself, or a group's first control.
    (field?.querySelector<HTMLElement>("input,button") ?? field)?.focus();
  }, [errors]);
  if (item.phase === "superseded") {
    return (
      <p className="guuey-chat-a2ui-superseded" role="note" dir="auto">
        {item.label ?? ctx.strings.a2uiUpdatedBelow(words(item.title) ?? ctx.strings.viewRefFallbackTitle)}
      </p>
    );
  }
  const title = words(item.title);
  if (item.root === null && title === null) return null;
  const strings = ctx.strings;
  const onAction = ctx.onA2uiAction;
  const { actionId } = item;
  // "Edit answers" reopens a submitted surface here, against the one action turn that answered it.
  const phase = item.phase === "submitted" && actionId !== undefined && store.reopened(item.surfaceId) === actionId ? "open" : item.phase;
  const read = (key: string, server: JsonValue | null): JsonValue | null => {
    const edit = store.get(item.surfaceId, key);
    return edit !== undefined && sameJson(edit.base, server) ? edit.value : server;
  };
  const env: Env = {
    item,
    strings,
    icon: ctx.a2uiIcon,
    read,
    write: (key, value, server) => {
      store.set(item.surfaceId, key, { value, base: server, at: item.key });
      if (Object.hasOwn(errors, key)) setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));
    },
    locked: phase !== "open",
    send:
      onAction === undefined
        ? undefined
        : (node) => {
            const action = node.action;
            if (action === null) return null;
            // A number box whose text the browser cannot read reports "" (validity.badInput):
            // the check names its path not-a-number.
            const unread = new Set<string>();
            root.current?.querySelectorAll<HTMLInputElement>("input[type=number]").forEach((el) => el.validity.badInput && unread.add(el.name));
            // §9.2: the payload is judged before anything is sent; every failing field says why.
            const check = checkA2uiAction(item.fields, action, (path) => read(path, readA2uiModel(item.dataModel, path) ?? null), unread);
            if (!check.ok) {
              jump.current = true;
              setErrors(Object.fromEntries(Object.entries(check.fields).map(([path, error]) => [path, fieldError(error, strings)])));
              return check.form === "too-large" ? strings.a2uiTooLong : check.form === "undeclared" ? strings.a2uiCantSend : strings.a2uiCheckAnswers;
            }
            setErrors({});
            const pairs: Array<{ label: string; value: string }> = [];
            for (const [key, bound] of Object.entries(action.context ?? {})) {
              const spec = isA2uiPathBinding(bound) && Object.hasOwn(item.fields, bound.path) ? item.fields[bound.path] : undefined;
              const value = check.context[key];
              if (spec === undefined || value === undefined) continue;
              const shown = shownValue(item, spec, value, strings);
              if (shown !== "") pairs.push({ label: words(spec.label) ?? key, value: shown });
            }
            const outcome = onAction(item, {
              surfaceId: item.surfaceId,
              name: action.name,
              sourceComponentId: node.id,
              context: check.context,
              summary: { label: words(node.label) ?? node.label, pairs },
            });
            return { sent: null, busy: strings.a2uiWaitForReply, closed: strings.composerUnavailable, refused: strings.a2uiCantSend }[outcome];
          },
    errors,
    ready: ctx.a2uiActionsReady === true,
    idFor: (componentId, part) => `${base}-${domIdSegment(componentId)}-${part}`,
  };
  const titleId = `${base}-title`;
  return (
    <div ref={root} className="guuey-chat-a2ui" role="group" {...(title !== null ? { "aria-labelledby": titleId } : {})}>
      {title !== null ? (
        <p className="guuey-chat-a2ui-title" id={titleId} dir="auto">
          {title}
        </p>
      ) : null}
      {item.root !== null ? (
        <div className="guuey-chat-a2ui-body">
          <Node node={item.root} env={env} />
        </div>
      ) : null}
      {phase !== "open" ? (
        <p className="guuey-chat-a2ui-stamp guuey-chat-a2ui-row guuey-chat-a2ui-gap-sm" role="status">
          {phase === "sending" ? strings.a2uiSending : strings.a2uiSent}
          {phase === "submitted" && onAction !== undefined && actionId !== undefined ? (
            <button type="button" className={BUTTON_CLASS.secondary} onClick={() => store.reopen(item.surfaceId, actionId)}>
              <Words text={strings.a2uiEditAnswers} />
            </button>
          ) : null}
        </p>
      ) : null}
      {item.attribution !== null ? <p className="guuey-chat-attribution">{item.attribution}</p> : null}
    </div>
  );
}

// ─── One node ───────────────────────────────────────────────────────────

/** A bound value's server side: the model at the path, or the literal itself. */
function serverValue<T extends JsonValue>(item: A2uiItem, bound: A2uiBound<T> | null): { key: string | null; value: JsonValue | null } {
  if (bound === null) return { key: null, value: null };
  if (isA2uiPathBinding(bound)) {
    return { key: bound.path, value: readA2uiModel(item.dataModel, bound.path) ?? null };
  }
  return { key: null, value: bound };
}

/** The edit key of an input: its bound path, or `#<id>` for a literal. */
function editKey(componentId: string, bound: { key: string | null }): string {
  return bound.key ?? `#${componentId}`;
}

function Node({ node, env }: { node: A2uiNode; env: Env }): ReactNode {
  switch (node.component) {
    case "Row":
    case "Column": {
      const classes = [
        node.component === "Row" ? "guuey-chat-a2ui-row" : "guuey-chat-a2ui-column",
        GAP_CLASS[node.gap],
        ...(node.align !== null ? [ALIGN_CLASS[node.align]] : []),
        ...(node.justify !== null ? [JUSTIFY_CLASS[node.justify]] : []),
      ];
      return (
        <div className={classes.join(" ")}>
          {node.children.map((child) => (
            <Node key={child.id} node={child} env={env} />
          ))}
        </div>
      );
    }
    case "Card":
      return <div className="guuey-chat-a2ui-card">{node.child !== null ? <Node node={node.child} env={env} /> : null}</div>;
    case "List":
      return (
        <ul className="guuey-chat-a2ui-list">
          {node.children.map((child) => (
            <li key={child.id}>
              <Node node={child} env={env} />
            </li>
          ))}
        </ul>
      );
    case "Divider":
      return <hr className={DIVIDER_CLASS[node.orientation]} aria-orientation={node.orientation} />;
    case "Text":
      return <A2uiText node={node} env={env} />;
    case "Image":
      return <A2uiImage node={node} env={env} />;
    case "Icon": {
      const HostIcon = env.icon;
      if (HostIcon === undefined || node.name === null) return null;
      return <HostIcon name={node.name} label={words(node.label)} />;
    }
    case "Button":
      return <A2uiButton node={node} env={env} />;
    case "TextField":
      return <A2uiTextField node={node} env={env} />;
    case "CheckBox":
      return <A2uiCheckBox node={node} env={env} />;
    case "ChoicePicker":
      return <A2uiChoicePicker node={node} env={env} />;
    case "unknown":
      return <Unknown env={env} />;
  }
}

type NodeOf<C extends A2uiNode["component"]> = Extract<A2uiNode, { component: C }>;

function Unknown({ env }: { env: Env }): ReactNode {
  return (
    <p className="guuey-chat-a2ui-unknown" role="note">
      {env.strings.unknownLabel}
    </p>
  );
}

function A2uiText({ node, env }: { node: NodeOf<"Text">; env: Env }): ReactNode {
  const bound = serverValue(env.item, node.text);
  const raw = bound.key !== null ? asText(env.read(bound.key, bound.value)) : asText(bound.value);
  const text = truncateUnits(raw, A2UI_LIMITS.textUnits).text;
  const level = HEADING_LEVEL[node.variant];
  const body = <InlineRichText text={text} link={TEXT_LINK} />;
  if (level !== null) {
    return (
      <div className={TEXT_CLASS[node.variant]} role="heading" aria-level={level} dir="auto">
        {body}
      </div>
    );
  }
  return (
    <p className={TEXT_CLASS[node.variant]} dir="auto">
      {body}
    </p>
  );
}

function A2uiImage({ node, env }: { node: NodeOf<"Image">; env: Env }): ReactNode {
  const [failed, setFailed] = useState(false);
  const alt = words(node.alt);
  const display = node.display;
  if (display.kind === "image" && !failed) {
    return <img className="guuey-chat-a2ui-image" src={display.src} alt={alt ?? ""} onError={() => setFailed(true)} />;
  }
  const label = alt ?? env.strings.a2uiImage;
  if (display.kind === "link") {
    return (
      <span className="guuey-chat-a2ui-image-chip" dir="auto">
        {label}{" "}
        <GatedLink target={display} className="guuey-chat-a2ui-open">
          {env.strings.mediaOpenLink}
        </GatedLink>
      </span>
    );
  }
  return (
    <span className="guuey-chat-a2ui-image-chip" dir="auto">
      {label}
    </span>
  );
}

/** A button's words, in the one words element every button draws. */
function Words({ text }: { text: string }): ReactNode {
  return (
    <span className="guuey-chat-a2ui-words" dir="auto">
      {text}
    </span>
  );
}

/**
 * An action press (§9.1): the kit-drawn confirm when the button declares one
 * (never `window.confirm`, which a sandboxed or embedded page may not show),
 * opening under its button with focus on Cancel; Cancel or Escape sends
 * nothing. Beside the button, its note: unwired, why it is off; wired, what
 * the last press did (wait, or why nothing was sent).
 */
function A2uiButton({ node, env }: { node: NodeOf<"Button">; env: Env }): ReactNode {
  const [said, setSaid] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  // A surface that locks closes an open confirm; a wait note goes once the host can take a press.
  const { send, strings, locked } = env;
  if (confirming && locked) setConfirming(false);
  if ((said === strings.a2uiWaitForReply || said === strings.composerUnavailable) && env.ready) setSaid(null);
  const label = words(node.label);
  // A button with no words cannot say what it does: the placeholder, like a missing label.
  if (label === null) return <Unknown env={env} />;
  const className = BUTTON_CLASS[node.variant ?? "secondary"];
  if (node.link !== null) {
    return (
      <GatedLink target={node.link} className={className}>
        {label}
      </GatedLink>
    );
  }
  if (!isActionButton(node)) {
    return (
      <button type="button" className={className} disabled>
        <Words text={label} />
      </button>
    );
  }
  const { confirm } = node;
  const noteId = env.idFor(node.id, "note");
  const confirmId = env.idFor(node.id, "confirm");
  const note = send === undefined ? strings.a2uiUnavailable : said;
  const done = (confirmed: boolean): void => {
    setConfirming(false);
    ref.current?.focus();
    if (confirmed && send !== undefined && !locked) setSaid(send(node));
  };
  const message = confirm !== null ? words(confirm.message) : null;
  return (
    <span className="guuey-chat-a2ui-action">
      <button
        ref={ref}
        type="button"
        className={className}
        disabled={send === undefined || locked}
        onClick={() => (confirm !== null ? setConfirming(true) : done(true))}
        {...(note !== null ? { "aria-describedby": noteId } : {})}
      >
        <Words text={label} />
      </button>
      <span
        className={send === undefined ? "guuey-chat-a2ui-unavailable" : "guuey-chat-a2ui-note"}
        id={noteId}
        {...(send !== undefined ? { role: "status" } : {})}
      >
        {note}
      </span>
      {confirming && confirm !== null ? (
        <div
          className="guuey-chat-a2ui-card guuey-chat-a2ui-column guuey-chat-a2ui-gap-sm"
          role="alertdialog"
          aria-labelledby={confirmId}
          {...(message !== null ? { "aria-describedby": `${confirmId}-m` } : {})}
          onKeyDown={(e) => {
            if (e.key === "Escape") done(false);
          }}
        >
          <p className={TEXT_CLASS.h4} id={confirmId} dir="auto">
            {words(confirm.title) ?? label}
          </p>
          {message !== null ? (
            <p className={TEXT_CLASS.body} id={`${confirmId}-m`} dir="auto">
              {message}
            </p>
          ) : null}
          <div className="guuey-chat-a2ui-row guuey-chat-a2ui-gap-sm">
            <button ref={cancel} type="button" className={BUTTON_CLASS.secondary} onClick={() => done(false)}>
              <Words text={words(confirm.cancelLabel) ?? strings.a2uiCancel} />
            </button>
            <button type="button" className={className} onClick={() => done(true)}>
              <Words text={words(confirm.confirmLabel) ?? strings.a2uiConfirm} />
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

/** A field's error since the last press, beside the field it names; the input is described by it. */
function fieldErrorOf(node: { id: string }, key: string, env: Env): { error: ReactNode; attrs: { [attr: string]: string | boolean } } {
  const text = Object.hasOwn(env.errors, key) ? env.errors[key] : undefined;
  if (text === undefined) return { error: null, attrs: {} };
  const id = env.idFor(node.id, "error");
  return {
    error: (
      <span className="guuey-chat-a2ui-error" id={id} dir="auto">
        {text}
      </span>
    ),
    attrs: { "aria-invalid": true, "aria-describedby": id },
  };
}

/** A field's visible label: the normalized words in an isolate, or nothing. */
function FieldLabel({ text }: { text: string | null }): ReactNode {
  return text !== null ? (
    <span className="guuey-chat-a2ui-label" dir="auto">
      {text}
    </span>
  ) : null;
}

const INPUT_TYPE = { text: "text", number: "number", email: "email" } as const;

function A2uiTextField({ node, env }: { node: NodeOf<"TextField">; env: Env }): ReactNode {
  const label = words(node.label);
  const placeholder = words(node.placeholder);
  const bound = serverValue(env.item, node.value);
  const key = editKey(node.id, bound);
  const value = asText(env.read(key, bound.value));
  const invalid = fieldErrorOf(node, key, env);
  const common = {
    className: "guuey-chat-a2ui-input",
    value,
    dir: "auto",
    readOnly: env.locked,
    name: key,
    onChange: (e: { target: { value: string } }) => env.write(key, e.target.value, bound.value),
    ...(placeholder !== null ? { placeholder } : {}),
    ...(label === null && placeholder !== null ? { "aria-label": placeholder } : {}),
    ...(node.required ? { "aria-required": true } : {}),
    ...(node.maxLength !== null ? { maxLength: node.maxLength } : {}),
    ...invalid.attrs,
  };
  return (
    <>
      <label className="guuey-chat-a2ui-field">
        <FieldLabel text={label} />
        {node.inputType === "long" ? (
          <textarea {...common} />
        ) : (
          <input
            {...common}
            type={INPUT_TYPE[node.inputType]}
            {...(node.inputType === "number" && node.min !== null ? { min: node.min } : {})}
            {...(node.inputType === "number" && node.max !== null ? { max: node.max } : {})}
          />
        )}
      </label>
      {invalid.error}
    </>
  );
}

function A2uiCheckBox({ node, env }: { node: NodeOf<"CheckBox">; env: Env }): ReactNode {
  const label = words(node.label);
  const bound = serverValue(env.item, node.checked);
  const key = editKey(node.id, bound);
  const checked = env.read(key, bound.value) === true;
  const invalid = fieldErrorOf(node, key, env);
  return (
    <>
      <label className="guuey-chat-a2ui-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={env.locked}
          onChange={(e) => env.write(key, e.target.checked, bound.value)}
          {...(node.required ? { "aria-required": true } : {})}
          {...invalid.attrs}
        />
        <FieldLabel text={label} />
      </label>
      {invalid.error}
    </>
  );
}

/** An option drawn by its words, else its value's; an option with neither cannot be named and is not drawn. */
function drawnOptions(options: readonly A2uiChoiceOption[]): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (const option of options) {
    const label = words(option.label) ?? words(option.value);
    if (label !== null) out.push({ value: option.value, label });
  }
  return out;
}

/** What both ChoicePicker layouts share: the field's words, the chosen values, the rows, and how a group says it is required. */
interface Choice {
  node: NodeOf<"ChoicePicker">;
  env: Env;
  label: string | null;
  options: Array<{ value: string; label: string }>;
  chosen: string[];
  labelId: string;
  requiredId: string;
  /** What the field row describes itself by: "Required" and the error since the last press. */
  describedBy: { [attr: string]: string };
  /**
   * How a container of options says it is required (ARIA 1.2): a single
   * choice is a radio group, which takes `aria-required`; a multiple choice
   * is a plain group, which does not, so it is described as required. An
   * error since the last press describes either.
   */
  groupSemantics: { [attr: string]: string | boolean };
  /** The visually hidden "Required" a description points at; null when optional. */
  requiredNote: ReactNode;
  rows(shown: ReadonlyArray<{ value: string; label: string }>): ReactNode;
}

function A2uiChoicePicker({ node, env }: { node: NodeOf<"ChoicePicker">; env: Env }): ReactNode {
  const bound = serverValue(env.item, node.value);
  const key = editKey(node.id, bound);
  const current = env.read(key, bound.value);
  const chosen: string[] =
    typeof current === "string" ? [current] : Array.isArray(current) ? current.filter((v): v is string => typeof v === "string") : [];
  const options = drawnOptions(node.options);
  const name = env.idFor(node.id, "choice");
  const requiredId = env.idFor(node.id, "required");
  const invalid = fieldErrorOf(node, key, env);
  const ids = [...(node.required ? [requiredId] : []), ...(invalid.error !== null ? [env.idFor(node.id, "error")] : [])].join(" ");
  const describedBy: { [attr: string]: string } = ids !== "" ? { "aria-describedby": ids } : {};

  const choose = (value: string, on: boolean): void => {
    if (!node.multiple) {
      env.write(key, value, bound.value);
      return;
    }
    const next = on ? [...chosen.filter((v) => v !== value), value] : chosen.filter((v) => v !== value);
    // Keep the options' own order, so the stored list reads as the list does.
    env.write(
      key,
      options.map((o) => o.value).filter((v) => next.includes(v)),
      bound.value,
    );
  };

  const choice: Choice = {
    node,
    env,
    label: words(node.label),
    options,
    chosen,
    labelId: env.idFor(node.id, "label"),
    requiredId,
    describedBy,
    groupSemantics: !node.multiple
      ? { role: "radiogroup", ...(node.required ? { "aria-required": true } : {}), ...invalid.attrs }
      : { role: "group", ...describedBy },
    requiredNote: node.required ? (
      <span className="guuey-chat-visually-hidden" id={requiredId}>
        {env.strings.a2uiRequired}
      </span>
    ) : null,
    rows: (shown) =>
      shown.map((option) => {
        const selected = chosen.includes(option.value);
        return (
          <label key={option.value} className={selected ? "guuey-chat-a2ui-option guuey-chat-a2ui-option-selected" : "guuey-chat-a2ui-option"}>
            <input
              type={node.multiple ? "checkbox" : "radio"}
              name={name}
              value={option.value}
              checked={selected}
              disabled={env.locked}
              onChange={(e) => choose(option.value, e.target.checked)}
            />
            <span dir="auto">{option.label}</span>
          </label>
        );
      }),
  };
  return (
    <>
      {options.length <= INLINE_OPTIONS ? <InlineChoice choice={choice} /> : <OpenChoice choice={choice} />}
      {invalid.error}
    </>
  );
}

/** Up to {@link INLINE_OPTIONS} options: one named group of rows. */
function InlineChoice({ choice }: { choice: Choice }): ReactNode {
  return (
    <fieldset className="guuey-chat-a2ui-choice" {...choice.groupSemantics}>
      {choice.label !== null ? (
        <legend className="guuey-chat-a2ui-label" dir="auto">
          {choice.label}
        </legend>
      ) : null}
      {choice.rows(choice.options)}
      {choice.node.multiple ? choice.requiredNote : null}
    </fieldset>
  );
}

/** More options: a field row naming the choice, opening the rows, with a local filter above {@link FILTER_OPTIONS}. */
function OpenChoice({ choice }: { choice: Choice }): ReactNode {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const { node, env, label, options, chosen, labelId } = choice;
  const panelId = env.idFor(node.id, "options");
  const listId = env.idFor(node.id, "list");
  const summaryId = env.idFor(node.id, "summary");
  const summary = options
    .filter((o) => chosen.includes(o.value))
    .map((o) => o.label)
    .join(", ");
  const needle = filter.trim().toLowerCase();
  const filtered = options.length > FILTER_OPTIONS;
  const shown = filtered && needle !== "" ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  // What the filter's live region says: nothing until it is typed in, then the count.
  const announcement = needle === "" ? "" : shown.length === 0 ? env.strings.a2uiNoMatch : env.strings.a2uiMatches(shown.length);
  return (
    <div className="guuey-chat-a2ui-choice">
      {label !== null ? (
        <span className="guuey-chat-a2ui-label" id={labelId} dir="auto">
          {label}
        </span>
      ) : null}
      <button
        type="button"
        className="guuey-chat-a2ui-picker"
        aria-expanded={open}
        aria-controls={panelId}
        aria-labelledby={label !== null ? `${labelId} ${summaryId}` : summaryId}
        {...choice.describedBy}
        onClick={() => setOpen((o) => !o)}
      >
        <span id={summaryId} dir="auto">
          {summary !== "" ? summary : env.strings.a2uiChoose}
        </span>
      </button>
      {choice.requiredNote}
      {/* Always in the DOM, so aria-controls never names a missing id (the
          WAI-ARIA disclosure pattern); `hidden` keeps it out of sight, the
          accessibility tree and Tab while closed. */}
      <div
        className="guuey-chat-a2ui-options"
        id={panelId}
        hidden={!open}
        {...choice.groupSemantics}
        {...(label !== null ? { "aria-labelledby": labelId } : {})}
      >
        {filtered ? (
          <>
            <input
              type="search"
              className="guuey-chat-a2ui-filter"
              aria-label={env.strings.a2uiFilter}
              aria-controls={listId}
              autoComplete="off"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {/* In the DOM before the first keystroke, so each change is announced, politely. */}
            <p className="guuey-chat-visually-hidden" role="status" aria-live="polite">
              {announcement}
            </p>
          </>
        ) : null}
        <div className="guuey-chat-a2ui-option-list" id={listId}>
          {shown.length > 0 ? choice.rows(shown) : <p className="guuey-chat-a2ui-empty">{env.strings.a2uiNoMatch}</p>}
        </div>
      </div>
    </div>
  );
}
