import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GuueyStateError,
  HttpKv,
  InvalidArgumentError,
  InvalidContextError,
  InvalidKeyError,
  InvalidTtlError,
  MissingContextError,
  QuotaExceededError,
  TransportError,
  TypeMismatchError,
  ValueTooLargeError,
  createGuueyState,
  getCurrentContext,
  kv as alsKv,
  mcpIdFromResourceUrl,
  scopeFromAuthorization,
  withGuueyContext,
} from "./index.js";
import { __resetInMemoryStoreForTests } from "./in-memory.js";
import { runKvContractSuite } from "./testing/contract-suite.js";

/** Base64url-encode a JSON payload into a (fake, unsigned) JWT-shaped string. */
function fakeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

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
  it("requesting the hosted binding without a token fails loud (no silent in-memory)", () => {
    // Pre-fix, bindingUrl/GUUEY_KV_URL silently returned the in-memory
    // store — an operator following the old warning's instruction got
    // non-durable storage with zero signal. Post-fix: the hosted
    // binding is real, but still refuses to hand back in-memory —
    // now it requires a token instead.
    expect(() =>
      createGuueyState({ context: CTX, bindingUrl: "https://kv.example" }),
    ).toThrow(InvalidContextError);
    process.env.GUUEY_KV_URL = "https://kv.example";
    try {
      expect(() => createGuueyState({ context: CTX })).toThrow(
        InvalidContextError,
      );
    } finally {
      delete process.env.GUUEY_KV_URL;
    }
  });

  it("returns an HttpKv when bindingUrl + a token are both present", () => {
    const viaAuthToken = createGuueyState({
      context: CTX,
      bindingUrl: "https://kv.example",
      authToken: "tok_explicit",
    });
    expect(viaAuthToken).toBeInstanceOf(HttpKv);

    const viaContextToken = createGuueyState({
      context: { ...CTX, token: "tok_from_context" },
      bindingUrl: "https://kv.example",
    });
    expect(viaContextToken).toBeInstanceOf(HttpKv);
  });
});

describe("@guuey/state — scopeFromAuthorization", () => {
  const AUD = "HTTPS://Api.Example.com:443/mcp/";

  it("derives a ScopeContext from a valid Bearer JWT", () => {
    const token = fakeJwt({ sub: "u_from_jwt", aud: AUD });
    const ctx = scopeFromAuthorization(`Bearer ${token}`);
    expect(ctx.userId).toBe("u_from_jwt");
    expect(ctx.mcpId).toBe(mcpIdFromResourceUrl(AUD));
    expect(ctx.mcpId).toMatch(/^mcp_[0-9a-f]{32}$/);
    expect(ctx.token).toBe(token);
  });

  it("accepts an array-valued aud claim (first entry wins)", () => {
    const token = fakeJwt({ sub: "u_multi_aud", aud: [AUD, "https://other.example"] });
    const ctx = scopeFromAuthorization(`Bearer ${token}`);
    expect(ctx.mcpId).toBe(mcpIdFromResourceUrl(AUD));
  });

  it("is case-insensitive on the 'Bearer' scheme and tolerates surrounding whitespace", () => {
    const token = fakeJwt({ sub: "u_x", aud: AUD });
    const ctx = scopeFromAuthorization(`  bearer ${token}  `);
    expect(ctx.userId).toBe("u_x");
  });

  it("rejects a non-Bearer authorization header", () => {
    expect(() => scopeFromAuthorization("Basic dXNlcjpwYXNz")).toThrow(
      InvalidContextError,
    );
  });

  it("rejects a malformed JWT (wrong segment count)", () => {
    expect(() => scopeFromAuthorization("Bearer not.a.jwt.at.all")).toThrow(
      InvalidContextError,
    );
    expect(() => scopeFromAuthorization("Bearer onlyonesegment")).toThrow(
      InvalidContextError,
    );
  });

  it("rejects a JWT whose payload segment is not valid JSON", () => {
    const bogus = `${Buffer.from("{}").toString("base64url")}.not-json.sig`;
    expect(() => scopeFromAuthorization(`Bearer ${bogus}`)).toThrow(
      InvalidContextError,
    );
  });

  it("rejects a JWT with no sub claim", () => {
    const token = fakeJwt({ aud: AUD });
    expect(() => scopeFromAuthorization(`Bearer ${token}`)).toThrow(
      InvalidContextError,
    );
  });

  it("rejects a JWT with no aud claim", () => {
    const token = fakeJwt({ sub: "u_no_aud" });
    expect(() => scopeFromAuthorization(`Bearer ${token}`)).toThrow(
      InvalidContextError,
    );
  });
});

describe("@guuey/state — mcpIdFromResourceUrl", () => {
  it("canonicalizes scheme, host casing, default port, and trailing slash identically", () => {
    const a = mcpIdFromResourceUrl("HTTPS://Api.Example.com:443/mcp/");
    const b = mcpIdFromResourceUrl("https://api.example.com/mcp");
    expect(a).toBe(b);
  });

  it("drops query and fragment from the canonical form", () => {
    const a = mcpIdFromResourceUrl("https://api.example.com/mcp?x=1#frag");
    const b = mcpIdFromResourceUrl("https://api.example.com/mcp");
    expect(a).toBe(b);
  });

  it("treats distinct hosts/paths as distinct scopes", () => {
    const a = mcpIdFromResourceUrl("https://api.example.com/mcp");
    const b = mcpIdFromResourceUrl("https://api.example.com/other");
    expect(a).not.toBe(b);
  });
});

