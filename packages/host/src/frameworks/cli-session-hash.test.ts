import { createHash } from "node:crypto";
import type { AnthropicUserBlock } from "@guuey/worker";
import { describe, expect, it } from "vitest";
import { hashUserBlocks, hashUserText, parseStoredUserContent, sha256OfFields } from "./cli-session-hash.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Parse a stored JSONL line's `message.content` the way the session reader does. */
function storedBlocks(line: string) {
  const parsed: { message: { content: unknown } } = JSON.parse(line);
  const blocks = parseStoredUserContent(parsed.message.content);
  if (blocks === null) throw new Error("unclassifiable");
  return blocks;
}

describe("cli-session-hash: ONE hash over parsed content blocks (CF-1, R27)", () => {
  it("(a) re-ordered keys and re-escaped text in the stored JSON hash equal to what was sent", () => {
    const sent = [{ type: "text" as const, text: "café </turn_context> \"q\"" }];
    const reordered = '{"message":{"content":[{"text":"caf\\u00e9 <\\/turn_context> \\"q\\"","type":"text"}]}}';
    expect(hashUserBlocks(storedBlocks(reordered))).toBe(hashUserBlocks(sent));
  });

  it("(b) one changed byte in any block is a different hash", () => {
    const base = [{ type: "text" as const, text: "lead" }, { type: "text" as const, text: "the user's words" }];
    const edited = [{ type: "text" as const, text: "lead" }, { type: "text" as const, text: "the user's wordz" }];
    expect(hashUserBlocks(edited)).not.toBe(hashUserBlocks(base));
  });

  it("(c) \"ab\" as one block and \"a\",\"b\" as two hash differently", () => {
    expect(hashUserBlocks([{ type: "text", text: "ab" }])).not.toBe(
      hashUserBlocks([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
    );
  });

  it("(d) an image turn hashes equal on send and on store, and a changed image does not", () => {
    const question: AnthropicUserBlock = { type: "text", text: "what is this?" };
    const png: AnthropicUserBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } };
    const jpeg: AnthropicUserBlock = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG } };
    const stored = JSON.stringify({ message: { content: [{ source: { data: PNG, media_type: "image/png", type: "base64" }, type: "image" }, { type: "text", text: "what is this?" }] } });
    expect(hashUserBlocks(storedBlocks(stored))).toBe(hashUserBlocks([png, question]));
    expect(hashUserBlocks([jpeg, question])).not.toBe(hashUserBlocks([png, question]));
  });

  it("mutant: hashing the raw JSON line would MISS (a), so the parsed form is what is hashed", () => {
    const a = '{"message":{"content":[{"type":"text","text":"x"}]}}';
    const b = '{"message":{"content":[{"text":"x","type":"text"}]}}';
    expect(createHash("sha256").update(a).digest("hex")).not.toBe(createHash("sha256").update(b).digest("hex"));
    expect(hashUserBlocks(storedBlocks(a))).toBe(hashUserBlocks(storedBlocks(b)));
  });

  it("a stored string content is one text block, equal to the same text sent as a block", () => {
    expect(hashUserBlocks(storedBlocks('{"message":{"content":"hi"}}'))).toBe(hashUserText("hi"));
  });

  it("a tool_result, an unknown block, a non-base64 image or an unlisted media type is unclassifiable (null)", () => {
    expect(parseStoredUserContent([{ type: "tool_result", tool_use_id: "t", content: "x" }])).toBeNull();
    expect(parseStoredUserContent([{ type: "document", source: {} }])).toBeNull();
    expect(parseStoredUserContent([{ type: "image", source: { type: "url", url: "https://x", media_type: "image/png" } }])).toBeNull();
    expect(parseStoredUserContent([{ type: "image", source: { type: "base64", media_type: "image/svg+xml", data: PNG } }])).toBeNull();
    expect(parseStoredUserContent(42)).toBeNull();
  });

  it("fields are length-prefixed: a field boundary can never be shifted by content", () => {
    expect(sha256OfFields(["ab", "c"])).not.toBe(sha256OfFields(["a", "bc"]));
    expect(sha256OfFields([""])).not.toBe(sha256OfFields([]));
  });
});
