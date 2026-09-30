/**
 * guuey#2031 — the ONE paint reducer: which props a card's render session
 * paints last, read the same way off the live fold (typed blocks) and off a
 * thread's stored rows (JSON). The parity cases are the proof there is one
 * derivation, not two.
 */
import { describe, expect, it } from "vitest";
import type { AgMessage } from "@silverprotocol/core";
import { latestPaintProps, paintPartsOfStored, quickReplyLabel, type PaintPart } from "./paint-props.js";
import {
  CHIP_EVENTS,
  CHIP_FIND,
  CHIP_HOURS,
  GREETING_PROPS,
  greetingFold,
  repaintFold,
  storedRowsOf,
  SYNTHETIC_SESSION,
} from "./fixtures/card-tap.synthetic.js";

const NEW_PROPS = { heading: "Amended", message: "Still here.", quickReplies: [{ id: "x1", label: "X one" }, { id: "x2", label: "X two" }] };

/** The fold path: the live fold's messages, their blocks in order. */
function foldParts(messages: readonly AgMessage[]): readonly PaintPart[] {
  return messages.flatMap((m) => m.content);
}

/** The stored path: rows read back as JSON, flattened through the stored-content narrower. */
function storedParts(messages: readonly AgMessage[]): readonly PaintPart[] {
  return storedRowsOf(messages).flatMap((row) => paintPartsOfStored(row.content));
}

/** Both paths must agree on every case: that is the parity. */
function both(messages: readonly AgMessage[], sessionId = SYNTHETIC_SESSION) {
  const fromFold = latestPaintProps(foldParts(messages), sessionId);
  const fromStored = latestPaintProps(storedParts(messages), sessionId);
  expect(fromStored).toEqual(fromFold);
  return fromFold;
}

describe("latestPaintProps — parity: the fold path and the stored path are one derivation", () => {
  it("a greeting render: its props, and a chip id resolves to the chip's label on both paths", () => {
    const paint = both(greetingFold());
    expect(paint?.paint).toBe("render");
    expect(paint?.props).toEqual(GREETING_PROPS);
    expect(quickReplyLabel(paint?.props, CHIP_FIND.id)).toBe(CHIP_FIND.label);
    expect(quickReplyLabel(paint?.props, CHIP_HOURS.id)).toBe(CHIP_HOURS.label);
  });

  it("a replace amend after the render: the latest paint wins", () => {
    const paint = both([
      ...greetingFold(),
      ...repaintFold("ggui_amend", "toolu_amend_1", { sessionId: SYNTHETIC_SESSION, kind: "replace", props: NEW_PROPS }),
    ]);
    expect(paint?.paint).toBe("amend");
    expect(quickReplyLabel(paint?.props, "x2")).toBe("X two");
    expect(quickReplyLabel(paint?.props, CHIP_FIND.id)).toBeNull();
  });

  it("a merge amend without quickReplies keeps the render's list and merges the rest", () => {
    const paint = both([
      ...greetingFold(),
      ...repaintFold("ggui_amend", "toolu_amend_2", { sessionId: SYNTHETIC_SESSION, kind: "merge", patch: { heading: "Merged" } }),
    ]);
    expect(paint?.paint).toBe("amend");
    expect(paint?.props).toEqual({ ...GREETING_PROPS, heading: "Merged" });
    expect(quickReplyLabel(paint?.props, CHIP_EVENTS.id)).toBe(CHIP_EVENTS.label);
  });

  it("a merge amend is an RFC 7396 merge patch: a null member deletes its key, nested objects merge, arrays replace", () => {
    const themed = { ...GREETING_PROPS, theme: { accent: "red", density: "compact" } };
    const paint = both([
      ...greetingFold(themed),
      ...repaintFold("ggui_amend", "toolu_amend_7396", {
        sessionId: SYNTHETIC_SESSION,
        kind: "merge",
        patch: { theme: { accent: "blue" }, message: null, quickReplies: [{ id: "x1", label: "X one" }] },
      }),
    ]);
    expect(paint?.props).toEqual({
      heading: GREETING_PROPS.heading,
      theme: { accent: "blue", density: "compact" },
      quickReplies: [{ id: "x1", label: "X one" }],
    });
    expect(paint?.props).not.toHaveProperty("message");
    expect(quickReplyLabel(paint?.props, "x1")).toBe("X one");
    expect(quickReplyLabel(paint?.props, CHIP_FIND.id)).toBeNull();
  });

  it("a merge that nulls quickReplies deletes the list: no reply resolves", () => {
    const paint = both([
      ...greetingFold(),
      ...repaintFold("ggui_amend", "toolu_amend_null", { sessionId: SYNTHETIC_SESSION, kind: "merge", patch: { quickReplies: null } }),
    ]);
    expect(paint?.props).not.toHaveProperty("quickReplies");
    expect(quickReplyLabel(paint?.props, CHIP_FIND.id)).toBeNull();
  });

  it("a merge patch's __proto__ member stays an own data member (never the props' prototype)", () => {
    const patch: unknown = JSON.parse('{"__proto__":{"quickReplies":[{"id":"p","label":"Not on the card"}]}}');
    const parts: PaintPart[] = [
      ...foldParts(greetingFold({ heading: "No replies" })),
      { type: "tool-call", toolCallId: "toolu_proto", name: "mcp__ggui__ggui_amend", input: { sessionId: SYNTHETIC_SESSION, kind: "merge", patch } },
      { type: "tool-result", toolCallId: "toolu_proto", outcome: "ok" },
    ];
    const paint = latestPaintProps(parts, SYNTHETIC_SESSION);
    expect(paint?.paint).toBe("amend");
    expect(Object.getPrototypeOf(paint?.props)).toBe(Object.prototype);
    expect(quickReplyLabel(paint?.props, "p")).toBeNull();
  });

  it("a ggui_update of the same session repaints it", () => {
    const paint = both([
      ...greetingFold(),
      ...repaintFold("ggui_update", "toolu_update_1", { sessionId: SYNTHETIC_SESSION, kind: "replace", props: NEW_PROPS }),
    ]);
    expect(paint?.paint).toBe("update");
    expect(quickReplyLabel(paint?.props, "x1")).toBe("X one");
  });

  it("a repaint that did not complete ok (isError, or denied) is no paint: the render still stands", () => {
    for (const outcome of ["error", "denied"] as const) {
      const paint = both([
        ...greetingFold(),
        ...repaintFold("ggui_amend", `toolu_amend_${outcome}`, { sessionId: SYNTHETIC_SESSION, kind: "replace", props: NEW_PROPS }, outcome),
      ]);
      expect(paint?.paint).toBe("render");
      expect(quickReplyLabel(paint?.props, CHIP_FIND.id)).toBe(CHIP_FIND.label);
    }
  });

  it("an amend of ANOTHER session is not a paint of this one; an unknown session is undefined", () => {
    const messages = [
      ...greetingFold(),
      ...repaintFold("ggui_amend", "toolu_amend_3", { sessionId: "render_other", kind: "replace", props: NEW_PROPS }),
    ];
    expect(both(messages)?.paint).toBe("render");
    expect(both(messages, "render_not-this-one")).toBeUndefined();
  });

  it("a render whose result failed never opens the session", () => {
    expect(both(greetingFold(GREETING_PROPS, "error"))).toBeUndefined();
  });
});

