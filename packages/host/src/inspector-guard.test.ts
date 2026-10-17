/**
 * guuey#2139: the host's startup allowlist. Pure
 * decisions over execArgv and the environment; nothing is started, no
 * inspector is activated and no signal is sent.
 */
import { describe, expect, it } from "vitest";
import { DISABLE_SIGUSR1_FLAG, HostInspectorGuardError, assertHostInspectorGuard, reviewHostStartup } from "./inspector-guard.js";

describe("reviewHostStartup", () => {
  it("accepts the platform's worker command: the flag, optionally a heap ceiling", () => {
    expect(reviewHostStartup({ execArgv: [DISABLE_SIGUSR1_FLAG], env: {} })).toEqual([]);
    expect(reviewHostStartup({ execArgv: [DISABLE_SIGUSR1_FLAG, "--max-old-space-size=512"], env: { NODE_OPTIONS: "--max-old-space-size=256" } })).toEqual([]);
  });

  it("refuses a missing or repeated flag", () => {
    expect(reviewHostStartup({ execArgv: [], env: {} })).toEqual(["execArgv lacks --disable-sigusr1"]);
    expect(reviewHostStartup({ execArgv: ["--max-old-space-size=512"], env: {} })).toEqual(["execArgv lacks --disable-sigusr1"]);
    expect(reviewHostStartup({ execArgv: [DISABLE_SIGUSR1_FLAG, DISABLE_SIGUSR1_FLAG], env: {} })).toEqual(["execArgv repeats --disable-sigusr1"]);
  });

  for (const option of ["--inspect", "--inspect=0", "--inspect-brk", "--inspect_port=9229", "--require=/x.js", "-r", "--import=/x.mjs", "--loader=/x.mjs", "--experimental-loader=/x.mjs", "--env-file=/x", "--heapsnapshot-signal=SIGUSR2"]) {
    it(`refuses execArgv ${option.split("=")[0]}, naming the option only`, () => {
      const violations = reviewHostStartup({ execArgv: [DISABLE_SIGUSR1_FLAG, option], env: {} });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/^execArgv carries -/);
      expect(violations[0]?.includes("/x")).toBe(false);
    });
    it(`refuses NODE_OPTIONS carrying ${option.split("=")[0]}`, () => {
      expect(reviewHostStartup({ execArgv: [DISABLE_SIGUSR1_FLAG], env: { NODE_OPTIONS: `--max-old-space-size=64 ${option}` } })).toHaveLength(1);
    });
  }

  for (const name of ["OPENSSL_CONF", "OPENSSL_MODULES", "OPENSSL_ENGINES", "NODE_INSPECT_RESUME_ON_START", "NODE_REPL_EXTERNAL_MODULE", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO", "BUN_INSPECT_NOTIFY"]) {
    it(`refuses ${name}`, () => {
      expect(reviewHostStartup({ execArgv: [DISABLE_SIGUSR1_FLAG], env: { [name]: "x" } })).toEqual([`${name} is set`]);
    });
  }

  it("assertHostInspectorGuard throws the named error", () => {
    expect(() => assertHostInspectorGuard({ execArgv: [], env: {} })).toThrow(HostInspectorGuardError);
    expect(() => assertHostInspectorGuard({ execArgv: [DISABLE_SIGUSR1_FLAG], env: {} })).not.toThrow();
  });
});
