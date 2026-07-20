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

describe("@guuey/state — explicit context", () => {
  it("set + get round-trips a JSON-serializable value", async () => {
    const kv = createGuueyState({ context: CTX });
    await kv.set("hello", { value: 1 }, { ttl: 60 });
    expect(await kv.get<{ value: number }>("hello")).toEqual({ value: 1 });
  });

  it("get returns undefined for absent keys", async () => {
    const kv = createGuueyState({ context: CTX });
    expect(await kv.get("nope")).toBeUndefined();
  });

  it("delete is a no-op for absent keys", async () => {
    const kv = createGuueyState({ context: CTX });
    await expect(kv.delete("nope")).resolves.toBeUndefined();
  });

  it("has reports existence correctly", async () => {
    const kv = createGuueyState({ context: CTX });
    expect(await kv.has("a")).toBe(false);
    await kv.set("a", 1, { ttl: 60 });
    expect(await kv.has("a")).toBe(true);
    await kv.delete("a");
    expect(await kv.has("a")).toBe(false);
  });

  it("keys returns the scope's keys, optionally prefix-filtered", async () => {
    const kv = createGuueyState({ context: CTX });
    await kv.set("user:1", "a", { ttl: 60 });
    await kv.set("user:2", "b", { ttl: 60 });
    await kv.set("post:1", "c", { ttl: 60 });
    const all = await kv.keys();
    expect(all.keys).toEqual(
      expect.arrayContaining(["user:1", "user:2", "post:1"]),
    );
    expect(all.cursor).toBeUndefined();
    expect((await kv.keys({ prefix: "user:" })).keys).toEqual([
      "user:1",
      "user:2",
    ]);
  });

  it("keys paginates lexicographically via cursor", async () => {
    const kv = createGuueyState({ context: CTX });
    for (const k of ["e", "c", "a", "d", "b"]) {
      await kv.set(`p:${k}`, 1, { ttl: 60 });
    }
    const page1 = await kv.keys({ prefix: "p:", limit: 2 });
    expect(page1.keys).toEqual(["p:a", "p:b"]);
    expect(page1.cursor).toBe("p:b");
    const page2 = await kv.keys({ prefix: "p:", limit: 2, cursor: page1.cursor });
    expect(page2.keys).toEqual(["p:c", "p:d"]);
    const page3 = await kv.keys({ prefix: "p:", limit: 2, cursor: page2.cursor });
    expect(page3.keys).toEqual(["p:e"]);
    expect(page3.cursor).toBeUndefined();
  });

  it("increment + decrement are atomic on number-typed keys", async () => {
    const kv = createGuueyState({ context: CTX });
    expect(await kv.increment("counter", { ttl: 60 })).toBe(1);
    expect(await kv.increment("counter", { by: 5, ttl: 60 })).toBe(6);
    expect(await kv.decrement("counter", { ttl: 60 })).toBe(5);
  });

  it("scope() returns live usage", async () => {
    const kv = createGuueyState({ context: CTX });
    const before = await kv.scope();
    expect(before.usedBytes).toBe(0);
    await kv.set("x", "hello", { ttl: 60 });
    const after = await kv.scope();
    expect(after.usedBytes).toBeGreaterThan(before.usedBytes);
    expect(after.keyCount).toBe(1);
    expect(after.userId).toBe(CTX.userId);
    expect(after.mcpId).toBe(CTX.mcpId);
  });

  it("scopes data per (userId, mcpId) — separate scopes don't see each other", async () => {
    const a = createGuueyState({
      context: { userId: "u_a", mcpId: "mcp_test" },
    });
    const b = createGuueyState({
      context: { userId: "u_b", mcpId: "mcp_test" },
    });
    await a.set("shared", "from-a", { ttl: 60 });
    expect(await b.get("shared")).toBeUndefined();
  });
});

describe("@guuey/state — validation", () => {
  it("rejects an invalid key (empty)", async () => {
    const kv = createGuueyState({ context: CTX });
    await expect(kv.set("", 1, { ttl: 60 })).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
  });

  it("rejects an invalid key (illegal char)", async () => {
    const kv = createGuueyState({ context: CTX });
    await expect(kv.set("key with space", 1, { ttl: 60 })).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
  });

  it("rejects a missing TTL", async () => {
    const kv = createGuueyState({ context: CTX });
    // @ts-expect-error — intentionally drop required ttl
    await expect(kv.set("a", 1, {})).rejects.toBeInstanceOf(InvalidTtlError);
  });

  it("rejects a TTL over 90 days", async () => {
    const kv = createGuueyState({ context: CTX });
    const ninetyOneDays = 60 * 60 * 24 * 91;
    await expect(
      kv.set("a", 1, { ttl: ninetyOneDays }),
    ).rejects.toBeInstanceOf(InvalidTtlError);
  });

  it("rejects a value over 64 KiB", async () => {
    const kv = createGuueyState({ context: CTX });
    const huge = "x".repeat(65 * 1024);
    await expect(kv.set("a", huge, { ttl: 60 })).rejects.toBeInstanceOf(
      ValueTooLargeError,
    );
  });
});

