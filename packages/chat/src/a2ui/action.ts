/**
 * An A2UI action's payload, resolved and validated against the surface's
 * declared model before anything is sent (guuey#2384, spec §5.5, §9.2).
 *
 * Platform-neutral: the web and native kits both press through it, so a form
 * refuses the same values on every surface. The pod does not re-validate in
 * V1: a submitted value has exactly the trust of typed text, and the agent's
 * tools stay the authority over it.
 */
import type { JsonValue } from "@silverprotocol/core";
import { a2uiActionPayload, writeA2uiActionText, type A2uiActionSummary } from "@guuey/mcp-apps-host/narrowing";
import { A2UI_LIMITS } from "./limits.js";
import { isA2uiPathBinding, type A2uiAction, type A2uiFieldSpec } from "./schema.js";

/** Why one field's value cannot be sent. */
export type A2uiFieldError =
  | { kind: "required" }
  | { kind: "too-long"; max: number }
  | { kind: "not-a-number" }
  | { kind: "too-small"; min: number }
  | { kind: "too-large"; max: number }
  | { kind: "not-an-email" }
  | { kind: "not-an-option" };

/**
 * The action's verdict: the resolved `context` to send, or what blocks it.
 * `fields` names each failing data path; `form` is a fault of the whole
 * action: a `{path}` no input declares (the agent's own fault, nothing the
 * user can fix), or a payload over {@link A2UI_LIMITS.actionPayloadUnits}.
 */
export type A2uiActionCheck =
  | { ok: true; context: { [key: string]: JsonValue } }
  | { ok: false; fields: { [path: string]: A2uiFieldError }; form: "undeclared" | "too-large" | null };

/** One `@` with a dot after it, nothing blank around them. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A model value as an input's text: strings, numbers and booleans; anything else is empty (the renderer draws fields by it too). */
export function asText(value: JsonValue | null): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** One declared field's value, resolved to what it sends, or its error. */
function resolveField(spec: A2uiFieldSpec, value: JsonValue | null): { value: JsonValue } | { error: A2uiFieldError } {
  switch (spec.kind) {
    case "boolean": {
      const checked = value === true;
      return spec.required && !checked ? { error: { kind: "required" } } : { value: checked };
    }
    case "choice": {
      const chosen = typeof value === "string" ? (value === "" ? [] : [value]) : Array.isArray(value) ? value : [];
      if (!chosen.every((v): v is string => typeof v === "string" && spec.options.includes(v))) return { error: { kind: "not-an-option" } };
      if (new Set(chosen).size !== chosen.length) return { error: { kind: "not-an-option" } };
      if (spec.required && chosen.length === 0) return { error: { kind: "required" } };
      return { value: spec.multiple ? chosen : (chosen[0] ?? null) };
    }
    case "text": {
      const raw = asText(value);
      if (raw.trim() === "") {
        if (spec.required) return { error: { kind: "required" } };
        return { value: spec.inputType === "number" ? null : raw };
      }
      if (spec.inputType === "number") {
        const n = typeof value === "number" ? value : Number(raw);
        if (!Number.isFinite(n)) return { error: { kind: "not-a-number" } };
        if (spec.min !== null && n < spec.min) return { error: { kind: "too-small", min: spec.min } };
        if (spec.max !== null && n > spec.max) return { error: { kind: "too-large", max: spec.max } };
        return { value: n };
      }
      if (spec.maxLength !== null && raw.length > spec.maxLength) return { error: { kind: "too-long", max: spec.maxLength } };
      if (spec.inputType === "email" && !EMAIL.test(raw)) return { error: { kind: "not-an-email" } };
      return { value: raw };
    }
  }
}

/**
 * Resolve an action's `context` (spec §5.5) and validate it (§9.2): a literal
 * stays as is; a `{path}` is read through `read` (the surface's local edits
 * over its server model) and must be declared by an input on the surface,
 * whose kind and constraints the value must meet. Every field is judged, so
 * one press shows every error. The escaped payload must fit its bound.
 */
export function checkA2uiAction(
  fields: { readonly [path: string]: A2uiFieldSpec },
  action: A2uiAction,
  read: (path: string) => JsonValue | null,
): A2uiActionCheck {
  const context: { [key: string]: JsonValue } = {};
  const errors: { [path: string]: A2uiFieldError } = {};
  for (const [key, bound] of Object.entries(action.context ?? {})) {
    if (!isA2uiPathBinding(bound)) {
      context[key] = bound;
      continue;
    }
    const spec = Object.hasOwn(fields, bound.path) ? fields[bound.path] : undefined;
    if (spec === undefined) return { ok: false, fields: {}, form: "undeclared" };
    const out = resolveField(spec, read(bound.path));
    if ("error" in out) errors[bound.path] = out.error;
    else context[key] = out.value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, fields: errors, form: null };
  if (a2uiActionPayload(context).length > A2UI_LIMITS.actionPayloadUnits) return { ok: false, fields: {}, form: "too-large" };
  return { ok: true, context };
}

/**
 * A pressed action as a kit hands it to the host's send path (spec §9.1): the
 * resolved record (§5.5) without its id, which the send mints as the turn's
 * `clientMessageId`, and the words of the turn's human line.
 */
export interface A2uiActionRequest {
  surfaceId: string;
  name: string;
  sourceComponentId: string;
  context: { [key: string]: JsonValue };
  summary: A2uiActionSummary;
}

/**
 * What the host's send path did with a press: `sent`, the turn went out;
 * `busy`, a turn is live or the chat cannot send (nothing went out, the
 * surface says to wait); `refused`, the action's text could not be written.
 */
export type A2uiActionOutcome = "sent" | "busy" | "refused";

/** The action turn's text for a press, under the id its send carries; `undefined` when the writer refuses it. */
export function a2uiActionTurnText(request: A2uiActionRequest, actionId: string): string | undefined {
  const { summary, ...record } = request;
  return writeA2uiActionText({ ...record, actionId }, summary);
}
