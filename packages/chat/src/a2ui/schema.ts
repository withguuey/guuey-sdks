/**
 * The guuey A2UI schema (guuey#2366, spec §5): an A2UI v0.9 superset — the
 * same three write messages plus `updateDataModel`, the same twelve
 * components with typed props, bindings, actions and field constraints.
 *
 * ONE source: every wire type below is inferred from these zod schemas, and
 * the validator parses each component's props against the same shapes
 * (`A2UI_COMPONENT_PROPS`), prop by prop, so a bad prop is dropped alone
 * rather than voiding the component. Unknown fields are stripped (the zod
 * default, as `@ggui-ai/preview-a2ui` does).
 *
 * Every string a carrier holds is drawn as TEXT. `Text.text` alone carries the
 * kit's safe inline formatting (ruling 6), judged by the renderer, never here:
 * the schema reads it as a string with no markup check.
 */
import { z } from "zod";
import { JsonValue } from "@silverprotocol/core";
import type { A2uiImageDisplay, A2uiLink } from "./url-policy.js";
import { A2UI_LIMITS } from "./limits.js";

/** The A2UI protocol version guuey reads. */
export const A2UI_VERSION = "v0.9";

/** guuey's own catalog id (advisory: any non-empty `catalogId` is accepted and components draw by name). */
export const A2UI_GUUEY_CATALOG_ID = "guuey.a2ui.v1";

/** Surface ids, component ids, action names (the action tag line's attribute charset, spec §9.3). */
export const A2UI_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Action `context` keys. */
export const A2UI_CONTEXT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Why a data path does not read: a malformed RFC 6901 pointer, or one deeper than the bound. */
export type A2uiDataPathFault = "malformed" | "too-deep";

/**
 * A data path, RFC 6901 subset: `""` (the whole model) or `/seg(/seg)*`,
 * `~0`/`~1` the only escapes, each unescaped segment ≤ 64 units, ≤ 8
 * segments. Returns the unescaped segments, or the fault.
 */
export function readA2uiDataPath(path: string): { segments: string[] } | { fault: A2uiDataPathFault } {
  if (path === "") return { segments: [] };
  if (!path.startsWith("/")) return { fault: "malformed" };
  const raw = path.slice(1).split("/");
  const segments: string[] = [];
  for (const segment of raw) {
    if (/~(?![01])/.test(segment)) return { fault: "malformed" };
    const unescaped = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (unescaped.length > A2UI_LIMITS.dataPathSegmentUnits) return { fault: "malformed" };
    segments.push(unescaped);
  }
  if (segments.length > A2UI_LIMITS.dataPathDepth) return { fault: "too-deep" };
  return { segments };
}

export const A2uiId = z.string().regex(A2UI_ID_PATTERN);
export const A2uiDataPath = z.string().refine((p) => "segments" in readA2uiDataPath(p), "not a data path");

/** A read from the surface's data model: a literal lookup, no expressions. */
export const A2uiPathBinding = z.object({ path: A2uiDataPath });
export type A2uiPathBinding = z.infer<typeof A2uiPathBinding>;

/** A literal, or a read from the surface's data model. */
export type A2uiBound<T> = T | A2uiPathBinding;

export const A2uiJsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type A2uiJsonScalar = z.infer<typeof A2uiJsonScalar>;

export const A2uiAlign = z.enum(["start", "center", "end", "stretch"]);
export type A2uiAlign = z.infer<typeof A2uiAlign>;
export const A2uiJustify = z.enum(["start", "center", "end", "between", "around", "evenly"]);
export type A2uiJustify = z.infer<typeof A2uiJustify>;
export const A2uiOrientation = z.enum(["horizontal", "vertical"]);
export type A2uiOrientation = z.infer<typeof A2uiOrientation>;
export const A2uiButtonVariant = z.enum(["primary", "secondary", "danger"]);
export type A2uiButtonVariant = z.infer<typeof A2uiButtonVariant>;
export const A2uiInputType = z.enum(["text", "long", "number", "email"]);
export type A2uiInputType = z.infer<typeof A2uiInputType>;

/** `Row`/`Column` gap tokens; any other string draws as `md` (not a fault). */
export const A2UI_GAP_TOKENS = ["none", "xs", "sm", "md", "lg", "xl"] as const;
export type A2uiGap = (typeof A2UI_GAP_TOKENS)[number];

/** `Text` variants; any other string draws as `body` (not a fault). */
export const A2UI_TEXT_VARIANTS = ["h1", "h2", "h3", "h4", "h5", "h6", "body", "caption", "label"] as const;
export type A2uiTextVariant = (typeof A2UI_TEXT_VARIANTS)[number];

