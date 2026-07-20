import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GuueyStateError,
  InvalidArgumentError,
  InvalidContextError,
  InvalidKeyError,
  InvalidTtlError,
  MissingContextError,
  QuotaExceededError,
  TypeMismatchError,
  ValueTooLargeError,
  createGuueyState,
  getCurrentContext,
  kv as alsKv,
  withGuueyContext,
} from "./index.js";
import { __resetInMemoryStoreForTests } from "./in-memory.js";
import { runKvContractSuite } from "./testing/contract-suite.js";

const CTX = { userId: "u_test", mcpId: "mcp_test" } as const;

beforeEach(() => {
  // Quiet the one-time "using in-memory" warning across tests.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Wipe the shared in-memory store so each test is hermetic.
  __resetInMemoryStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

runKvContractSuite("in-memory", async () => {
  vi.useFakeTimers();
  __resetInMemoryStoreForTests();
  return {
    kv: createGuueyState({ context: CTX }),
    advance: (ms) => {
      vi.advanceTimersByTime(ms);
    },
    makeScoped: async (ctx) => createGuueyState({ context: ctx }),
    cleanup: async () => {
      vi.useRealTimers();
      __resetInMemoryStoreForTests();
    },
  };
});

describe("@guuey/state — AsyncLocalStorage barrel `kv`", () => {
  it("throws MissingContextError when no context is bound", async () => {
    await expect(alsKv.get("foo")).rejects.toBeInstanceOf(MissingContextError);
  });

  it("uses the surrounding withGuueyContext", async () => {
    await withGuueyContext(CTX, async () => {
      await alsKv.set("hi", "there", { ttl: 60 });
      expect(await alsKv.get("hi")).toBe("there");
    });
  });

  it("isolates nested contexts", async () => {
    await withGuueyContext({ userId: "u_outer", mcpId: "mcp_test" }, async () => {
      await alsKv.set("k", "outer", { ttl: 60 });
      await withGuueyContext(
        { userId: "u_inner", mcpId: "mcp_test" },
        async () => {
          expect(await alsKv.get("k")).toBeUndefined();
          await alsKv.set("k", "inner", { ttl: 60 });
          expect(await alsKv.get("k")).toBe("inner");
        },
      );
      // Outer scope still sees its own value
      expect(await alsKv.get("k")).toBe("outer");
    });
  });

  it("getCurrentContext reports the active scope", async () => {
    expect(getCurrentContext()).toBeUndefined();
    await withGuueyContext(CTX, async () => {
      expect(getCurrentContext()).toEqual(CTX);
    });
    expect(getCurrentContext()).toBeUndefined();
  });
});

describe("@guuey/state — error envelope", () => {
  it("every typed error extends GuueyStateError + has a stable code", () => {
    const errs: GuueyStateError[] = [
      new InvalidKeyError("k", "bad"),
      new InvalidTtlError(0, "zero"),
      new InvalidArgumentError("bad limit"),
      new InvalidContextError("userId", "empty"),
      new TypeMismatchError("k", "string"),
      new QuotaExceededError(2_000_000, 1_048_576),
      new ValueTooLargeError(100_000, 65_536),
      new MissingContextError(),
    ];
    for (const err of errs) {
      expect(err).toBeInstanceOf(GuueyStateError);
      expect(err.code).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("@guuey/state — scope context validation", () => {
  it("rejects empty / whitespace / control-character ids at both entry points", () => {
    for (const bad of ["", "a b", "a\tb", "a\nb", "a\u0000b", "a\u00a0b"]) {
      expect(() =>
        createGuueyState({ context: { userId: bad, mcpId: "mcp_ok" } }),
      ).toThrow(InvalidContextError);
      expect(() =>
        createGuueyState({ context: { userId: "u_ok", mcpId: bad } }),
      ).toThrow(InvalidContextError);
    }
    return expect(
      withGuueyContext({ userId: "a b", mcpId: "mcp_ok" }, async () => {}),
    ).rejects.toBeInstanceOf(InvalidContextError);
  });
});

describe("@guuey/state — audit regressions (2026-07-20)", () => {
  it("requesting the hosted binding fails loud (no silent in-memory)", () => {
    // Pre-fix, bindingUrl/GUUEY_KV_URL silently returned the in-memory
    // store — an operator following the old warning's instruction got
    // non-durable storage with zero signal.
    expect(() =>
      createGuueyState({ context: CTX, bindingUrl: "https://kv.example" }),
    ).toThrow(/not implemented yet/);
    process.env.GUUEY_KV_URL = "https://kv.example";
    try {
      expect(() => createGuueyState({ context: CTX })).toThrow(
        /GUUEY_KV_URL/,
      );
    } finally {
      delete process.env.GUUEY_KV_URL;
    }
  });
});
