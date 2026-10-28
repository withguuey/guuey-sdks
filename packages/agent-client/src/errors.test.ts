/**
 * The refusal error's shape and the ONE place a non-OK `Response` becomes an
 * {@link AgentResponseError}: status, the pod's `{ code, message }`, the
 * `Retry-After` hint, and the waking marker (`X-Guuey-Waking: 1` on a 503).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgentResponseError,
  WAKING_HEADER,
  agentResponseErrorFrom,
  hasWakingMarker,
  isWakingRefusal,
  parseRetryAfterSeconds,
} from "./errors.js";
import { AGENT_ERROR_CODES } from "./error-codes.js";

/** A waking answer as the wake path sends it: 503, no body, the marker, a hint. */
function wakingResponse(retryAfter = "10", marker = "1"): Response {
  return new Response(null, {
    status: 503,
    headers: { [WAKING_HEADER]: marker, "Retry-After": retryAfter },
  });
}

describe("AgentResponseError — waking", () => {
  it("is unset unless the constructor says otherwise: every existing call shape reads as not waking", () => {
    for (const err of [
      new AgentResponseError("x", 503),
      new AgentResponseError("x", 503, undefined, 10),
      new AgentResponseError("x", 0, "WIDGET_UNREACHABLE"),
    ]) {
      expect(err.waking).toBeUndefined();
      expect(isWakingRefusal(err)).toBe(false);
    }
  });

  it("carries waking through its constructor", () => {
    const err = new AgentResponseError("agent responded 503", 503, undefined, 10, true);
    expect(err.waking).toBe(true);
    expect(err.retryAfterSeconds).toBe(10);
    expect(err.status).toBe(503);
    expect(err.code).toBeUndefined();
  });
});

describe("isWakingRefusal", () => {
  it("matches only an envelope-less 503 that carried the marker", () => {
    expect(isWakingRefusal(new AgentResponseError("x", 503, undefined, 10, true))).toBe(true);
  });

  it("never matches on the status alone: a plain 503 is the cold-start shape, not a wake", () => {
    expect(isWakingRefusal(new AgentResponseError("x", 503))).toBe(false);
    expect(isWakingRefusal(new AgentResponseError("x", 503, undefined, 10))).toBe(false);
  });

  it("a coded answer is the pod refusing, never a wake, even with the marker", () => {
    expect(
      isWakingRefusal(new AgentResponseError("x", 503, AGENT_ERROR_CODES.POD_SATURATED, 5, true)),
    ).toBe(false);
  });

  it("is false for anything that is not the error class", () => {
    expect(isWakingRefusal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isWakingRefusal(null)).toBe(false);
  });
});

describe("agentResponseErrorFrom — the one Response → error builder", () => {
  it("reads the pod's code, message, status and Retry-After hint", async () => {
    const err = await agentResponseErrorFrom(
      new Response(JSON.stringify({ code: "QUOTA_EXCEEDED", message: "plan limit" }), {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    );
    expect(err).toBeInstanceOf(AgentResponseError);
    expect(err.message).toBe("plan limit");
    expect(err.status).toBe(429);
    expect(err.code).toBe("QUOTA_EXCEEDED");
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.waking).toBe(false);
  });

  it("falls back to the bare status for a body that is not JSON", async () => {
    const err = await agentResponseErrorFrom(new Response("Service Unavailable", { status: 503 }));
    expect(err.message).toBe("agent responded 503");
    expect(err.code).toBeUndefined();
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.waking).toBe(false);
  });

  it("reads the waking marker off a 503 with no body", async () => {
    const err = await agentResponseErrorFrom(wakingResponse("10"));
    expect(err.status).toBe(503);
    expect(err.code).toBeUndefined();
    expect(err.retryAfterSeconds).toBe(10);
    expect(err.waking).toBe(true);
    expect(isWakingRefusal(err)).toBe(true);
  });

  it("the marker's name is case-insensitive on the wire, as every header is", async () => {
    const err = await agentResponseErrorFrom(
      new Response(null, { status: 503, headers: { "x-guuey-waking": "1" } }),
    );
    expect(err.waking).toBe(true);
  });

  it("only the value 1 is the marker", async () => {
    expect((await agentResponseErrorFrom(wakingResponse("10", "0"))).waking).toBe(false);
    expect((await agentResponseErrorFrom(wakingResponse("10", "yes"))).waking).toBe(false);
  });

  it("the marker on anything but a 503 is not a wake", async () => {
    const err = await agentResponseErrorFrom(
      new Response(null, { status: 502, headers: { [WAKING_HEADER]: "1" } }),
    );
    expect(err.waking).toBe(false);
  });
});

describe("hasWakingMarker", () => {
  it("reads the marker off the headers alone, leaving the body unread", () => {
    const res = new Response(JSON.stringify({ code: "DRAINING" }), {
      status: 503,
      headers: { [WAKING_HEADER]: " 1 " },
    });
    expect(hasWakingMarker(res)).toBe(true);
    expect(res.bodyUsed).toBe(false);
  });

  it("is false without the marker, with another value, or on another status", () => {
    expect(hasWakingMarker(new Response(null, { status: 503 }))).toBe(false);
    expect(hasWakingMarker(wakingResponse("10", "0"))).toBe(false);
    expect(hasWakingMarker(new Response(null, { status: 502, headers: { [WAKING_HEADER]: "1" } }))).toBe(false);
  });
});

describe("parseRetryAfterSeconds", () => {
  it("reads whole seconds and nothing else", () => {
    expect(parseRetryAfterSeconds("10")).toBe(10);
    expect(parseRetryAfterSeconds(" 7 ")).toBe(7);
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds("1.5")).toBeUndefined();
    expect(parseRetryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
  });
});

describe("one construction path", () => {
  it("no module but errors.ts builds an AgentResponseError: every transport goes through agentResponseErrorFrom", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const builders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "errors.ts")
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("new AgentResponseError("));
    expect(builders).toEqual([]);
  });
});
