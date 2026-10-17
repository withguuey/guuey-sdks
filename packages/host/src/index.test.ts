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

describe("buildHostContext — the private launch envelope wins (guuey#2139)", () => {
  const env = {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9911",
    ANTHROPIC_AUTH_TOKEN: "env-token",
    OPENAI_API_KEY: "env-openai",
    GEMINI_API_KEY: "env-gemini",
  };

  it("anthropic: the envelope token, the env base URL, no key-slot variable read", () => {
    expect(buildHostContext(env, { v: 1, model: { wire: "anthropic", token: "envelope-token" } })).toEqual({
      anthropicBaseUrl: "http://127.0.0.1:9911",
      anthropicAuthToken: "envelope-token",
    });
  });

  it("openai and gemini: the envelope token in its wire's slot only", () => {
    expect(buildHostContext(env, { v: 1, model: { wire: "openai", token: "envelope-token" } })).toEqual({ openaiKey: "envelope-token" });
    expect(buildHostContext(env, { v: 1, model: { wire: "gemini", token: "envelope-token" } })).toEqual({ geminiKey: "envelope-token" });
  });

  it("an envelope without a model capability: no credential at all, env key slots ignored", () => {
    expect(buildHostContext(env, { v: 1 })).toEqual({ anthropicBaseUrl: "http://127.0.0.1:9911" });
  });
});

describe("bootEnvelope — the inspector guard runs before the envelope is touched (guuey#2139)", () => {
  it("with the marker set, a startup without --disable-sigusr1 is refused by the guard, not by the reader", async () => {
    const { bootEnvelope } = await import("./index.js");
    const { HostInspectorGuardError } = await import("./inspector-guard.js");
    // Marker "7" is one the reader itself refuses without touching any
    // descriptor, so this test never reads this process's own fd 5: when the
    // guard is in place the guard's error comes first.
    await expect(bootEnvelope({ GUUEY_LAUNCH_ENVELOPE_FD: "7" }, [])).rejects.toBeInstanceOf(HostInspectorGuardError);
    await expect(bootEnvelope({ GUUEY_LAUNCH_ENVELOPE_FD: "7" }, ["--disable-sigusr1", "--inspect=0"])).rejects.toBeInstanceOf(
      HostInspectorGuardError,
    );
  });

  it("with the marker absent (local dev), there is no guard and no envelope", async () => {
    const { bootEnvelope } = await import("./index.js");
    await expect(bootEnvelope({}, ["--inspect"])).resolves.toBeUndefined();
  });
});
