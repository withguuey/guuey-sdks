/**
 * The A2UI carrier validator (guuey#2366, spec §5.6, §5.7). Pure, total, never
 * throws; the reason codes are closed (`A2uiInvalidReason`).
 *
 *  - `parseA2uiCarrier`: the envelope stage. The carrier bound, its shape, the
 *    format and versions, each message's one recognized key, surface ids,
 *    data paths (in `updateDataModel` and in every binding), the per-carrier
 *    counts, and each component parsed prop by prop against the one schema.
 *  - `foldA2uiCarrier`: the envelope stage, then the messages applied onto a
 *    fold state (`applyA2uiMessages`), which reads the class of each surface
 *    on the resulting tree.
 *  - `validateA2uiCarrier`: the same on a fresh state, for a producer checking
 *    what it emits. `ok: true` means every surface it targets draws natively.
 *
 * Conformance (ruling 4): every message `@ggui-ai/preview-a2ui` accepts whose
 * ids fall in guuey's id charset is accepted here and draws as the same kinds
 * (the frozen vectors, `__fixtures__/`). guuey accepts more (its superset
 * fields; an unknown component degrades to a placeholder instead of rejecting
 * the message). Two deliberate refusals differ from preview's: an id outside
 * the charset (preview takes any non-empty string), and a message with two
 * recognized keys (preview's union keeps the first and drops the other).
 */
import type { JsonValue } from "@silverprotocol/core";
import { isJsonObject } from "@guuey/mcp-apps-host";
import { A2UI_CARRIER_MAX_UNITS, a2uiCarrierUnits } from "@guuey/mcp-apps-host/narrowing";
import { A2UI_LIMITS } from "./limits.js";
import {
  A2UI_ID_PATTERN,
  A2UI_INPUT_COMPONENTS,
  A2UI_MESSAGE_KEYS,
  A2UI_PROPS_SCHEMAS,
  A2UI_VERSION,
  isA2uiComponentName,
  readA2uiDataPath,
  type A2uiComponentFault,
  type A2uiComponentName,
  type A2uiEnvelopeFault,
  type A2uiInvalidReason,
  type A2uiJsonObject,
  type A2uiParsedComponent,
} from "./schema.js";
import {
  applyA2uiMessages,
  EMPTY_A2UI_STATE,
  type A2uiComponentEntry,
  type A2uiFoldState,
  type A2uiParsedMessage,
  type A2uiSurfaceOutcome,
} from "./fold.js";
import { DEFAULT_A2UI_MEDIA_POLICY, type A2uiMediaPolicy } from "./url-policy.js";

/** The envelope stage's result. */
export type A2uiEnvelopeResult =
  | { ok: true; messages: A2uiParsedMessage[] }
  | {
      ok: false;
      reason: A2uiEnvelopeFault;
      /** A JSON pointer into the carrier. */
      path: string;
      /** The surface ids the carrier names, as far as they read (to close a stale interactive revision). */
      surfaceIds: string[];
    };

/** A carrier judged on a fold state. */
export type A2uiFoldResult =
  | { ok: true; state: A2uiFoldState; surfaces: A2uiSurfaceOutcome[] }
  | { ok: false; reason: A2uiInvalidReason; path: string; level: "envelope" | "component"; surfaceIds: string[] };

/** A carrier judged on its own (a fresh state). */
export type A2uiValidation =
  | { ok: true; surfaces: A2uiSurfaceOutcome[] }
  | { ok: false; reason: A2uiInvalidReason; path: string; level: "envelope" | "component"; surfaceIds: string[] };

function isId(value: JsonValue | undefined): value is string {
  return typeof value === "string" && A2UI_ID_PATTERN.test(value);
}