describe("latestPaintProps — a mounted card's own props as the base (the history-card path)", () => {
  it("with no paint of the session in the fold, the base alone is the card", () => {
    const paint = latestPaintProps([], SYNTHETIC_SESSION, GREETING_PROPS);
    expect(paint).toEqual({ props: GREETING_PROPS, paint: null, renderCallId: null });
    expect(quickReplyLabel(paint?.props, CHIP_HOURS.id)).toBe(CHIP_HOURS.label);
  });

  it("the fold's repaints of that session layer on top of the base", () => {
    const parts = foldParts(repaintFold("ggui_amend", "toolu_amend_4", { sessionId: SYNTHETIC_SESSION, kind: "replace", props: NEW_PROPS }));
    const paint = latestPaintProps(parts, SYNTHETIC_SESSION, GREETING_PROPS);
    expect(paint?.paint).toBe("amend");
    expect(quickReplyLabel(paint?.props, "x1")).toBe("X one");
  });

  it("with a base, a render in the fold is not re-applied (the base is the document the card paints)", () => {
    const base = { ...GREETING_PROPS, heading: "As the mounted document says" };
    const paint = latestPaintProps(foldParts(greetingFold()), SYNTHETIC_SESSION, base);
    expect(paint?.props).toEqual(base);
    expect(paint?.paint).toBeNull();
  });
});

describe("quickReplyLabel — the strict quickReplies[{id,label}] convention", () => {
  it("reads only well-formed entries of `quickReplies`", () => {
    const props = { quickReplies: [{ id: "a", label: 3 }, "b", { id: "c", label: "Chip C" }], items: [{ id: "d", label: "Not a quick reply" }] };
    expect(quickReplyLabel(props, "a")).toBeNull();
    expect(quickReplyLabel(props, "c")).toBe("Chip C");
    // Not widened to any props object carrying an id and a label.
    expect(quickReplyLabel(props, "d")).toBeNull();
  });

  it("is null for an id two replies share: an ambiguous tap names no words", () => {
    const props = { quickReplies: [{ id: "dup", label: "First" }, { id: "dup", label: "Second" }, { id: "one", label: "Only" }] };
    expect(quickReplyLabel(props, "dup")).toBeNull();
    expect(quickReplyLabel(props, "one")).toBe("Only");
    // A malformed entry sharing the id still makes the id ambiguous.
    expect(quickReplyLabel({ quickReplies: [{ id: "dup", label: "Only well-formed one" }, { id: "dup" }] }, "dup")).toBeNull();
  });

  it("is null without props, without the list, or with no match", () => {
    expect(quickReplyLabel(undefined, "a")).toBeNull();
    expect(quickReplyLabel({ heading: "x" }, "a")).toBeNull();
    expect(quickReplyLabel(GREETING_PROPS, "nope")).toBeNull();
  });
});

describe("paintPartsOfStored — the stored-content narrower", () => {
  it("reads a stored message's parts, objects only, and nothing from anything else", () => {
    expect(paintPartsOfStored({ content: [{ type: "tool-call", toolCallId: "c" }, "junk", null] })).toEqual([{ type: "tool-call", toolCallId: "c" }]);
    expect(paintPartsOfStored({ kind: "text", text: "Hi!" })).toEqual([]);
    expect(paintPartsOfStored("Hi!")).toEqual([]);
    expect(paintPartsOfStored(null)).toEqual([]);
  });
});
