import { McpUiHostStylesSchema } from "@modelcontextprotocol/ext-apps";
import { describe, expect, it } from "vitest";
import {
  EMPTY_HOST_STYLE_VARIABLES,
  announcedHostStyleVariables,
  hostStyleVariablesRecord,
  type McpUiStyles,
} from "./host-style-variables.js";

/** The spec's own key union, read off its zod schema at runtime — the oracle the mirror is pinned to. */
const SPEC_KEYS = McpUiHostStylesSchema.shape.variables
  .unwrap()
  .keyType.options.map((literal) => literal.value);

describe("EMPTY_HOST_STYLE_VARIABLES — a compiler-enforced mirror of the spec's key union (guuey#1128)", () => {
  it("names exactly the spec's keys: none missing, none extra, none duplicated", () => {
    const mirror = Object.keys(EMPTY_HOST_STYLE_VARIABLES);
    expect(new Set(SPEC_KEYS).size).toBe(SPEC_KEYS.length);
    expect(mirror.length).toBe(SPEC_KEYS.length);
    expect([...mirror].sort()).toEqual([...SPEC_KEYS].sort());
  });

  it("every slot is unset", () => {
    expect(Object.values(EMPTY_HOST_STYLE_VARIABLES).every((value) => value === undefined)).toBe(true);
  });
});

describe("hostStyleVariablesRecord — completes a partial palette into the spec-typed record", () => {
  const partial = { "--color-background-primary": "#ffffff", "--color-text-primary": "#111111" } as const;

  it("carries every spec key, with the announced slots set and the rest undefined", () => {
    const record: McpUiStyles = hostStyleVariablesRecord(partial);
    expect(Object.keys(record).length).toBe(SPEC_KEYS.length);
    expect(record["--color-background-primary"]).toBe("#ffffff");
    expect(record["--color-text-primary"]).toBe("#111111");
    expect(record["--color-border-primary"]).toBeUndefined();
    expect(record["--shadow-lg"]).toBeUndefined();
  });

  it("is accepted by the spec's own schema", () => {
    expect(McpUiHostStylesSchema.safeParse({ variables: hostStyleVariablesRecord(partial) }).success).toBe(true);
    expect(McpUiHostStylesSchema.safeParse({ variables: hostStyleVariablesRecord({}) }).success).toBe(true);
  });

  it("is wire-identical to the partial: JSON drops the unset slots", () => {
    expect(JSON.parse(JSON.stringify(hostStyleVariablesRecord(partial)))).toEqual(partial);
    expect(JSON.parse(JSON.stringify(hostStyleVariablesRecord({})))).toEqual({});
  });

  it("does not let the partial's own undefined slots read as announced", () => {
    const record = hostStyleVariablesRecord({ "--color-text-danger": undefined, "--color-text-primary": "#000000" });
    expect(announcedHostStyleVariables(record)).toEqual({ "--color-text-primary": "#000000" });
  });
});

describe("announcedHostStyleVariables — the wire's view of a record", () => {
  it("is the inverse of the completion", () => {
    const partial = { "--font-sans": "Inter, sans-serif", "--color-border-secondary": "#eeeeee" };
    expect(announcedHostStyleVariables(hostStyleVariablesRecord(partial))).toEqual(partial);
    expect(announcedHostStyleVariables(EMPTY_HOST_STYLE_VARIABLES)).toEqual({});
  });
});