/** The surface ids a carrier's messages name, read leniently (charset-valid ids only, first-seen order). */
function namedSurfaceIds(messages: JsonValue | undefined, maxMessages = Infinity): string[] {
  const ids: string[] = [];
  if (!Array.isArray(messages)) return ids;
  for (const [i, message] of messages.entries()) {
    if (i >= maxMessages) break;
    if (!isJsonObject(message)) continue;
    for (const key of A2UI_MESSAGE_KEYS) {
      const payload = message[key];
      const id = isJsonObject(payload) ? payload["surfaceId"] : undefined;
      if (isId(id) && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** A `{path}` binding's path fault, if the value is a binding whose path does not read. */
function bindingFault(value: JsonValue | undefined): A2uiEnvelopeFault | null {
  if (!isJsonObject(value) || typeof value["path"] !== "string") return null;
  const read = readA2uiDataPath(value["path"]);
  return "fault" in read ? (read.fault === "too-deep" ? "path-too-deep" : "bad-path") : null;
}

/** Where a component kind reads a binding. */
const BINDING_PROPS: { [N in A2uiComponentName]?: readonly string[] } = {
  Text: ["text"],
  TextField: ["value"],
  CheckBox: ["checked"],
  ChoicePicker: ["value"],
};

/** The envelope faults inside one component: a malformed binding, or too many action context keys. */
function componentEnvelopeFault(
  name: A2uiComponentName,
  raw: A2uiJsonObject,
  at: string,
): { reason: A2uiEnvelopeFault; path: string } | null {
  for (const prop of BINDING_PROPS[name] ?? []) {
    const fault = bindingFault(raw[prop]);
    if (fault !== null) return { reason: fault, path: `${at}/${prop}` };
  }
  const action = name === "Button" ? raw["action"] : undefined;
  const context = isJsonObject(action) ? action["context"] : undefined;
  if (isJsonObject(context)) {
    const keys = Object.keys(context);
    if (keys.length > A2UI_LIMITS.actionContextKeys) return { reason: "too-many-context-keys", path: `${at}/action/context` };
    for (const key of keys) {
      const fault = bindingFault(context[key]);
      if (fault !== null) return { reason: fault, path: `${at}/action/context/${key}` };
    }
  }
  return null;
}

/**
 * Props parsed against a schema leniently: a prop the schema refuses is
 * dropped alone (and named), every other prop kept; unknown props are stripped.
 */
function lenientParse<T>(
  schema: { safeParse(input: JsonValue): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[] }> } } },
  raw: A2uiJsonObject,
): { props: T; bad: string[] } {
  let input: A2uiJsonObject = raw;
  const bad: string[] = [];
  for (;;) {
    const result = schema.safeParse(input);
    if (result.success) return { props: result.data, bad };
    const refused = new Set<string>();
    for (const issue of result.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && Object.hasOwn(input, key)) refused.add(key);
    }
    // An issue that names no prop of the input cannot be dropped alone: drop every prop.
    const drop = refused.size > 0 ? refused : new Set(Object.keys(input));
    bad.push(...drop);
    input = Object.fromEntries(Object.entries(input).filter(([key]) => !drop.has(key)));
  }
}

/** One component kind's props parsed into the parsed-component union, with the count of dropped props. */
function parseProps(name: A2uiComponentName, raw: A2uiJsonObject): { parsed: A2uiParsedComponent; bad: number } {
  switch (name) {
    case "Row":
    case "Column": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS[name], raw);
      return { parsed: { component: name, props }, bad: bad.length };
    }
    case "Card": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS.Card, raw);
      return { parsed: { component: name, props }, bad: bad.length };
    }
    case "List": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS.List, raw);
      return { parsed: { component: name, props }, bad: bad.length };
    }
    case "Divider": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS.Divider, raw);
      return { parsed: { component: name, props }, bad: bad.length };
    }
    case "Text": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS.Text, raw);
      // `text` is required in use: without a usable one the component is a placeholder.
      if (props.text === undefined) return { parsed: { component: "unknown", name }, bad: Math.max(1, bad.length) };
      return { parsed: { component: name, props }, bad: bad.length };
    }
    case "Image": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS.Image, raw);
      // `src` is required in use: without one the image is a plain chip.
      return { parsed: { component: name, props }, bad: props.src === undefined ? Math.max(1, bad.length) : bad.length };
    }
    case "Icon": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS.Icon, raw);
      return { parsed: { component: name, props }, bad: props.name === undefined ? Math.max(1, bad.length) : bad.length };
    }
    case "Button": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS.Button, raw);
      if (props.label === undefined) return { parsed: { component: "unknown", name }, bad: Math.max(1, bad.length) };
      // `action` and `href` are mutually exclusive: both are dropped, and the button is inert.
      if (props.action !== undefined && props.href !== undefined) {
        const { action: _action, href: _href, ...rest } = props;
        return { parsed: { component: name, props: rest }, bad: bad.length + 1 };
      }
      return { parsed: { component: name, props }, bad: bad.length };
    }
    case "TextField": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS.TextField, raw);
      // `min`/`max` belong to a number input only.
      if (props.inputType !== "number" && (props.min !== undefined || props.max !== undefined)) {
        const { min: _min, max: _max, ...rest } = props;
        const dropped = (props.min !== undefined ? 1 : 0) + (props.max !== undefined ? 1 : 0);
        return { parsed: { component: name, props: rest }, bad: bad.length + dropped };
      }
      return { parsed: { component: name, props }, bad: bad.length };
    }
    case "CheckBox": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS.CheckBox, raw);
      return { parsed: { component: name, props }, bad: bad.length };
    }
    case "ChoicePicker": {
      const { props, bad } = lenientParse(A2UI_PROPS_SCHEMAS.ChoicePicker, raw);
      return { parsed: { component: name, props }, bad: bad.length };
    }
  }
}

