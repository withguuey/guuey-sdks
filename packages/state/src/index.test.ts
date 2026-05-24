import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GuueyStateError,
  InvalidKeyError,
  InvalidTtlError,
  MissingContextError,
  QuotaExceededError,
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
    expect(await kv.keys()).toEqual(
      expect.arrayContaining(["user:1", "user:2", "post:1"]),
    );
    expect((await kv.keys({ prefix: "user:" })).sort()).toEqual([
      "user:1",
      "user:2",
    ]);
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
