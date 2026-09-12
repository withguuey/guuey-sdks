/**
 * guuey#158 — the action relay's two invariants: never throw into the
 * sandbox bridge, and never forward an un-narrowed wire arm.
 */
import { describe, expect, it, vi } from "vitest";
import {
  asToolCallResult,
  createMcpUiActionRelay,
  PULL_CIRCUIT_THRESHOLD,
  UI_ACTION_PULL_CIRCUIT_OPEN,
  UI_ACTION_TOOLS,
  UI_ACTION_UNAVAILABLE_TEXT,
  UI_SEMANTIC_ACTION_TOOLS,
} from "./action.js";

const URI = "ui://ggui/render/sess-1/hash-1";
const TOOL = "ggui_runtime_submit_action";

describe("asToolCallResult", () => {
  it("narrows the three wire arms and passes isError/structuredContent through", () => {
    const out = asToolCallResult({
      content: [
        { type: "text", text: "ok" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "resource", resource: { uri: "ui://x", mimeType: "text/html", text: "<p>" } },
        { type: "resource", resource: { uri: "ui://y", blob: "aGk=" } },
      ],
      isError: true,
      structuredContent: { done: true },
    });
    expect(out).toEqual({
      content: [
        { type: "text", text: "ok" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "resource", resource: { uri: "ui://x", mimeType: "text/html", text: "<p>" } },
        { type: "resource", resource: { uri: "ui://y", blob: "aGk=" } },
      ],
      isError: true,
      structuredContent: { done: true },
    });
  });

  it("DROPS unknown or malformed arms rather than forwarding them opaque", () => {
    const out = asToolCallResult({
      content: [
        { type: "text", text: "kept" },
        { type: "audio", data: "x" },
        { type: "text" },
        { type: "resource", resource: { uri: "ui://z" } },
        "not-an-object",
      ],
    });
    expect(out).toEqual({ content: [{ type: "text", text: "kept" }] });
  });

  it("is undefined for non-result shapes (string, null, missing content)", () => {
    expect(asToolCallResult("nope")).toBeUndefined();
    expect(asToolCallResult(null)).toBeUndefined();
    expect(asToolCallResult({ isError: true })).toBeUndefined();
    expect(asToolCallResult({ content: "not-array" })).toBeUndefined();
  });
});

