/**
 * guuey#2031 — the tap-label contract: the producer normalizer, the writer's
 * bounds (per entry AND in total), the reader's shape-only rule, and the one
 * directive predicate the planner and the runtime share.
 */
import { describe, expect, it } from "vitest";
import {
  isViewDirectiveText,
  MAX_TAP_LABEL_UNITS,
  MAX_TAP_LABELS,
  MAX_TAP_LABELS_BYTES,
  MAX_TAP_LABELS_READ,
  readTapLabels,
  tapText,
  writeTapLabels,
} from "./tap-labels.js";
import { SYNTHETIC_DIRECTIVE } from "./fixtures/card-tap.synthetic.js";

/** Bidi formatting characters, built from code points so this source carries none of them. */
const ALM = String.fromCodePoint(0x061c);
const LRI = String.fromCodePoint(0x2066);
const LRM = String.fromCodePoint(0x200e);
const PDI = String.fromCodePoint(0x2069);
const RLO = String.fromCodePoint(0x202e);

describe("tapText — verbatim or nothing", () => {
  it("collapses whitespace runs to one space and trims", () => {
    expect(tapText("  Recommend \n me\t a  mystery novel ")).toBe("Recommend me a mystery novel");
  });

  it("keeps a label of exactly the bound and refuses one unit over — never truncated", () => {
    const atBound = "a".repeat(MAX_TAP_LABEL_UNITS);
    expect(tapText(atBound)).toBe(atBound);
    expect(tapText(`${atBound}b`)).toBeNull();
  });

  it("counts UTF-16 units: an astral character is two", () => {
    const astral = "\u{1F4DA}"; // a two-unit emoji
    expect(tapText(astral.repeat(MAX_TAP_LABEL_UNITS / 2))).not.toBeNull();
    expect(tapText(`${astral.repeat(MAX_TAP_LABEL_UNITS / 2)}x`)).toBeNull();
  });

  it("refuses control and bidi formatting characters", () => {
    expect(tapText(`Open ${RLO}secret`)).toBeNull(); // RIGHT-TO-LEFT OVERRIDE
    expect(tapText("Ring \u0007 bell")).toBeNull(); // BEL (C0)
    expect(tapText("Next \u0085 line")).toBeNull(); // NEL (C1, not JS whitespace)
    expect(tapText(`left ${LRM} mark`)).toBeNull(); // LRM
    expect(tapText(`${LRI}isolate${PDI}`)).toBeNull(); // LRI … PDI
    expect(tapText(`arabic ${ALM} mark`)).toBeNull(); // ALM
  });

  it("is null for empty or whitespace-only text", () => {
    expect(tapText("")).toBeNull();
    expect(tapText(" \n\t ")).toBeNull();
  });
});

describe("writeTapLabels — the writer contract, all or nothing", () => {
  it("keeps a valid list, nulls in their positions, as a fresh copy", () => {
    const raw = ["Recommend me a mystery novel", null];
    const out = writeTapLabels(raw);
    expect(out).toEqual(["Recommend me a mystery novel", null]);
    raw[0] = "changed";
    expect(out?.[0]).toBe("Recommend me a mystery novel");
  });

  it("drops a list with more than the entry bound, and keeps one at it", () => {
    expect(writeTapLabels(Array.from({ length: MAX_TAP_LABELS }, (_, i) => `Chip ${i}`))).toHaveLength(MAX_TAP_LABELS);
    expect(writeTapLabels(Array.from({ length: MAX_TAP_LABELS + 1 }, (_, i) => `Chip ${i}`))).toBeUndefined();
  });

  it("drops an all-null list, an empty list, and anything that is not an array", () => {
    expect(writeTapLabels([null, null])).toBeUndefined();
    expect(writeTapLabels([])).toBeUndefined();
    expect(writeTapLabels("Recommend me a mystery novel")).toBeUndefined();
    expect(writeTapLabels({ 0: "a" })).toBeUndefined();
    expect(writeTapLabels(undefined)).toBeUndefined();
  });

  it("drops the WHOLE list when one entry is not what tapText would produce", () => {
    expect(writeTapLabels(["ok", "  padded"])).toBeUndefined();
    expect(writeTapLabels(["ok", "a".repeat(MAX_TAP_LABEL_UNITS + 1)])).toBeUndefined();
    expect(writeTapLabels(["ok", `bidi ${RLO}`])).toBeUndefined();
    expect(writeTapLabels(["ok", ""])).toBeUndefined();
    expect(writeTapLabels(["ok", 5])).toBeUndefined();
  });

  it("holds the TOTAL cap: 1 KB of UTF-8 JSON across all entries, on top of the per-entry bound", () => {
    // Five maximal ASCII labels: 5 × 200 bytes + 5 × 2 quotes + 4 commas + 2 brackets = 1016 bytes.
    const five = Array.from({ length: 5 }, (_, i) => `${i}`.padEnd(MAX_TAP_LABEL_UNITS, "x"));
    expect(new TextEncoder().encode(JSON.stringify(five)).length).toBe(1016);
    expect(writeTapLabels(five)).toHaveLength(5);
    // A sixth maximal label is within the entry bound and every per-entry bound, and still over the total.
    const six = [...five, "5".padEnd(MAX_TAP_LABEL_UNITS, "x")];
    expect(new TextEncoder().encode(JSON.stringify(six)).length).toBeGreaterThan(MAX_TAP_LABELS_BYTES);
    expect(writeTapLabels(six)).toBeUndefined();
  });

  it("measures the total in UTF-8 bytes, not UTF-16 units", () => {
    // 200 two-byte characters per label: 200 units (within the entry bound), 402 bytes as a JSON string.
    const wide = "é".repeat(MAX_TAP_LABEL_UNITS);
    expect(writeTapLabels([wide, wide])).toHaveLength(2);
    expect(writeTapLabels([wide, wide, wide])).toBeUndefined();
  });

  it("never throws, whatever it is handed", () => {
    const hostile: unknown[] = [null, 1, {}, [[]], [{ toString: () => "x" }], [Symbol.iterator], Number.NaN];
    for (const raw of hostile) expect(() => writeTapLabels(raw)).not.toThrow();
  });
});

