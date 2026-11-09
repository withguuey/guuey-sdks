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
 *   unmounts keeps its edits. A newer server value at a path wins over an
 *   edit made against the older one; untouched edits survive.
 * - Actions are S4's. With no action path wired, an action button is drawn
 *   disabled and described by one "Not available here" note (§9.1.5).
 */
import { useId, useMemo, useState, type ComponentType, type ReactNode } from "react";
import type { JsonValue } from "@silverprotocol/core";
import { tapText } from "@guuey/mcp-apps-host/narrowing";
import { A2UI_LIMITS, truncateUnits } from "../a2ui/limits.js";
import { readA2uiModel } from "../a2ui/fold.js";
import { httpsLink } from "../a2ui/url-policy.js";
import type {
  A2uiAlign,
  A2uiBound,
  A2uiButtonVariant,
  A2uiChoiceOption,
  A2uiGap,
  A2uiJustify,
  A2uiNode,
  A2uiOrientation,
  A2uiTextVariant,
} from "../a2ui/schema.js";
import type { A2uiItem } from "../types.js";
import type { ChatStrings } from "../strings.js";
import { InlineRichText, type InlineLinkGate } from "./markdown.js";

// ─── The host-owned edit store (§5.4) ───────────────────────────────────

/** One local edit, with the server value it was made against. */
export interface A2uiLocalEdit {
  value: JsonValue;
  /** The server value at that key when the edit was made: a newer, different server value wins. */
  base: JsonValue | null;
}

/**
 * A surface's local edits, held at transcript level (spec §5.4). `key` is the
 * data path an input is bound to (`/name`), or `#<componentId>` for an input
 * with a literal value (editable, never addressable by an action).
 */
export interface A2uiEditStore {
  get(surfaceId: string, key: string): A2uiLocalEdit | undefined;
  set(surfaceId: string, key: string, edit: A2uiLocalEdit): void;
}

/** What a host's icon component receives: the registry name and the accessible name (§5.3). */
export interface A2uiIconProps {
  name: string;
  label: string | null;
}

/** The kit's edit store: a transcript-level map; each write is a new map, so the rows re-render. */
export function useA2uiEditStore(): A2uiEditStore {
  const [edits, setEdits] = useState<ReadonlyMap<string, A2uiLocalEdit>>(() => new Map());
  return useMemo(
    () => ({
      get: (surfaceId, key) => edits.get(JSON.stringify([surfaceId, key])),
      set: (surfaceId, key, edit) => setEdits((prev) => new Map(prev).set(JSON.stringify([surfaceId, key]), edit)),
    }),
    [edits],
  );
}

