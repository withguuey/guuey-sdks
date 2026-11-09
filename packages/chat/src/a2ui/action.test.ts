/**
 * guuey#2384 — an A2UI action's payload, validated against the surface's
 * declared model before anything is sent (spec §9.2; S4 RED (c)).
 *
 * Each constraint blocks the send with an error on its field; a literal
 * `context` value is the agent's own constant and passes; a payload over the
 * bound is refused; a path no input declares is refused for the whole form.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { A2UI_ACTION_PAYLOAD_MAX_UNITS, a2uiActionPayload } from "@guuey/mcp-apps-host/narrowing";
import { checkA2uiAction, sendA2uiAction, type A2uiActionRequest } from "./action.js";
import type { A2uiAction, A2uiFieldSpec } from "./schema.js";
import { A2UI_LIMITS } from "./limits.js";

const text = (extra: Partial<Extract<A2uiFieldSpec, { kind: "text" }>> = {}): A2uiFieldSpec => ({
  kind: "text",
  componentId: "f",
  label: "Field",
  inputType: "text",
  required: false,
  maxLength: null,
  min: null,
  max: null,
  ...extra,
});
const check = (spec: A2uiFieldSpec, value: JsonValue | null, context: A2uiAction["context"] = { v: { path: "/v" } }) =>
  checkA2uiAction({ "/v": spec }, { name: "go", context }, (path) => (path === "/v" ? value : null));

describe("S4 (c) — each constraint blocks the send with a field error", () => {
  it("required: an empty or blank string, an unticked box and an empty choice are each a required error", () => {
    expect(check(text({ required: true }), "")).toEqual({ ok: false, fields: { "/v": { kind: "required" } }, form: null });
    expect(check(text({ required: true }), "   ")).toMatchObject({ fields: { "/v": { kind: "required" } } });
    expect(check(text({ required: true }), null)).toMatchObject({ fields: { "/v": { kind: "required" } } });
    const box: A2uiFieldSpec = { kind: "boolean", componentId: "b", label: "Agree", required: true };
    expect(check(box, false)).toMatchObject({ fields: { "/v": { kind: "required" } } });
    expect(check(box, true)).toEqual({ ok: true, context: { v: true } });
    const one: A2uiFieldSpec = { kind: "choice", componentId: "c", label: "Size", options: ["s", "m"], multiple: false, required: true };
    const many: A2uiFieldSpec = { ...one, multiple: true };
    expect(check(one, null)).toMatchObject({ fields: { "/v": { kind: "required" } } });
    expect(check(many, [])).toMatchObject({ fields: { "/v": { kind: "required" } } });
  });

  it("maxLength counts UTF-16 units", () => {
    expect(check(text({ maxLength: 3 }), "abc")).toEqual({ ok: true, context: { v: "abc" } });
    expect(check(text({ maxLength: 3 }), "abcd")).toMatchObject({ fields: { "/v": { kind: "too-long", max: 3 } } });
  });

  it("a number input gives a finite number, within min and max", () => {
    const n = text({ inputType: "number", min: 1, max: 12 });
    expect(check(n, "4")).toEqual({ ok: true, context: { v: 4 } });
    expect(check(n, 4)).toEqual({ ok: true, context: { v: 4 } });
    expect(check(n, "four")).toMatchObject({ fields: { "/v": { kind: "not-a-number" } } });
    expect(check(n, "Infinity")).toMatchObject({ fields: { "/v": { kind: "not-a-number" } } });
    expect(check(n, "0")).toMatchObject({ fields: { "/v": { kind: "too-small", min: 1 } } });
    expect(check(n, "13")).toMatchObject({ fields: { "/v": { kind: "too-large", max: 12 } } });
    expect(check(n, "")).toEqual({ ok: true, context: { v: null } });
  });

  it("an email input gives one @ with a dot after it; empty and optional passes", () => {
    const e = text({ inputType: "email" });
    expect(check(e, "ada@example.com")).toEqual({ ok: true, context: { v: "ada@example.com" } });
    expect(check(e, "ada@example")).toMatchObject({ fields: { "/v": { kind: "not-an-email" } } });
    expect(check(e, "a@b@c.d")).toMatchObject({ fields: { "/v": { kind: "not-an-email" } } });
    expect(check(e, "")).toEqual({ ok: true, context: { v: "" } });
  });

  it("a choice gives a member of its options; a multiple choice an array of distinct members", () => {
    const one: A2uiFieldSpec = { kind: "choice", componentId: "c", label: "Size", options: ["s", "m"], multiple: false, required: false };
    expect(check(one, "m")).toEqual({ ok: true, context: { v: "m" } });
    expect(check(one, "xl")).toMatchObject({ fields: { "/v": { kind: "not-an-option" } } });
    expect(check(one, null)).toEqual({ ok: true, context: { v: null } });
    const many: A2uiFieldSpec = { ...one, multiple: true };
    expect(check(many, ["s", "m"])).toEqual({ ok: true, context: { v: ["s", "m"] } });
    expect(check(many, ["s", "s"])).toMatchObject({ fields: { "/v": { kind: "not-an-option" } } });
    expect(check(many, ["s", "xl"])).toMatchObject({ fields: { "/v": { kind: "not-an-option" } } });
    expect(check(many, null)).toEqual({ ok: true, context: { v: [] } });
  });

  it("a value of the wrong kind for its input is refused, never coerced into another kind", () => {
    const box: A2uiFieldSpec = { kind: "boolean", componentId: "b", label: "Agree", required: false };
    expect(check(box, "yes")).toEqual({ ok: true, context: { v: false } });
    expect(check(text(), { nested: true })).toEqual({ ok: true, context: { v: "" } });
  });

  it("every failing field reports at once, so the form shows all its errors on one press", () => {
    const fields: { [path: string]: A2uiFieldSpec } = {
      "/a": text({ componentId: "a", required: true }),
      "/b": text({ componentId: "b", inputType: "number" }),
    };
    const out = checkA2uiAction(fields, { name: "go", context: { a: { path: "/a" }, b: { path: "/b" } } }, (p) => (p === "/b" ? "x" : null));
    expect(out).toEqual({ ok: false, fields: { "/a": { kind: "required" }, "/b": { kind: "not-a-number" } }, form: null });
  });
});

describe("S4 (c) — literals, undeclared paths and the payload bound", () => {
  it("a literal context value is the agent's constant and passes as declared", () => {
    const out = checkA2uiAction({}, { name: "go", context: { plan: "pro", seats: 3, trial: false, none: null } }, () => null);
    expect(out).toEqual({ ok: true, context: { plan: "pro", seats: 3, trial: false, none: null } });
  });

  it("an action with no context sends an empty object", () => {
    expect(checkA2uiAction({}, { name: "go" }, () => null)).toEqual({ ok: true, context: {} });
  });

  it("a path no input declares is refused for the whole form (it reads the model, not a field)", () => {
    const out = checkA2uiAction({}, { name: "go", context: { v: { path: "/status" } } }, () => "ok");
    expect(out).toEqual({ ok: false, fields: {}, form: "undeclared" });
  });

  it(`a payload of ${A2UI_LIMITS.actionPayloadUnits} units of escaped JSON is sent; one unit more is refused`, () => {
    expect(A2UI_LIMITS.actionPayloadUnits).toBe(A2UI_ACTION_PAYLOAD_MAX_UNITS);
    // Each "<" weighs six units escaped: the bound is judged on the escaped line, not the raw value.
    const at = "<".repeat(680) + "x".repeat(A2UI_LIMITS.actionPayloadUnits - a2uiActionPayload({ v: "" }).length - 680 * 6);
    expect(a2uiActionPayload({ v: at })).toHaveLength(A2UI_LIMITS.actionPayloadUnits);
    expect(check(text(), at)).toEqual({ ok: true, context: { v: at } });
    expect(check(text(), `${at}e`)).toEqual({ ok: false, fields: {}, form: "too-large" });
  });
});

describe("review r1 — the validator reads values the way the field shows them", () => {
  it("a number is the HTML valid floating-point number, never what Number() also accepts", () => {
    const n = text({ inputType: "number" });
    for (const ok of ["7", "-7", "0.5", ".5", "1e3", "-2.5E-3"]) expect(check(n, ok), ok).toEqual({ ok: true, context: { v: Number(ok) } });
    for (const bad of ["0x10", "0b11", "0o7", "+5", " 1e3 ", "1.", "1,000", "1e"]) {
      expect(check(n, bad), bad).toMatchObject({ ok: false, fields: { "/v": { kind: "not-a-number" } } });
    }
  });

  it('a declared "" option is a selection: it passes required and is sent as ""', () => {
    const one: A2uiFieldSpec = { kind: "choice", componentId: "c", label: "Pref", options: ["", "window"], multiple: false, required: true };
    expect(check(one, "")).toEqual({ ok: true, context: { v: "" } });
    expect(check({ ...one, required: false }, "")).toEqual({ ok: true, context: { v: "" } });
    // Without a "" option, "" is still no selection.
    expect(check({ ...one, options: ["window"] }, "")).toMatchObject({ fields: { "/v": { kind: "required" } } });
  });

  it("a single choice holding several values is refused (the user chooses one), never cut to its first", () => {
    const one: A2uiFieldSpec = { kind: "choice", componentId: "c", label: "Size", options: ["a", "b"], multiple: false, required: false };
    expect(check(one, ["a", "b"])).toMatchObject({ ok: false, fields: { "/v": { kind: "not-an-option" } } });
  });
});

describe("review r2 — a field the browser could not read is not a number, whatever declared its path", () => {
  it("an unreadable path is not-a-number for a text field too, and nothing stands in for its value", () => {
    const fields = { "/v": text() };
    const out = checkA2uiAction(fields, { name: "go", context: { v: { path: "/v" } } }, () => "typed", new Set(["/v"]));
    expect(out).toEqual({ ok: false, fields: { "/v": { kind: "not-a-number" } }, form: null });
  });
});

describe("sendA2uiAction — the one press rule behind a surface's composer gate (guuey#2386)", () => {
  const request: A2uiActionRequest = { surfaceId: "order", name: "submit", sourceComponentId: "go", context: { n: 1 }, summary: { label: "Go", pairs: [] } };
  function sender() {
    const sent: Array<{ text: string; clientMessageId: string }> = [];
    return { sent, newClientMessageId: () => "cm_9", send: async (text: string, o: { clientMessageId: string }) => void sent.push({ text, ...o }) };
  }

  it("closed, then busy, refuse before anything is minted or sent", () => {
    const s = sender();
    expect(sendA2uiAction({ closed: true, busy: true }, s, request)).toBe("closed");
    expect(sendA2uiAction({ closed: false, busy: true }, s, request)).toBe("busy");
    expect(s.sent).toEqual([]);
  });

  it("an open gate sends the action text under the minted id, as the turn's clientMessageId", () => {
    const s = sender();
    expect(sendA2uiAction({ closed: false, busy: false }, s, request)).toBe("sent");
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.clientMessageId).toBe("cm_9");
    expect(s.sent[0]?.text).toContain('id="cm_9"');
  });

  it("a record the writer refuses is refused, and nothing is sent", () => {
    const s = sender();
    expect(sendA2uiAction({ closed: false, busy: false }, s, { ...request, name: "no spaces allowed" })).toBe("refused");
    expect(s.sent).toEqual([]);
  });
});
