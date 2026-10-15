import { describe, expect, it } from "vitest";
import { HIGHLIGHT_MAX_CHARS, highlightCode, prettyJson, type HighlightToken } from "./highlight.js";

const joined = (tokens: readonly HighlightToken[]): string => tokens.map((t) => t.text).join("");
const kindsOf = (tokens: readonly HighlightToken[], kind: HighlightToken["kind"]): string[] =>
  tokens.filter((t) => t.kind === kind).map((t) => t.text);

describe("highlightCode is LOSSLESS: the tokens re-join to the input byte for byte (guuey#2367)", () => {
  const samples: Array<[string, string | undefined]> = [
    ['{\n  "a": 1,\n\t"b": [true, null, -2.5e3],\n  "c": "x\\"y"\n}\n', "json"],
    ["const x = 'a';\n// note\n/* block\n */ let y = `t${x}`;\n\n  return 42;", "ts"],
    ["def f(x):\n    # comment\n    return \"s\" + 'q'  \n", "python"],
    ["#!/bin/bash\nif [ -f x ]; then\n  echo \"hi\"   # trailing\nfi\r\n", "bash"],
    ["no lang at all\n  with   spaces\n", undefined],
    ["unterminated \"string\n next line", "js"],
    ["  \n\n\t  \n", "json"],
  ];
  it.each(samples)("round-trips %#", (code, lang) => {
    expect(joined(highlightCode(code, lang))).toBe(code);
  });
  it("merges adjacent runs of one kind and never emits an empty token", () => {
    const tokens = highlightCode("aaa bbb\nccc", "unknown");
    expect(tokens).toEqual([{ text: "aaa bbb\nccc", kind: "plain" }]);
    for (const t of highlightCode('{"k": [1, 2]}', "json")) expect(t.text.length).toBeGreaterThan(0);
  });
});

describe("highlightCode kinds", () => {
  it("JSON: keys, strings, numbers, literals and punctuation", () => {
    const tokens = highlightCode('{"name": "Ada", "age": 36, "ok": true, "x": null}', "json");
    expect(kindsOf(tokens, "key")).toEqual(['"name"', '"age"', '"ok"', '"x"']);
    expect(kindsOf(tokens, "string")).toEqual(['"Ada"']);
    expect(kindsOf(tokens, "number")).toEqual(["36"]);
    expect(kindsOf(tokens, "keyword")).toEqual(["true", "null"]);
  });
  it("a key is recognized across spaces before the colon; an escaped quote stays inside the string", () => {
    const tokens = highlightCode('{"a" : "x\\"y"}', "JSON");
    expect(kindsOf(tokens, "key")).toEqual(['"a"']);
    expect(kindsOf(tokens, "string")).toEqual(['"x\\"y"']);
  });
  it("js/ts: keywords, strings, comments and numbers; identifiers stay plain", () => {
    const tokens = highlightCode("const total = 10; // sum\nreturn total2;", "typescript");
    expect(kindsOf(tokens, "keyword")).toEqual(["const", "return"]);
    expect(kindsOf(tokens, "number")).toEqual(["10"]);
    expect(kindsOf(tokens, "comment")).toEqual(["// sum"]);
    expect(tokens.some((t) => t.kind === "number" && t.text === "2")).toBe(false);
  });
  it("python and shell use # comments", () => {
    expect(kindsOf(highlightCode("x = 1  # c", "py"), "comment")).toEqual(["# c"]);
    expect(kindsOf(highlightCode("echo hi # c", "sh"), "comment")).toEqual(["# c"]);
  });
  it("an unknown language is one plain token", () => {
    expect(highlightCode("SELECT 1;", "sql")).toEqual([{ text: "SELECT 1;", kind: "plain" }]);
  });
  it("empty input is no tokens; oversized input is one plain token, never scanned", () => {
    expect(highlightCode("", "json")).toEqual([]);
    const big = `[${"1,".repeat(HIGHLIGHT_MAX_CHARS)}1]`;
    expect(highlightCode(big, "json")).toEqual([{ text: big, kind: "plain" }]);
  });
});

describe("prettyJson", () => {
  it("re-indents an object or array with two spaces", () => {
    expect(prettyJson('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    expect(prettyJson("  [1]  ")).toBe("[\n  1\n]");
  });
  it("is null for anything that is not a JSON object or array, and never throws", () => {
    expect(prettyJson("hello")).toBeNull();
    expect(prettyJson("{not json")).toBeNull();
    expect(prettyJson("42")).toBeNull();
    expect(prettyJson('"x"')).toBeNull();
    expect(prettyJson("")).toBeNull();
  });
});