type ComponentRead =
  | { kind: "entry"; entry: A2uiComponentEntry }
  | { kind: "bad-id"; interactive: boolean }
  | { kind: "fault"; reason: A2uiEnvelopeFault; path: string };

function readComponent(raw: JsonValue, at: string): ComponentRead {
  if (!isJsonObject(raw) || typeof raw["id"] !== "string" || typeof raw["component"] !== "string") {
    return { kind: "fault", reason: "bad-shape", path: at };
  }
  const { id, component: name, ...props } = raw;
  const interactive =
    (A2UI_INPUT_COMPONENTS as readonly string[]).includes(name) || (name === "Button" && Object.hasOwn(props, "action"));
  if (isA2uiComponentName(name)) {
    const envelope = componentEnvelopeFault(name, props, at);
    if (envelope !== null) return { kind: "fault", ...envelope };
  }
  if (!A2UI_ID_PATTERN.test(id)) return { kind: "bad-id", interactive };
  if (!isA2uiComponentName(name)) {
    const faults: { [K in A2uiComponentFault]?: number } = { "unknown-component": 1 };
    return { kind: "entry", entry: { id, name, interactive, parsed: { component: "unknown", name }, faults } };
  }
  const { parsed, bad } = parseProps(name, props);
  const faults: { [K in A2uiComponentFault]?: number } = bad > 0 ? { "bad-prop": bad } : {};
  return { kind: "entry", entry: { id, name, interactive, parsed, faults } };
}

type MessageRead = { kind: "message"; message: A2uiParsedMessage } | { kind: "fault"; reason: A2uiEnvelopeFault; path: string };

function readMessage(raw: JsonValue, at: string): MessageRead {
  if (!isJsonObject(raw)) return { kind: "fault", reason: "bad-shape", path: at };
  if (raw["version"] !== A2UI_VERSION) return { kind: "fault", reason: "bad-version", path: `${at}/version` };
  const keys = A2UI_MESSAGE_KEYS.filter((k) => Object.hasOwn(raw, k));
  const key = keys[0];
  if (key === undefined) return { kind: "fault", reason: "unrecognized-message", path: at };
  if (keys.length > 1) return { kind: "fault", reason: "bad-shape", path: at };
  const payload = raw[key];
  const here = `${at}/${key}`;
  if (!isJsonObject(payload)) return { kind: "fault", reason: "bad-shape", path: here };
  const surfaceId = payload["surfaceId"];
  if (!isId(surfaceId)) return { kind: "fault", reason: "bad-surface-id", path: `${here}/surfaceId` };
  switch (key) {
    case "createSurface": {
      const catalogId = payload["catalogId"];
      if (typeof catalogId !== "string" || catalogId === "") return { kind: "fault", reason: "bad-shape", path: `${here}/catalogId` };
      // `title` is guuey's superset field: a non-string one is ignored, as preview-a2ui strips it.
      const title = typeof payload["title"] === "string" ? payload["title"] : null;
      return { kind: "message", message: { kind: "createSurface", surfaceId, catalogId, title } };
    }
    case "updateComponents": {
      const list = payload["components"];
      if (!Array.isArray(list)) return { kind: "fault", reason: "bad-shape", path: `${here}/components` };
      const components: A2uiComponentEntry[] = [];
      const badIds = { count: 0, interactive: false };
      for (const [i, item] of list.entries()) {
        const read = readComponent(item, `${here}/components/${i}`);
        if (read.kind === "fault") return read;
        if (read.kind === "bad-id") {
          badIds.count += 1;
          badIds.interactive ||= read.interactive;
        } else {
          components.push(read.entry);
        }
      }
      return { kind: "message", message: { kind: "updateComponents", surfaceId, components, badIds } };
    }
    case "updateDataModel": {
      const value = payload["value"];
      if (value === undefined) return { kind: "fault", reason: "bad-shape", path: `${here}/value` };
      const path = payload["path"];
      if (path !== undefined && typeof path !== "string") return { kind: "fault", reason: "bad-path", path: `${here}/path` };
      const read = readA2uiDataPath(path ?? "");
      if ("fault" in read) return { kind: "fault", reason: read.fault === "too-deep" ? "path-too-deep" : "bad-path", path: `${here}/path` };
      // A write to the whole model replaces it with an object.
      if (read.segments.length === 0 && !isJsonObject(value)) return { kind: "fault", reason: "bad-shape", path: `${here}/value` };
      return { kind: "message", message: { kind: "updateDataModel", surfaceId, segments: read.segments, value } };
    }
    case "deleteSurface":
      return { kind: "message", message: { kind: "deleteSurface", surfaceId } };
  }
}

