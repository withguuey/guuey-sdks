import { describe, expect, it } from "vitest";
import { DYNAMODB_ITEM_LIMIT_BYTES, DYNAMODB_ROW_BUDGET, DYNAMODB_ROW_BUDGET_BYTES, dynamoItemBytes, dynamoNumberFits } from "./item-size.js";
import type { ThreadMessageRow } from "./rows.js";

/**
 * Hand-computed sizes under DynamoDB's published item-size rules (guuey#1794).
 * The base row is counted attribute by attribute (name bytes + value + 1):
 * threadId 8+1+1 · seq 3+4+1 · userId 6+1+1 · clientMessageId 15+1+1 ·
 * at 2+1+1 · kind 4+4+1 · authorRole 10+5+1 · content 7+1+1 = 81.
 */
function rowWith(content: unknown): ThreadMessageRow {
  return {
    threadId: "t",
    seq: 1,
    userId: "u",
    clientMessageId: "c",
    at: "a",
    kind: "text",
    authorRole: "agent",
    content,
  };
}

const BASE = dynamoItemBytes(rowWith(null));
/** The stored size of `content`'s value alone (null costs 1). */
const contentBytes = (content: unknown): number => dynamoItemBytes(rowWith(content)) - BASE + 1;

describe("dynamoItemBytes", () => {
  it("counts the top level as name bytes + value + 1 per attribute", () => {
    expect(BASE).toBe(81);
  });

  it("counts a string as its UTF-8 bytes", () => {
    expect(contentBytes("héllo")).toBe(6);
    expect(contentBytes("")).toBe(0);
  });

  it("counts booleans and null as 1 byte", () => {
    expect(contentBytes(true)).toBe(1);
    expect(contentBytes(false)).toBe(1);
    expect(contentBytes(null)).toBe(1);
  });

  it("bounds a number from above: half of every digit in String(n), rounded up, plus 3", () => {
    expect(contentBytes(7)).toBe(4);
    expect(contentBytes(-5)).toBe(4);
    expect(contentBytes(12)).toBe(4);
    expect(contentBytes(123)).toBe(5);
    expect(contentBytes(1e21)).toBe(5); // "1e+21": 3 digits counted
    expect(contentBytes(0.0000001)).toBe(4); // "1e-7": 2 digits counted
    // 2 ** 120 = "1.329227995784916e+36": 16 significant digits; 18 digits counted.
    expect(contentBytes(2 ** 120)).toBe(12);
  });

  // Each value's stored size as DynamoDB itself charged it: one attribute per item, the item padded with a
  // string until its write capacity stepped from 1 unit to 2, so the item sat at exactly 1,025 bytes.
  // The bound must never fall below any of them. Negative decimals are where "+ 1 per two digits + 1" fails.
  it.each([
    [0, 1], [1, 2], [-1, 3], [12, 2], [-12, 3], [100, 2], [-100, 3],
    [0.5, 2], [-0.5, 3], [0.25, 2], [-0.25, 3], [1.5, 3], [-1.5, 4], [10.5, 3], [-10.5, 4],
    [123.456, 5], [-123.456, 6], [1e-7, 2], [-1e-7, 3],
    [1 / 7, 10], [-1 / 7, 11], [2 / 7, 9], [-2 / 7, 10], [8 / 7, 10], [-8 / 7, 11], [73 / 7, 10], [-73 / 7, 11],
    [3.0000000000000004e-7, 10], [-3.0000000000000004e-7, 11], [0.1 + 0.2, 10], [-(0.1 + 0.2), 11],
    [9007199254740991, 9], [-9007199254740991, 10],
  ])("never counts %s below the %i bytes DynamoDB charged for it", (value, measured) => {
    expect(contentBytes(value)).toBeGreaterThanOrEqual(measured);
    // inside a List, where no top-level attribute byte absorbs a miss
    expect(contentBytes([value]) - contentBytes([])).toBeGreaterThanOrEqual(1 + measured);
  });

  it("counts a List or Map as 3 bytes, plus 1 per element, plus each Map key", () => {
    expect(contentBytes([])).toBe(3);
    expect(contentBytes({})).toBe(3);
    expect(contentBytes({ ab: "x" })).toBe(3 + 1 + 2 + 1);
    // [[1,2]]: outer 3 + 1 + inner (3 + (1+4) + (1+4)) = 17
    expect(contentBytes([[1, 2]])).toBe(17);
  });

  it("drops undefined values the way the DocumentClient marshals them", () => {
    expect(contentBytes({ a: undefined })).toBe(3);
    expect(contentBytes([undefined, 1])).toBe(3 + 1 + 4);
    const withUndefined: ThreadMessageRow = { ...rowWith(null), text: undefined };
    expect(dynamoItemBytes(withUndefined)).toBe(BASE);
  });

  it("counts a number pair in a list at 14 bytes where its JSON costs 6 (why JSON length is not the measure)", () => {
    const pairs = Array.from({ length: 1000 }, () => [1, 2]);
    const json = Buffer.byteLength(JSON.stringify(pairs), "utf8");
    // 1000 × (1 element + 3 list + 2 × (1 + 4)) + 3
    expect(contentBytes(pairs)).toBe(1000 * 14 + 3);
    expect(contentBytes(pairs)).toBeGreaterThan(json * 1.9);
  });

  it("keeps the row budget below the item limit", () => {
    expect(DYNAMODB_ITEM_LIMIT_BYTES).toBe(409_600);
    expect(DYNAMODB_ROW_BUDGET_BYTES).toBeLessThan(DYNAMODB_ITEM_LIMIT_BYTES);
  });
});

describe("dynamoNumberFits", () => {
  it.each([0, -0, 1, -1, 0.5, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1e-130, -1e-130, 1 / 7])(
    "holds %s",
    (n) => expect(dynamoNumberFits(n)).toBe(true),
  );
  it.each([
    Number.MAX_SAFE_INTEGER + 2,
    Number.MIN_SAFE_INTEGER - 2,
    Number("12345678901234567890"),
    1e21,
    1e-131,
    -1e-200,
    Number.MIN_VALUE,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("refuses %s", (n) => expect(dynamoNumberFits(n)).toBe(false));

  it("is what the DynamoDB row budget declares", () => {
    expect(DYNAMODB_ROW_BUDGET).toEqual({
      maxBytes: DYNAMODB_ROW_BUDGET_BYTES,
      bytesOf: dynamoItemBytes,
      numberFits: dynamoNumberFits,
    });
  });
});
