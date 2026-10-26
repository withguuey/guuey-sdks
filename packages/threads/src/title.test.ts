/**
 * Thread titles (guuey#2612): the ONE reader every surface reads a
 * stored title through, and the bound constants the titler and every binding
 * share. Pure: no store here (the write semantics are the port contract
 * suite's, `testing/contract-suite.ts`; the one store door is
 * `title.store.test.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THREAD_TITLE,
  readThreadTitle,
  readThreadTitleSource,
  THREAD_TITLE_USAGE_REASON,
  TITLE_CHECKPOINTS,
  TITLE_MAX_ATTEMPTS,
  TITLE_MAX_GENERATIONS,
  type TitleSlice,
} from "./title.js";

const AT = "2026-10-27T00:00:00.000Z";

describe("readThreadTitleSource", () => {
  it.each([
    ["absent (every row written before titles)", undefined, "default"],
    ["null", null, "default"],
    ["'default'", "default", "default"],
    ["'generated'", "generated", "generated"],
    ["'set'", "set", "set"],
    ["an unknown value a later writer added", "imported", "default"],
    ["a non-string", 3, "default"],
  ])("%s reads as %s", (_label, stored, expected) => {
    expect(readThreadTitleSource(stored)).toBe(expected);
  });
});

describe("readThreadTitle", () => {
  const sealed = [{ fromSeq: 3, toSeq: 4 }];
  const cases: ReadonlyArray<{
    label: string;
    row: TitleSlice;
    owner: { title: string | null; source: string };
    operator: { title: string | null; source: string };
  }> = [
    {
      label: "a legacy row (no titleSource): default, and the English constant is never sent",
      row: { title: DEFAULT_THREAD_TITLE },
      owner: { title: null, source: "default" },
      operator: { title: null, source: "default" },
    },
    {
      label: "an unknown titleSource reads as default",
      row: { title: "Whatever it says", titleSource: "imported" },
      owner: { title: null, source: "default" },
      operator: { title: null, source: "default" },
    },
    {
      label: "a generated title",
      row: { title: "Trip to Busan", titleSource: "generated", titleUpdatedAt: AT },
      owner: { title: "Trip to Busan", source: "generated" },
      operator: { title: "Trip to Busan", source: "generated" },
    },
    {
      label: "a set title",
      row: { title: "Mine", titleSource: "set", titleUpdatedAt: AT },
      owner: { title: "Mine", source: "set" },
      operator: { title: "Mine", source: "set" },
    },
    {
      label: "a generated title on a thread with a sealed part: the operator gets null",
      row: { title: "Trip to Busan", titleSource: "generated", titleUpdatedAt: AT, sealIntervals: sealed },
      owner: { title: "Trip to Busan", source: "generated" },
      operator: { title: null, source: "generated" },
    },
    {
      label: "a set title on a thread with a sealed part: the operator gets null",
      row: { title: "Mine", titleSource: "set", titleUpdatedAt: AT, sealIntervals: sealed },
      owner: { title: "Mine", source: "set" },
      operator: { title: null, source: "set" },
    },
    {
      label: "an unreadable seal record fails closed for the operator",
      row: { title: "Mine", titleSource: "set", sealIntervals: "1-4" },
      owner: { title: "Mine", source: "set" },
      operator: { title: null, source: "set" },
    },
    {
      label: "an empty seal list is no sealed part",
      row: { title: "Mine", titleSource: "set", sealIntervals: [] },
      owner: { title: "Mine", source: "set" },
      operator: { title: "Mine", source: "set" },
    },
    {
      label: "a non-string stored title reads as null",
      row: { title: 7, titleSource: "generated" },
      owner: { title: null, source: "generated" },
      operator: { title: null, source: "generated" },
    },
  ];

  it.each(cases)("$label", ({ row, owner, operator }) => {
    expect(readThreadTitle(row, "owner")).toMatchObject(owner);
    expect(readThreadTitle(row, "operator")).toMatchObject(operator);
  });

  it("carries titleUpdatedAt when it is a string, else null", () => {
    expect(readThreadTitle({ title: "Mine", titleSource: "set", titleUpdatedAt: AT }, "owner").updatedAt).toBe(AT);
    expect(readThreadTitle({ title: "Mine", titleSource: "set" }, "owner").updatedAt).toBeNull();
    expect(readThreadTitle({ title: "Mine", titleSource: "set", titleUpdatedAt: 5 }, "owner").updatedAt).toBeNull();
  });
});

describe("the title bounds and labels", () => {
  it("pins the per-thread bounds and the checkpoints", () => {
    expect(TITLE_MAX_ATTEMPTS).toBe(6);
    expect(TITLE_MAX_GENERATIONS).toBe(3);
    expect(TITLE_CHECKPOINTS).toEqual([2, 8, 20, 50]);
  });

  it("names the spend label a titling call will carry (the spend itself is the titler's)", () => {
    expect(THREAD_TITLE_USAGE_REASON).toBe("thread-title");
  });

  it("keeps the default title constant the store mints threads with", () => {
    expect(DEFAULT_THREAD_TITLE).toBe("New thread");
  });
});