/** A button's action (spec §5.5). `name` carries the id charset, checked at carrier validation. */
export const A2uiAction = z.object({
  name: A2uiId,
  context: z.record(z.string().regex(A2UI_CONTEXT_KEY_PATTERN), z.union([A2uiJsonScalar, A2uiPathBinding])).optional(),
});
export type A2uiAction = z.infer<typeof A2uiAction>;

export const A2uiConfirm = z.object({
  title: z.string(),
  message: z.string(),
  confirmLabel: z.string().optional(),
  cancelLabel: z.string().optional(),
});
export type A2uiConfirm = z.infer<typeof A2uiConfirm>;

export const A2uiChoiceOption = z.object({ label: z.string(), value: z.string() });
export type A2uiChoiceOption = z.infer<typeof A2uiChoiceOption>;

/** The twelve component names (A2UI v0.9's basic set, as `@ggui-ai/preview-a2ui` lists them). */
export const A2UI_COMPONENT_NAMES = [
  "Row",
  "Column",
  "Card",
  "List",
  "Divider",
  "Text",
  "Image",
  "Icon",
  "Button",
  "TextField",
  "CheckBox",
  "ChoicePicker",
] as const;
export type A2uiComponentName = (typeof A2UI_COMPONENT_NAMES)[number];

export function isA2uiComponentName(name: string): name is A2uiComponentName {
  return (A2UI_COMPONENT_NAMES as readonly string[]).includes(name);
}

/** The input components: a surface holding one is interactive (spec §5.7). */
export const A2UI_INPUT_COMPONENTS: readonly A2uiComponentName[] = ["TextField", "CheckBox", "ChoicePicker"];

const containerProps = {
  children: z.array(z.string()),
  gap: z.string(),
  align: A2uiAlign,
  justify: A2uiJustify,
};

/**
 * Each component's typed props (spec §5.3). Every prop is optional on the
 * wire; `Text.text`, `Button.label` and `Image.src` are required in use (the
 * validator draws a component without a usable one as a placeholder or chip).
 */
export const A2UI_COMPONENT_PROPS = {
  Row: containerProps,
  Column: containerProps,
  Card: { child: z.string() },
  List: { children: z.array(z.string()) },
  Divider: { orientation: A2uiOrientation },
  Text: { text: z.union([z.string(), A2uiPathBinding]), variant: z.string() },
  Image: { src: z.string().min(1), alt: z.string() },
  Icon: { name: z.string().min(1), label: z.string() },
  Button: {
    label: z.string(),
    action: A2uiAction,
    href: z.string(),
    variant: A2uiButtonVariant,
    confirm: A2uiConfirm,
  },
  TextField: {
    label: z.string(),
    placeholder: z.string(),
    value: z.union([z.string(), A2uiPathBinding]),
    inputType: A2uiInputType,
    required: z.boolean(),
    maxLength: z.number().int().min(0).max(A2UI_LIMITS.textFieldMaxLength),
    min: z.number(),
    max: z.number(),
  },
  CheckBox: { label: z.string(), checked: z.union([z.boolean(), A2uiPathBinding]), required: z.boolean() },
  ChoicePicker: {
    label: z.string(),
    options: z.array(A2uiChoiceOption),
    value: z.union([z.string(), z.array(z.string()), A2uiPathBinding]),
    multiple: z.boolean(),
    required: z.boolean(),
  },
} as const satisfies { [N in A2uiComponentName]: z.ZodRawShape };

/** Each component kind's props schema, every prop optional: what the validator parses a component's props against. */
export const A2UI_PROPS_SCHEMAS = {
  Row: z.object(A2UI_COMPONENT_PROPS.Row).partial(),
  Column: z.object(A2UI_COMPONENT_PROPS.Column).partial(),
  Card: z.object(A2UI_COMPONENT_PROPS.Card).partial(),
  List: z.object(A2UI_COMPONENT_PROPS.List).partial(),
  Divider: z.object(A2UI_COMPONENT_PROPS.Divider).partial(),
  Text: z.object(A2UI_COMPONENT_PROPS.Text).partial(),
  Image: z.object(A2UI_COMPONENT_PROPS.Image).partial(),
  Icon: z.object(A2UI_COMPONENT_PROPS.Icon).partial(),
  Button: z.object(A2UI_COMPONENT_PROPS.Button).partial(),
  TextField: z.object(A2UI_COMPONENT_PROPS.TextField).partial(),
  CheckBox: z.object(A2UI_COMPONENT_PROPS.CheckBox).partial(),
  ChoicePicker: z.object(A2UI_COMPONENT_PROPS.ChoicePicker).partial(),
} as const;

