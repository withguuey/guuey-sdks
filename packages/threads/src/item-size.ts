/**
 * The size of a stored row as DynamoDB counts it, so a binding backed by
 * DynamoDB can declare a {@link RowBudget} that matches the store's own item
 * limit (400 KB).
 *
 * The count follows the published rules (DynamoDB Developer Guide, "Item
 * sizes and formats"), walked over the row the way the DocumentClient
 * marshals it (string → S, number → N, boolean → BOOL, null → NULL,
 * array → L, object → M, `undefined` dropped):
 *
 * - a string is its UTF-8 bytes;
 * - a boolean or null is 1 byte;
 * - a number is published as 1 byte per two significant digits, plus 1. As
 *   measured against DynamoDB it is 1 exponent byte, plus the digits in pairs
 *   aligned on the decimal point (so up to half a pair more than the digits
 *   alone), plus 1 more byte when the number is negative: -1.5 is 4 bytes and
 *   -123.456 is 6. It is bounded here from above as half of ALL the digits in
 *   `String(n)`, rounded up, plus 3, so an exponent form can only over-count;
 * - a List or Map is 3 bytes, plus 1 byte per element, plus each Map key's
 *   UTF-8 bytes and each element's own size;
 * - a top-level attribute is its name's UTF-8 bytes plus its value, plus 1.
 *
 * The result is an UPPER bound on the stored size: it may count a little
 * more than DynamoDB does, never less.
 *
 * Why not the length of the row's JSON: JSON under-counts the shapes a chart
 * input is made of. A list of one-digit numbers costs 2 bytes per element as
 * JSON (`1,`) and 3 by the rules above; pairs (`[1,2],`) cost 6 against 10.
 * A row measured as 380 KB of JSON could be about 630 KB in DynamoDB.
 */

import type { RowBudget } from "./rows.js";

/** DynamoDB's maximum item size: 400 KB. */
export const DYNAMODB_ITEM_LIMIT_BYTES = 409_600;

/**
 * The row budget a DynamoDB-backed binding declares: below the item limit,
 * so the seq and timestamp the store assigns at write time, and the bound's
 * own rounding, can never carry a row that fit over the limit.
 */
export const DYNAMODB_ROW_BUDGET_BYTES = 380_000;

/** The smallest non-zero magnitude DynamoDB stores; below it a write is refused as an underflow. */
const DYNAMODB_MIN_NUMBER_MAGNITUDE = 1e-130;

/**
 * Whether a DynamoDB-backed binding can store `n` as written. The
 * DocumentClient refuses a number outside the safe-integer range, and NaN or
 * an infinity, before it sends anything (a JSON number that large has already
 * lost its digits to `JSON.parse`); DynamoDB itself refuses a non-zero
 * magnitude below 1e-130. A row carrying such a number would fail its write
 * whatever its size, so it is planned out like an oversized one.
 */
export function dynamoNumberFits(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  const magnitude = Math.abs(n);
  return magnitude === 0 || (magnitude >= DYNAMODB_MIN_NUMBER_MAGNITUDE && magnitude <= Number.MAX_SAFE_INTEGER);
}

/** The row budget every DynamoDB-backed binding declares. */
export const DYNAMODB_ROW_BUDGET: RowBudget = {
  maxBytes: DYNAMODB_ROW_BUDGET_BYTES,
  bytesOf: dynamoItemBytes,
  numberFits: dynamoNumberFits,
};

const LIST_OR_MAP_OVERHEAD = 3;
const ELEMENT_OVERHEAD = 1;

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function numberBytes(n: number): number {
  let digits = 0;
  for (const ch of String(n)) {
    if (ch >= "0" && ch <= "9") digits++;
  }
  // + 1 exponent byte, + 1 for a pair split by the decimal point, + 1 for a negative's terminator.
  return Math.ceil(digits / 2) + 3;
}

/**
 * The stored size of one attribute VALUE. `undefined` values are dropped by
 * the marshaller, so they cost nothing and their element overhead is not
 * counted either.
 */
function valueBytes(value: unknown): number {
  if (value === null) return 1;
  switch (typeof value) {
    case "string":
      return utf8Bytes(value);
    case "number":
      return numberBytes(value);
    case "boolean":
      return 1;
    case "object": {
      let total = LIST_OR_MAP_OVERHEAD;
      if (Array.isArray(value)) {
        for (const el of value) {
          if (el === undefined) continue;
          total += ELEMENT_OVERHEAD + valueBytes(el);
        }
        return total;
      }
      for (const [key, el] of Object.entries(value)) {
        if (el === undefined) continue;
        total += ELEMENT_OVERHEAD + utf8Bytes(key) + valueBytes(el);
      }
      return total;
    }
    default:
      // undefined (dropped by the marshaller); functions, symbols and bigints
      // never reach a stored row.
      return 0;
  }
}

/**
 * The stored size of an item (a `ThreadMessage` row, or any attribute bag the
 * DocumentClient marshals), as an upper bound under DynamoDB's own rules.
 */
export function dynamoItemBytes(item: object): number {
  let total = 0;
  for (const [name, value] of Object.entries(item)) {
    if (value === undefined) continue;
    total += utf8Bytes(name) + valueBytes(value) + 1;
  }
  return total;
}