describe("readTapLabels — the reader contract, shape only", () => {
  it("KEEPS what a later writer might loosen: a 300-unit label and twelve entries", () => {
    const long = "a".repeat(300);
    expect(readTapLabels([long])).toEqual([long]);
    const twelve = Array.from({ length: 12 }, (_, i) => `Chip ${i}`);
    expect(readTapLabels(twelve)).toEqual(twelve);
  });

  it("keeps nulls in their positions", () => {
    expect(readTapLabels([null, "Opening hours", null])).toEqual([null, "Opening hours", null]);
  });

  it("reads a label holding a control or bidi formatting character as no words: null in its position", () => {
    expect(readTapLabels([`Open ${RLO}me`, "Opening hours"])).toEqual([null, "Opening hours"]);
    expect(readTapLabels(["Opening hours", "Ring \u0007 bell", `${LRI}isolate${PDI}`])).toEqual(["Opening hours", null, null]);
    expect(readTapLabels(["two\nlines", "Opening hours"])).toEqual([null, "Opening hours"]);
    // Every entry refused: nothing left to draw.
    expect(readTapLabels([`${ALM}`, `${LRM}x`])).toBeUndefined();
  });

  it("caps the count well above the writer's bound: at the cap it reads, one over it is undefined", () => {
    expect(MAX_TAP_LABELS_READ).toBeGreaterThan(MAX_TAP_LABELS);
    const atCap = Array.from({ length: MAX_TAP_LABELS_READ }, (_, i) => `Chip ${i}`);
    expect(readTapLabels(atCap)).toHaveLength(MAX_TAP_LABELS_READ);
    expect(readTapLabels([...atCap, "one more"])).toBeUndefined();
  });

  it("is undefined for a non-array, an empty list, an empty label, an all-null list, or a non-string entry", () => {
    expect(readTapLabels("Opening hours")).toBeUndefined();
    expect(readTapLabels([])).toBeUndefined();
    expect(readTapLabels([""])).toBeUndefined();
    expect(readTapLabels([null])).toBeUndefined();
    expect(readTapLabels(["ok", 3])).toBeUndefined();
    expect(readTapLabels(null)).toBeUndefined();
  });
});

describe("isViewDirectiveText — the one predicate", () => {
  it("is true for ggui's doorbell text (a synthetic copy of the runtime's construction)", () => {
    expect(isViewDirectiveText(SYNTHETIC_DIRECTIVE)).toBe(true);
  });

  it("is anchored to the doorbell's own form, never its inner shape: a block whose kind or inner lines changed still counts", () => {
    expect(isViewDirectiveText(["Prose.", "", '<ggui_directive kind="something-new">', "  <anything/>", "</ggui_directive>", ""].join("\n"))).toBe(true);
    expect(isViewDirectiveText(["<ggui_directive>", "</ggui_directive>"].join("\n"))).toBe(true);
    expect(isViewDirectiveText(['<ggui_directive kind="user-action">', "x", "</ggui_directive>"].join("\r\n"))).toBe(true);
  });

  it("is false for text that only mentions the tag: inline, unclosed, or out of order", () => {
    expect(isViewDirectiveText('<ggui_directive kind="user-action">x</ggui_directive>')).toBe(false);
    expect(isViewDirectiveText("I saw <ggui_directive in the logs, what is it?")).toBe(false);
    expect(isViewDirectiveText(['<ggui_directive kind="user-action">', "  <session_id>s</session_id>"].join("\n"))).toBe(false);
    expect(isViewDirectiveText(["</ggui_directive>", '<ggui_directive kind="user-action">'].join("\n"))).toBe(false);
    expect(isViewDirectiveText(['say <ggui_directive kind="user-action">', "</ggui_directive>"].join("\n"))).toBe(false);
  });

  it("is false for typed text", () => {
    expect(isViewDirectiveText("What are your opening hours?")).toBe(false);
    expect(isViewDirectiveText("I typed ggui_directive without the angle bracket")).toBe(false);
  });
});
