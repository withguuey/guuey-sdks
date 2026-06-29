/**
 * Tests for the boot-context helper extracted from the `@guuey/host` entrypoint.
 * `index.ts` has top-level `main()` side-effects so it cannot be imported by
 * tests; `buildHostContext` is extracted to `boot-context.ts` for testability.
 */
import { describe, expect, it } from "vitest";
import { buildHostContext } from "./boot-context.js";

describe("buildHostContext — boot-time env reading", () => {
  it("broker mode: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN set, no API key → broker fields populated, apiKey absent", () => {
    const ctx = buildHostContext({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9911",
      ANTHROPIC_AUTH_TOKEN: "opaque-session-token",
    });
    expect(ctx.anthropicBaseUrl).toBe("http://127.0.0.1:9911");
    expect(ctx.anthropicAuthToken).toBe("opaque-session-token");
    expect(ctx.anthropicApiKey).toBeUndefined();
    expect(ctx.openaiKey).toBeUndefined();
  });

  it("local-dev mode: ANTHROPIC_API_KEY set, no base-URL/token → apiKey populated, broker fields absent", () => {
    const ctx = buildHostContext({
      ANTHROPIC_API_KEY: "sk-ant-api03-local",
    });
    expect(ctx.anthropicApiKey).toBe("sk-ant-api03-local");
    expect(ctx.anthropicBaseUrl).toBeUndefined();
    expect(ctx.anthropicAuthToken).toBeUndefined();
    expect(ctx.openaiKey).toBeUndefined();
  });

  it("OpenAI mode: OPENAI_API_KEY (or opaque token in hosted mode) → openaiKey populated, Anthropic fields absent", () => {
    const ctx = buildHostContext({
      OPENAI_API_KEY: "sk-openai-or-opaque-broker-token",
    });
    expect(ctx.openaiKey).toBe("sk-openai-or-opaque-broker-token");
    expect(ctx.anthropicApiKey).toBeUndefined();
    expect(ctx.anthropicBaseUrl).toBeUndefined();
    expect(ctx.anthropicAuthToken).toBeUndefined();
  });

  it("empty env → all fields undefined (nothing configured)", () => {
    const ctx = buildHostContext({});
    expect(ctx.openaiKey).toBeUndefined();
    expect(ctx.anthropicApiKey).toBeUndefined();
    expect(ctx.anthropicBaseUrl).toBeUndefined();
    expect(ctx.anthropicAuthToken).toBeUndefined();
  });
});