/** The slice of the transcript context the renderer reads. */
export interface A2uiRenderContext {
  strings: ChatStrings;
  a2uiEdits?: A2uiEditStore;
  a2uiIcon?: ComponentType<A2uiIconProps>;
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
  /** The id of the surface's one "Not available here" note. */
  unavailableId: string;
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

/** Whether a tree holds an action button, so the surface draws its one note. */
function hasAction(node: A2uiNode): boolean {
  switch (node.component) {
    case "Row":
    case "Column":
    case "List":
      return node.children.some(hasAction);
    case "Card":
      return node.child !== null && hasAction(node.child);
    case "Button":
      return node.action !== null && node.link === null && words(node.label) !== null;
    default:
      return false;
  }
}

/** The kit's default `a2ui` slot. */
export function DefaultA2ui({ item, ctx }: { item: A2uiItem; ctx: A2uiRenderContext }): ReactNode {
  const own = useA2uiEditStore();
  const store = ctx.a2uiEdits ?? own;
  const base = useId();
  if (item.phase === "superseded") {
    return (
      <p className="guuey-chat-a2ui-superseded" role="note" dir="auto">
        {item.label ?? ctx.strings.a2uiUpdatedBelow(words(item.title) ?? ctx.strings.viewRefFallbackTitle)}
      </p>
    );
  }
  const title = words(item.title);
  if (item.root === null && title === null) return null;
  const env: Env = {
    item,
    strings: ctx.strings,
    icon: ctx.a2uiIcon,
    read: (key, server) => {
      const edit = store.get(item.surfaceId, key);
      return edit !== undefined && sameJson(edit.base, server) ? edit.value : server;
    },
    write: (key, value, server) => store.set(item.surfaceId, key, { value, base: server }),
    locked: item.phase !== "open",
    unavailableId: `${base}-unavailable`,
    idFor: (componentId, part) => `${base}-${domIdSegment(componentId)}-${part}`,
  };
  const titleId = `${base}-title`;
  return (
    <div className="guuey-chat-a2ui" role="group" {...(title !== null ? { "aria-labelledby": titleId } : {})}>
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
      {item.root !== null && hasAction(item.root) ? (
        <p className="guuey-chat-a2ui-unavailable" id={env.unavailableId}>
          {ctx.strings.a2uiUnavailable}
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
  if (typeof bound === "object" && !Array.isArray(bound) && bound !== null && "path" in bound && typeof bound.path === "string") {
    return { key: bound.path, value: readA2uiModel(item.dataModel, bound.path) ?? null };
  }
  return { key: null, value: bound };
}

/** The edit key of an input: its bound path, or `#<id>` for a literal. */
function editKey(componentId: string, bound: { key: string | null }): string {
  return bound.key ?? `#${componentId}`;
}

/** A model value drawn as text: strings, numbers and booleans; anything else draws empty. */
function asText(value: JsonValue | null): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
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
        <a className="guuey-chat-a2ui-open" href={display.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
          {env.strings.mediaOpenLink}
          <HostLabel host={display.host} />
        </a>
      </span>
    );
  }
  return (
    <span className="guuey-chat-a2ui-image-chip" dir="auto">
      {label}
    </span>
  );
}

/** The host a link shows beside its words (§7.3): a left-to-right isolate, so agent text cannot reorder it. */
function HostLabel({ host }: { host: string }): ReactNode {
  return (
    <bdi className="guuey-chat-a2ui-host" dir="ltr">
      {" · "}
      {host}
    </bdi>
  );
}

function A2uiButton({ node, env }: { node: NodeOf<"Button">; env: Env }): ReactNode {
  const label = words(node.label);
  // A button with no words cannot say what it does: the placeholder, like a missing label.
  if (label === null) return <Unknown env={env} />;
  const className = BUTTON_CLASS[node.variant ?? "secondary"];
  if (node.link !== null) {
    return (
      <a className={className} href={node.link.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
        <span dir="auto">{label}</span>
        <HostLabel host={node.link.host} />
      </a>
    );
  }
  return (
    <button type="button" className={className} disabled {...(node.action !== null ? { "aria-describedby": env.unavailableId } : {})}>
      <span dir="auto">{label}</span>
    </button>
  );
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
  const common = {
    className: "guuey-chat-a2ui-input",
    value,
    dir: "auto",
    readOnly: env.locked,
    onChange: (e: { target: { value: string } }) => env.write(key, e.target.value, bound.value),
    ...(placeholder !== null ? { placeholder } : {}),
    ...(label === null && placeholder !== null ? { "aria-label": placeholder } : {}),
    ...(node.required ? { "aria-required": true } : {}),
    ...(node.maxLength !== null ? { maxLength: node.maxLength } : {}),
  };
  return (
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
  );
}

function A2uiCheckBox({ node, env }: { node: NodeOf<"CheckBox">; env: Env }): ReactNode {
  const label = words(node.label);
  const bound = serverValue(env.item, node.checked);
  const key = editKey(node.id, bound);
  const checked = env.read(key, bound.value) === true;
  return (
    <label className="guuey-chat-a2ui-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={env.locked}
        onChange={(e) => env.write(key, e.target.checked, bound.value)}
        {...(node.required ? { "aria-required": true } : {})}
      />
      <FieldLabel text={label} />
    </label>
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

function A2uiChoicePicker({ node, env }: { node: NodeOf<"ChoicePicker">; env: Env }): ReactNode {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const label = words(node.label);
  const bound = serverValue(env.item, node.value);
  const key = editKey(node.id, bound);
  const current = env.read(key, bound.value);
  const chosen: string[] =
    typeof current === "string" ? [current] : Array.isArray(current) ? current.filter((v): v is string => typeof v === "string") : [];
  const options = drawnOptions(node.options);
  const name = env.idFor(node.id, "choice");
  const labelId = env.idFor(node.id, "label");
  const requiredId = env.idFor(node.id, "required");
  /**
   * How a container of options says it is required (ARIA 1.2): a single
   * choice is a radio group, which takes `aria-required`; a multiple choice
   * is a plain group, which does not, so it is described as required.
   */
  const groupSemantics = !node.multiple
    ? { role: "radiogroup", ...(node.required ? { "aria-required": true } : {}) }
    : { role: "group", ...(node.required ? { "aria-describedby": requiredId } : {}) };
  const requiredNote = node.required ? (
    <span className="guuey-chat-visually-hidden" id={requiredId}>
      {env.strings.a2uiRequired}
    </span>
  ) : null;

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

  const rows = (shown: typeof options): ReactNode =>
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
    });

  if (options.length <= INLINE_OPTIONS) {
    return (
      <fieldset className="guuey-chat-a2ui-choice" {...groupSemantics}>
        {label !== null ? (
          <legend className="guuey-chat-a2ui-label" dir="auto">
            {label}
          </legend>
        ) : null}
        {rows(options)}
        {node.multiple ? requiredNote : null}
      </fieldset>
    );
  }

  const panelId = env.idFor(node.id, "options");
  const summaryId = env.idFor(node.id, "summary");
  const summary = options
    .filter((o) => chosen.includes(o.value))
    .map((o) => o.label)
    .join(", ");
  const needle = filter.trim().toLowerCase();
  const shown = options.length > FILTER_OPTIONS && needle !== "" ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
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
        {...(node.required ? { "aria-describedby": requiredId } : {})}
        onClick={() => setOpen((o) => !o)}
      >
        <span id={summaryId} dir="auto">
          {summary !== "" ? summary : env.strings.a2uiChoose}
        </span>
      </button>
      {requiredNote}
      {open ? (
        <div className="guuey-chat-a2ui-options" id={panelId} {...groupSemantics} {...(label !== null ? { "aria-labelledby": labelId } : {})}>
          {options.length > FILTER_OPTIONS ? (
            <input
              type="search"
              className="guuey-chat-a2ui-filter"
              aria-label={env.strings.a2uiFilter}
              autoComplete="off"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          ) : null}
          {shown.length > 0 ? rows(shown) : <p className="guuey-chat-a2ui-empty">{env.strings.a2uiNoMatch}</p>}
        </div>
      ) : null}
    </div>
  );
}