describe("@guuey/state — TTL expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined after the TTL elapses", async () => {
    const kv = createGuueyState({ context: CTX });
    await kv.set("ephemeral", "hi", { ttl: 30 });
    expect(await kv.get("ephemeral")).toBe("hi");
    vi.advanceTimersByTime(31_000);
    expect(await kv.get("ephemeral")).toBeUndefined();
  });
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

  it("EVERY failable operation throws a GuueyStateError subclass — no bare TypeError/RangeError", async () => {
    const kv = createGuueyState({ context: CTX });
    // increment on a non-number key
    await kv.set("json-key", { a: 1 }, { ttl: 60 });
    await expect(
      kv.increment("json-key", { ttl: 60 }),
    ).rejects.toBeInstanceOf(TypeMismatchError);
    // keys() limit out of range / non-integer
    await expect(kv.keys({ limit: 0 })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    await expect(kv.keys({ limit: 1001 })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    await expect(kv.keys({ limit: 2.5 })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    // mget over the batch cap
    const tooMany = Array.from({ length: 101 }, (_, i) => `k:${i}`);
    await expect(kv.mget(tooMany)).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    // non-integer counter step
    await expect(
      kv.increment("counter", { ttl: 60, by: 0.5 }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    // non-JSON-serializable values (stringify returns undefined)
    await expect(kv.set("u", undefined, { ttl: 60 })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    await expect(
      kv.set("f", () => "nope", { ttl: 60 }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    // non-JSON-serializable values (stringify throws natively)
    interface Circular {
      self?: Circular;
    }
    const circular: Circular = {};
    circular.self = circular;
    await expect(kv.set("c", circular, { ttl: 60 })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    await expect(kv.set("b", 10n, { ttl: 60 })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });
});

describe("@guuey/state — mget prototype safety", () => {
  it('a key literally named "__proto__" round-trips through mget', async () => {
    const kv = createGuueyState({ context: CTX });
    await kv.set("__proto__", { isAdmin: true }, { ttl: 60 });
    await kv.set("normal", "ok", { ttl: 60 });
    const out = await kv.mget<unknown>(["__proto__", "normal"]);
    // The entry must exist as an OWN property with the stored value…
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(out["__proto__"]).toEqual({ isAdmin: true });
    expect(out["normal"]).toBe("ok");
    // …and must NOT have replaced the result object's prototype.
    expect((out as { isAdmin?: boolean }).isAdmin).toBeUndefined();
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

  it("scope keys cannot collide across (userId, mcpId) splits", async () => {
    // With a printable delimiter, {"a b","c"} and {"a","b c"} could
    // alias — the validator rejects whitespace, and the store uses a
    // NUL delimiter. Verify adjacent-looking ids stay isolated.
    const a = createGuueyState({ context: { userId: "a", mcpId: "b_c" } });
    const b = createGuueyState({ context: { userId: "a_b", mcpId: "c" } });
    await a.set("k", "from-a", { ttl: 60 });
    expect(await b.get("k")).toBeUndefined();
  });
});

describe("@guuey/state — byte accounting (audit 2026-07-20 round 2)", () => {
  it("counts UTF-8 bytes of key + value, not UTF-16 code units", async () => {
    const kv = createGuueyState({ context: CTX });
    // "🎉" is 2 UTF-16 units but 4 UTF-8 bytes.
    const emoji = "🎉".repeat(1000);
    await kv.set("emoji", emoji, { ttl: 60 });
    const info = await kv.scope();
    // 5 key bytes + 2 JSON quote bytes + 4000 emoji bytes.
    expect(info.usedBytes).toBe(5 + 2 + 4000);
  });

  it("key bytes count toward the scope quota (long keys can't dodge the cap)", async () => {
    const kv = createGuueyState({ context: CTX });
    // 1023-byte keys with 1-byte values: value bytes alone would say
    // "nearly empty"; key-inclusive accounting fills the 1 MiB cap
    // after ~1024 keys.
    const longKey = (i: number) => `k${String(i).padStart(4, "0")}`.padEnd(1023, "x");
    let threw: unknown;
    for (let i = 0; i < 1100; i++) {
      try {
        await kv.set(longKey(i), 1, { ttl: 60 });
      } catch (err) {
        threw = err;
        break;
      }
    }
    expect(threw).toBeInstanceOf(QuotaExceededError);
    const info = await kv.scope();
    expect(info.usedBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(info.usedBytes).toBeGreaterThan(1024 * 1000);
  });

  it("rejects a value whose UTF-8 size exceeds the cap even when .length does not", async () => {
    const kv = createGuueyState({ context: CTX });
    // 17k emoji = 34k UTF-16 units (under 64 KiB as .length) but
    // 68 KB UTF-8 (over the cap).
    const sneaky = "🎉".repeat(17 * 1024);
    await expect(kv.set("sneaky", sneaky, { ttl: 60 })).rejects.toBeInstanceOf(
      ValueTooLargeError,
    );
  });
});

describe("@guuey/state — audit regressions (2026-07-20)", () => {
  it("concurrent increments never lose updates (sync read-modify-write)", async () => {
    const kv = createGuueyState({ context: CTX });
    // Pre-fix, get-then-set across await points let all of these read
    // the same base and collapse to 1.
    const results = await Promise.all(
      Array.from({ length: 25 }, () => kv.increment("counter", { ttl: 60 })),
    );
    expect(await kv.get<number>("counter")).toBe(25);
    // Every intermediate value observed exactly once.
    expect([...results].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
  });

  it("expired keys stop counting toward the scope quota", async () => {
    vi.useFakeTimers();
    try {
      const kv = createGuueyState({ context: CTX });
      // ~896 KiB of payload under a 1 MiB scope cap, with a 1s TTL.
      const big = "x".repeat(63 * 1024);
      for (let i = 0; i < 14; i++) {
        await kv.set(`dead:${i}`, big, { ttl: 1 });
      }
      vi.advanceTimersByTime(2_000); // everything above is now expired
      // Pre-fix this threw QuotaExceededError: expired corpses still
      // summed into usedBytes.
      await kv.set("fresh", big, { ttl: 60 });
      expect(await kv.get("fresh")).toBe(big);
      const info = await kv.scope();
      expect(info.usedBytes).toBeLessThan(70 * 1024);
    } finally {
      vi.useRealTimers();
    }
  });

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