/**
 * The surface ids a carrier names, read leniently without judging anything
 * else: what a carrier that takes the old face closes (spec §5.7). Bounded,
 * so it holds for a carrier over the size bound too: only the first
 * `messagesPerCarrier` messages are read, and a surface named only after
 * them is not named.
 */
export function namedA2uiSurfaceIds(value: JsonValue): string[] {
  return isJsonObject(value) ? namedSurfaceIds(value["messages"], A2UI_LIMITS.messagesPerCarrier) : [];
}

/** The envelope stage: everything judged without a surface's state. */
export function parseA2uiCarrier(value: JsonValue): A2uiEnvelopeResult {
  const fail = (reason: A2uiEnvelopeFault, path: string, surfaceIds: string[] = []): A2uiEnvelopeResult => ({
    ok: false,
    reason,
    path,
    surfaceIds,
  });
  if (a2uiCarrierUnits(value) > A2UI_CARRIER_MAX_UNITS) return fail("too-large", "", namedA2uiSurfaceIds(value));
  if (!isJsonObject(value)) return fail("not-object", "");
  const named = namedSurfaceIds(value["messages"]);
  const format = value["format"];
  if (format !== undefined && format !== "a2ui") return fail("unsupported-format", "/format", named);
  if (value["version"] !== A2UI_VERSION) return fail("bad-version", "/version", named);
  const list = value["messages"];
  if (!Array.isArray(list) || list.length === 0) return fail("bad-shape", "/messages", named);
  if (list.length > A2UI_LIMITS.messagesPerCarrier) return fail("too-many-messages", "/messages", named);
  if (named.length > A2UI_LIMITS.surfacesPerCarrier) return fail("too-many-surfaces", "/messages", named);
  const messages: A2uiParsedMessage[] = [];
  for (const [i, raw] of list.entries()) {
    const read = readMessage(raw, `/messages/${i}`);
    if (read.kind === "fault") return fail(read.reason, read.path, named);
    messages.push(read.message);
  }
  return { ok: true, messages };
}

/** A carrier judged on a fold state: the envelope stage, then the messages applied (the class read on the resulting tree). */
export function foldA2uiCarrier(
  state: A2uiFoldState,
  value: JsonValue,
  media: A2uiMediaPolicy = DEFAULT_A2UI_MEDIA_POLICY,
): A2uiFoldResult {
  const envelope = parseA2uiCarrier(value);
  if (!envelope.ok) return { ...envelope, level: "envelope" };
  return applyA2uiMessages(state, envelope.messages, media);
}

/** A carrier judged on its own, as a producer checks what it emits. */
export function validateA2uiCarrier(value: JsonValue): A2uiValidation {
  const out = foldA2uiCarrier(EMPTY_A2UI_STATE, value);
  return out.ok ? { ok: true, surfaces: out.surfaces } : out;
}