describe("createMcpUiActionRelay", () => {
  const request = { resourceUri: URI, name: TOOL, arguments: { actionId: "t" } };

  it("relays an allowed tool through the transport, bound to the locator", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
    const relay = createMcpUiActionRelay({ callTool });
    const out = await relay(request);
    expect(out).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(callTool).toHaveBeenCalledWith(URI, TOOL, { actionId: "t" });
  });

  // guuey#220: the iframe-runtime rides the SAME relay for its transport
  // rungs — the credential refresh (wsToken TTL 180 s) and the bridge-pull
  // polling rung. Admitting only submit_action killed views on SSE/polling
  // at 180 s (410s on /events + /stream, seen live on the ggui landing).
  it("relays ggui's transport rungs too — refresh_ws_token and pull are relayable (#220)", async () => {
    for (const name of ["ggui_runtime_refresh_ws_token", "ggui_runtime_pull"]) {
      const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
      const relay = createMcpUiActionRelay({ callTool });
      const out = await relay({ resourceUri: URI, name, arguments: { sessionId: "sess-1" } });
      expect(out.isError).toBeUndefined();
      expect(callTool).toHaveBeenCalledWith(URI, name, { sessionId: "sess-1" });
    }
  });

  it("keeps relayable ≠ semantic: only submit_action is a user gesture (#218/#220 interlock)", () => {
    expect([...UI_ACTION_TOOLS].sort()).toEqual([
      "ggui_runtime_pull",
      "ggui_runtime_refresh_ws_token",
      "ggui_runtime_submit_action",
    ]);
    expect([...UI_SEMANTIC_ACTION_TOOLS]).toEqual(["ggui_runtime_submit_action"]);
    // Structural: every semantic tool is relayable, never the reverse.
    for (const name of UI_SEMANTIC_ACTION_TOOLS) expect(UI_ACTION_TOOLS.has(name)).toBe(true);
    expect(UI_SEMANTIC_ACTION_TOOLS.has("ggui_runtime_pull")).toBe(false);
    expect(UI_SEMANTIC_ACTION_TOOLS.has("ggui_runtime_refresh_ws_token")).toBe(false);
  });

  it("answers in-band unavailable for a tool outside the allowlist — transport never fires", async () => {
    const callTool = vi.fn();
    const relay = createMcpUiActionRelay({ callTool });
    const out = await relay({ ...request, name: "shell_exec" });
    expect(out.isError).toBe(true);
    expect(out.content).toEqual([{ type: "text", text: UI_ACTION_UNAVAILABLE_TEXT }]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("answers in-band unavailable for a non-ui:// locator — transport never fires", async () => {
    const callTool = vi.fn();
    const relay = createMcpUiActionRelay({ callTool });
    const out = await relay({ ...request, resourceUri: "https://evil.example/x" });
    expect(out.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("NEVER rejects: transport throw, undefined, and un-narrowable answers all collapse in-band", async () => {
    for (const callTool of [
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      vi.fn(async () => undefined),
      vi.fn(async () => "garbage"),
    ]) {
      const relay = createMcpUiActionRelay({ callTool });
      const out = await relay(request);
      expect(out.isError).toBe(true);
      expect(out.content[0]).toEqual({ type: "text", text: UI_ACTION_UNAVAILABLE_TEXT });
    }
  });
});


describe("createMcpUiActionRelay — ggui_runtime_pull circuit break (guuey#1235 leg 1)", () => {
  const PULL = "ggui_runtime_pull";
  const URI2 = "ui://ggui/render/sess-2/hash-2";

  it("OPENS after N consecutive unavailable pulls and stops calling the transport", async () => {
    const callTool = vi.fn(async () => undefined); // dead session: every pull is unavailable
    const relay = createMcpUiActionRelay({ callTool });
    for (let i = 0; i < PULL_CIRCUIT_THRESHOLD + 3; i += 1) {
      const res = await relay({ resourceUri: URI, name: PULL, arguments: {} });
      expect(res.isError).toBe(true);
    }
    // Only the first N reached the door; every later poll short-circuited.
    expect(callTool).toHaveBeenCalledTimes(PULL_CIRCUIT_THRESHOLD);
  });

  it("a single good pull result CLOSES the circuit (reset — no trip)", async () => {
    let ok = false;
    const callTool = vi.fn(async () =>
      ok ? { content: [{ type: "text", text: "live" }] } : undefined,
    );
    const relay = createMcpUiActionRelay({ callTool });
    await relay({ resourceUri: URI, name: PULL, arguments: {} }); // 1 unavailable
    await relay({ resourceUri: URI, name: PULL, arguments: {} }); // 2 unavailable
    ok = true;
    await relay({ resourceUri: URI, name: PULL, arguments: {} }); // success → reset
    ok = false;
    await relay({ resourceUri: URI, name: PULL, arguments: {} }); // 1 unavailable
    await relay({ resourceUri: URI, name: PULL, arguments: {} }); // 2 unavailable
    // Never 3-consecutive, so the door was hit every time.
    expect(callTool).toHaveBeenCalledTimes(5);
  });

  it("only the pull rung is counted — a failed gesture/refresh never trips the pull", async () => {
    const callTool = vi.fn(async () => undefined);
    const relay = createMcpUiActionRelay({ callTool });
    // Many failed gestures + refreshes on the same locator…
    for (let i = 0; i < 5; i += 1) {
      await relay({ resourceUri: URI, name: "ggui_runtime_submit_action", arguments: {} });
      await relay({ resourceUri: URI, name: "ggui_runtime_refresh_ws_token", arguments: {} });
    }
    callTool.mockClear();
    // …the pull circuit is still CLOSED: this pull reaches the door.
    await relay({ resourceUri: URI, name: PULL, arguments: {} });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("the circuit is per-locator — one card's dead pull does not gate another's", async () => {
    const callTool = vi.fn(async (uri: string) =>
      uri === URI ? undefined : { content: [{ type: "text", text: "live" }] },
    );
    const relay = createMcpUiActionRelay({ callTool });
    for (let i = 0; i < PULL_CIRCUIT_THRESHOLD + 2; i += 1) {
      await relay({ resourceUri: URI, name: PULL, arguments: {} }); // trips URI
    }
    callTool.mockClear();
    const res = await relay({ resourceUri: URI2, name: PULL, arguments: {} }); // URI2 untouched
    expect(callTool).toHaveBeenCalledWith(URI2, PULL, {});
    expect(res.isError).toBeFalsy();
  });

  it("logs UI_ACTION_PULL_CIRCUIT_OPEN ONCE, at the trip", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const callTool = vi.fn(async () => undefined);
      const relay = createMcpUiActionRelay({ callTool });
      for (let i = 0; i < PULL_CIRCUIT_THRESHOLD + 4; i += 1) {
        await relay({ resourceUri: URI, name: PULL, arguments: {} });
      }
      const opens = warn.mock.calls.filter((c) => c[0] === UI_ACTION_PULL_CIRCUIT_OPEN);
      expect(opens).toHaveLength(1);
      expect(opens[0]?.[1]).toMatchObject({ resourceUri: URI, consecutiveUnavailable: PULL_CIRCUIT_THRESHOLD });
    } finally {
      warn.mockRestore();
    }
  });
});