/** One component kind's props as the validator hands them on (every prop optional). */
export type A2uiPropsOf<N extends A2uiComponentName> = z.infer<(typeof A2UI_PROPS_SCHEMAS)[N]>;

const base = { id: A2uiId };

/** A component as a producer writes it (the strict wire shape). */
export const A2uiComponentSchema = z.discriminatedUnion("component", [
  A2UI_PROPS_SCHEMAS.Row.extend({ ...base, component: z.literal("Row") }),
  A2UI_PROPS_SCHEMAS.Column.extend({ ...base, component: z.literal("Column") }),
  A2UI_PROPS_SCHEMAS.Card.extend({ ...base, component: z.literal("Card") }),
  A2UI_PROPS_SCHEMAS.List.extend({ ...base, component: z.literal("List") }),
  A2UI_PROPS_SCHEMAS.Divider.extend({ ...base, component: z.literal("Divider") }),
  A2UI_PROPS_SCHEMAS.Text.extend({ ...base, component: z.literal("Text") }),
  A2UI_PROPS_SCHEMAS.Image.extend({ ...base, component: z.literal("Image") }),
  A2UI_PROPS_SCHEMAS.Icon.extend({ ...base, component: z.literal("Icon") }),
  A2UI_PROPS_SCHEMAS.Button.extend({ ...base, component: z.literal("Button") }),
  A2UI_PROPS_SCHEMAS.TextField.extend({ ...base, component: z.literal("TextField") }),
  A2UI_PROPS_SCHEMAS.CheckBox.extend({ ...base, component: z.literal("CheckBox") }),
  A2UI_PROPS_SCHEMAS.ChoicePicker.extend({ ...base, component: z.literal("ChoicePicker") }),
]);
export type A2uiComponent = z.infer<typeof A2uiComponentSchema>;

const version = z.literal(A2UI_VERSION);

export const A2uiCreateSurfaceMessage = z.object({
  version,
  createSurface: z.object({ surfaceId: A2uiId, catalogId: z.string().min(1), title: z.string().optional() }),
});
export const A2uiUpdateComponentsMessage = z.object({
  version,
  updateComponents: z.object({ surfaceId: A2uiId, components: z.array(A2uiComponentSchema) }),
});
export const A2uiUpdateDataModelMessage = z.object({
  version,
  updateDataModel: z.object({ surfaceId: A2uiId, path: A2uiDataPath.optional(), value: JsonValue }),
});
export const A2uiDeleteSurfaceMessage = z.object({ version, deleteSurface: z.object({ surfaceId: A2uiId }) });

/** One server → client message, keyed by presence (A2UI's envelope form), as a producer writes it. */
export const A2uiServerMessageSchema = z.union([
  A2uiCreateSurfaceMessage,
  A2uiUpdateComponentsMessage,
  A2uiUpdateDataModelMessage,
  A2uiDeleteSurfaceMessage,
]);
export type A2uiServerMessage = z.infer<typeof A2uiServerMessageSchema>;

/** The four message keys, in the order the validator recognizes them. */
export const A2UI_MESSAGE_KEYS = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"] as const;
export type A2uiMessageKey = (typeof A2UI_MESSAGE_KEYS)[number];

/**
 * The carrier under `structuredContent["com.guuey/a2ui"]`, as a producer
 * writes it (spec §4.1). `format` absent reads as `"a2ui"`; `mimeType` is
 * informational and ignored. (The json-render arm is S5's.)
 */
export const A2uiCarrierSchema = z.object({
  format: z.literal("a2ui").optional(),
  version,
  messages: z.array(A2uiServerMessageSchema),
  mimeType: z.string().optional(),
});
export type A2uiCarrier = z.infer<typeof A2uiCarrierSchema>;

// ─── What the validator and the fold hand on ─────────────────────────────

/** A JSON object (a surface's data model is one). */
export type A2uiJsonObject = { [key: string]: JsonValue };

/** One component kind with its parsed props. */
export type A2uiParsedComponent =
  | { [N in A2uiComponentName]: { component: N; props: A2uiPropsOf<N> } }[A2uiComponentName]
  /** An unknown component name, or a component with no usable required prop: a labeled placeholder. */
  | { component: "unknown"; name: string };

/**
 * Faults that degrade a component in place on a read-only surface and take
 * the old face on an interactive one (spec §5.7, §6).
 */
