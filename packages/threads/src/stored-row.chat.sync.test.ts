/**
 * `isInformationless` here MIRRORS the reader's rule in `@guuey/chat`
 * (`src/plan.ts`): a provider carry the transcript hides is blank to every
 * reader that classifies a stored row, and to the agent runtime's turn watch,
 * which imports it from here. The threads package does not depend on the chat
 * package, and the function is private there, so this reads both sources and
 * fails when they diverge. Quotes and whitespace are the only differences it
 * forgives (the two packages format differently).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CHAT_PLAN = new URL("../../chat/src/plan.ts", import.meta.url);
const STORED_ROW = new URL("./stored-row.ts", import.meta.url);

/** The body of `function isInformationless`, up to its closing brace, normalized. */
function ruleBody(source: string, where: string): string {
  const start = source.indexOf("function isInformationless(");
  if (start === -1) throw new Error(`${where} no longer defines isInformationless: re-read it before trusting this mirror`);
  const end = source.indexOf("\n}", start);
  if (end === -1) throw new Error(`${where}: isInformationless has no closing brace at column 0`);
  return source.slice(start, end + 2).replaceAll('"', "'").replace(/\s+/g, "");
}

describe("isInformationless equals @guuey/chat's rule", () => {
  const chatSource = readFileSync(CHAT_PLAN, "utf8");
  const ownSource = readFileSync(STORED_ROW, "utf8");

  it("the two bodies are one rule", () => {
    expect(ruleBody(ownSource, "stored-row.ts")).toBe(ruleBody(chatSource, "chat plan.ts"));
  });

  it("the reader is not vacuous: a changed arm in chat is a different body", () => {
    const doctored = chatSource.replace('return value === "";', "return false;");
    expect(doctored).not.toBe(chatSource);
    expect(ruleBody(doctored, "doctored")).not.toBe(ruleBody(ownSource, "stored-row.ts"));
  });
});