describe("@guuey/state — HttpKv", () => {
  const BASE = "https://kv.example";
  const TOKEN = "tok_abc";

  function makeHttpKv(fetchImpl: typeof fetch): HttpKv {
    return new HttpKv(BASE, CTX, TOKEN, fetchImpl);
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("sends the request envelope and returns the unwrapped result on success", async () => {
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe(`${BASE}/v1/state/get`);
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
      const body = JSON.parse(String(init?.body)) as {
        context: { userId: string; mcpId: string };
        args: { key: string };
      };
      expect(body.context).toEqual({ userId: CTX.userId, mcpId: CTX.mcpId });
      expect(body.args).toEqual({ key: "hello" });
      return jsonResponse(200, { result: "world" });
    });
    const kv = makeHttpKv(fetchImpl);
    expect(await kv.get("hello")).toBe("world");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps each error code to its typed error class", async () => {
    const cases: Array<{ code: string; fields: Record<string, unknown>; expected: unknown }> = [
      {
        code: "QUOTA_EXCEEDED",
        fields: { usedBytes: 2_000_000, limitBytes: 1_048_576 },
        expected: QuotaExceededError,
      },
      {
        code: "VALUE_TOO_LARGE",
        fields: { valueBytes: 100_000, limitBytes: 65_536 },
        expected: ValueTooLargeError,
      },
      { code: "INVALID_KEY", fields: { key: "bad key", reason: "bad" }, expected: InvalidKeyError },
      { code: "INVALID_TTL", fields: { ttl: -1, reason: "bad" }, expected: InvalidTtlError },
      {
        code: "TYPE_MISMATCH",
        fields: { key: "k", actualType: "string" },
        expected: TypeMismatchError,
      },
      { code: "INVALID_ARGUMENT", fields: { reason: "bad arg" }, expected: InvalidArgumentError },
      {
        code: "INVALID_CONTEXT",
        fields: { field: "mcpId", reason: "bad" },
        expected: InvalidContextError,
      },
      { code: "MISSING_CONTEXT", fields: {}, expected: MissingContextError },
      { code: "SOME_UNKNOWN_CODE", fields: {}, expected: TransportError },
    ];
    for (const { code, fields, expected } of cases) {
      const fetchImpl: typeof fetch = vi.fn(async () =>
        jsonResponse(400, { code, message: "boom", ...fields }),
      );
      const kv = makeHttpKv(fetchImpl);
      await expect(kv.get("k")).rejects.toBeInstanceOf(expected);
    }
  });

  it("maps 401/403 to TransportError regardless of body", async () => {
    for (const status of [401, 403]) {
      const fetchImpl: typeof fetch = vi.fn(async () =>
        jsonResponse(status, { code: "QUOTA_EXCEEDED", message: "unauthorized" }),
      );
      const kv = makeHttpKv(fetchImpl);
      await expect(kv.get("k")).rejects.toBeInstanceOf(TransportError);
    }
  });

  it("retries a read once on a 5xx response, then throws the typed error", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      calls += 1;
      return jsonResponse(500, { code: "TRANSPORT", message: "server exploded" });
    });
    const kv = makeHttpKv(fetchImpl);
    await expect(kv.get("k")).rejects.toBeInstanceOf(TransportError);
    expect(calls).toBe(2);
  });

  it("succeeds on the retried attempt after one 5xx", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(500, { code: "TRANSPORT", message: "blip" });
      return jsonResponse(200, { result: true });
    });
    const kv = makeHttpKv(fetchImpl);
    expect(await kv.has("k")).toBe(true);
    expect(calls).toBe(2);
  });

  it("does NOT retry a write on a 5xx response", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      calls += 1;
      return jsonResponse(500, { code: "TRANSPORT", message: "server exploded" });
    });
    const kv = makeHttpKv(fetchImpl);
    await expect(kv.set("k", "v", { ttl: 60 })).rejects.toBeInstanceOf(TransportError);
    expect(calls).toBe(1);
  });

  it("wraps a read network failure in TransportError after one retry", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    });
    const kv = makeHttpKv(fetchImpl);
    await expect(kv.get("k")).rejects.toBeInstanceOf(TransportError);
    expect(calls).toBe(2);
  });

  it("wraps a write network failure in TransportError with NO retry", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    });
    const kv = makeHttpKv(fetchImpl);
    await expect(kv.delete("k")).rejects.toBeInstanceOf(TransportError);
    expect(calls).toBe(1);
  });

  it("validates key/ttl client-side before ever calling fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const kv = makeHttpKv(fetchImpl);
    await expect(kv.get("")).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(kv.set("ok-key", "v", { ttl: -1 })).rejects.toBeInstanceOf(
      InvalidTtlError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