export const A2UI_COMPONENT_FAULTS = [
  "unknown-component",
  "bad-id",
  "dangling-child",
  "shared-child",
  "bad-prop",
  "dropped-children",
  "dropped-items",
  "dropped-options",
  "truncated-text",
  "truncated-label",
  "data-model-refused",
  "data-model-too-large",
  /** The surface has components but none is its root (no `root` id, and every first-batch id has a parent). */
  "no-root",
  /** A component nothing references and that is not the root: it would never draw. */
  "unreferenced-component",
] as const;
export type A2uiComponentFault = (typeof A2UI_COMPONENT_FAULTS)[number];

/**
 * The closed carve-out list (spec §5.7): stays in place on every surface,
 * because neither removes a field or an action.
 */
export const A2UI_CARVE_OUTS = ["refused-image", "refused-link"] as const;
export type A2uiCarveOut = (typeof A2UI_CARVE_OUTS)[number];

/** Counts of each in-place degrade a surface revision carries (the `a2ui-degraded` debug event's counts). */
export type A2uiDegradeCounts = { [K in A2uiComponentFault | A2uiCarveOut]?: number };

/** Envelope faults: always the old face (spec §5.7). */
export const A2UI_ENVELOPE_FAULTS = [
  "too-large",
  "not-object",
  "unsupported-format",
  "bad-version",
  "bad-shape",
  "unrecognized-message",
  "bad-surface-id",
  "too-many-messages",
  "too-many-surfaces",
  "too-many-components",
  "too-deep",
  "cycle",
  "bad-path",
  "path-too-deep",
  "too-many-context-keys",
] as const;
export type A2uiEnvelopeFault = (typeof A2UI_ENVELOPE_FAULTS)[number];

/** Every reason a carrier takes the old face: an envelope fault, or a component fault on an interactive surface. */
export type A2uiInvalidReason = A2uiEnvelopeFault | A2uiComponentFault;

// ─── The resolved tree a renderer draws ──────────────────────────────────

interface A2uiNodeBase {
  /** The component id, kept for keys. */
  id: string;
}

/** One resolved, validated component, children nested (a tree, never a DAG). */
export type A2uiNode =
  | (A2uiNodeBase & {
      component: "Row" | "Column";
      children: A2uiNode[];
      gap: A2uiGap;
      align: A2uiAlign | null;
      justify: A2uiJustify | null;
    })
  | (A2uiNodeBase & { component: "Card"; child: A2uiNode | null })
  | (A2uiNodeBase & { component: "List"; children: A2uiNode[] })
  | (A2uiNodeBase & { component: "Divider"; orientation: A2uiOrientation })
  | (A2uiNodeBase & {
      component: "Text";
      /** A literal is already within the text bound; a binding is read (and bounded) against the model at draw time. */
      text: A2uiBound<string>;
      variant: A2uiTextVariant;
    })
  | (A2uiNodeBase & { component: "Image"; display: A2uiImageDisplay; alt: string | null })
  | (A2uiNodeBase & {
      component: "Icon";
      /** The host-injected icon component draws it; `null` (or a name it does not know) draws nothing. */
      name: string | null;
      label: string | null;
    })
  | (A2uiNodeBase & {
      component: "Button";
      label: string;
      action: A2uiAction | null;
      /** An https link with its host; `null` when the button has no `href` or a refused one (inert). */
      link: A2uiLink | null;
      variant: A2uiButtonVariant | null;
      confirm: { title: string; message: string; confirmLabel: string | null; cancelLabel: string | null } | null;
    })
  | (A2uiNodeBase & {
      component: "TextField";
      label: string | null;
      placeholder: string | null;
      value: A2uiBound<string> | null;
      inputType: A2uiInputType;
      required: boolean;
      maxLength: number | null;
      min: number | null;
      max: number | null;
    })
  | (A2uiNodeBase & { component: "CheckBox"; label: string | null; checked: A2uiBound<boolean> | null; required: boolean })
  | (A2uiNodeBase & {
      component: "ChoicePicker";
      label: string | null;
      options: A2uiChoiceOption[];
      value: A2uiBound<string | string[]> | null;
      multiple: boolean;
      required: boolean;
    })
  /** A labeled placeholder (R15) for an unknown component or one with no usable required prop. */
  | (A2uiNodeBase & { component: "unknown"; name: string });

/**
 * One path of the declared model (spec §5.4): the constraint an action
 * payload is validated against, derived from the input component bound there.
 */
export type A2uiFieldSpec =
  | {
      kind: "text";
      componentId: string;
      label: string | null;
      inputType: A2uiInputType;
      required: boolean;
      maxLength: number | null;
      min: number | null;
      max: number | null;
    }
  | { kind: "boolean"; componentId: string; label: string | null; required: boolean }
  | { kind: "choice"; componentId: string; label: string | null; options: string[]; multiple: boolean; required: boolean };
