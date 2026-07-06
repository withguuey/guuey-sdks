import { describe, it, expect } from "vitest";
import { collectSecretsFromEnv, redactSecrets } from "./redact.mjs";

describe("collectSecretsFromEnv", () => {
  it("collects values of *_PAT/*_TOKEN/*_KEY/*_SECRET/*_PASSWORD vars", () => {
    const secrets = collectSecretsFromEnv({
      GUUEY_E2E_PAT: "ggui_pat_abc123def",
      SOME_TOKEN: "tok_0123456789",
      ANTHROPIC_API_KEY: "sk-ant-fake-key",
      DB_SECRET: "s3cr3t-value",
      ADMIN_PASSWORD: "hunter22",
      GUUEY_E2E_HOST: "https://dev.platform.guuey.com", // not a secret suffix
      PATH: "/usr/bin", // "PATH" does not end in "_PAT"
    });
    expect(secrets).toContain("ggui_pat_abc123def");
    expect(secrets).toContain("tok_0123456789");
    expect(secrets).toContain("sk-ant-fake-key");
    expect(secrets).toContain("s3cr3t-value");
    expect(secrets).toContain("hunter22");
    expect(secrets).not.toContain("https://dev.platform.guuey.com");
    expect(secrets).not.toContain("/usr/bin");
  });

  it("skips short/degenerate values that would shred unrelated text", () => {
    const secrets = collectSecretsFromEnv({ SOME_KEY: "1", OTHER_TOKEN: "ab" });
    expect(secrets).toEqual([]);
  });

  it("includes explicit extras and dedupes against env-sourced values", () => {
    const secrets = collectSecretsFromEnv(
      { GUUEY_E2E_PAT: "ggui_pat_same" },
      ["ggui_pat_same", "another-secret"],
    );
    expect(secrets.filter((s) => s === "ggui_pat_same")).toHaveLength(1);
    expect(secrets).toContain("another-secret");
  });

  it("skips undefined env values", () => {
    expect(collectSecretsFromEnv({ MISSING_TOKEN: undefined })).toEqual([]);
  });

  it("returns longest secrets first so overlapping secrets redact cleanly", () => {
    const secrets = collectSecretsFromEnv({
      SHORT_TOKEN: "abc123",
      LONG_TOKEN: "abc123-extended-form",
    });
    expect(secrets).toEqual(["abc123-extended-form", "abc123"]);
  });
});

describe("redactSecrets", () => {
  const PAT = "ggui_pat_eyJhbGciOiJIUzI1NiJ9.fake";

  it("scrubs a secret embedded in an argv-echo style error message", () => {
    // The exact leak shape the reviewer reproduced: run()'s rejection
    // message embedding the raw login argv.
    const msg = `node /repo/cli.js login --token ${PAT} exited 1`;
    const out = redactSecrets(msg, [PAT]);
    expect(out).toBe("node /repo/cli.js login --token *** exited 1");
    expect(out).not.toContain(PAT);
  });

  it("scrubs every occurrence, not just the first", () => {
    const out = redactSecrets(`${PAT} then again ${PAT}`, [PAT]);
    expect(out).toBe("*** then again ***");
  });

  it("scrubs multiple distinct secrets", () => {
    const out = redactSecrets(`pat=${PAT} key=sk-ant-fake`, [PAT, "sk-ant-fake"]);
    expect(out).toBe("pat=*** key=***");
  });

  it("treats secrets as literals, never as RegExp patterns", () => {
    const trap = "a+b(c)$[d]"; // would blow up or mis-match as a pattern
    expect(redactSecrets(`x ${trap} y`, [trap])).toBe("x *** y");
  });

  it("leaves text without secrets untouched and ignores empty secrets", () => {
    expect(redactSecrets("all clear", [PAT, ""])).toBe("all clear");
  });
});
