import { describe, expect, it } from "vitest";
import {
  initializeResult,
  initialViewHostState,
  teardownMessage,
  toolCallResponse,
  viewHostElapsed,
  viewHostReceive,
  type ViewHostBehavior,
  type ViewHostState,
} from "./view-host-protocol.js";

// The machine must be exercisable with zero DOM — this suite runs in
// vitest's node environment on purpose (the publish gate is Node-only;
// see the module docblock). Any accidental `window`/`navigator` reach
// in the module throws here.

function behavior(overrides: Partial<ViewHostBehavior> = {}): ViewHostBehavior {
  return {
    hostInfo: { name: "test-host", version: "0" },
    hostCapabilities: {},
    hostContext: { locale: "en-US" },
    toolRelay: false,
    ...overrides,
  };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "ui/initialize",
  params: {
    appInfo: { name: "view", version: "1" },
    appCapabilities: {},
    protocolVersion: "2026-01-26",
  },
};

describe("viewHostReceive — the handshake", () => {
  it("answers ui/initialize spec-canonically and connects", () => {
    const { state, effects } = viewHostReceive(initialViewHostState(), behavior(), INITIALIZE);
    expect(state.phase).toBe("connected");
    expect(effects).toEqual([
      {
        kind: "respond",
        message: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "test-host", version: "0" },
            hostCapabilities: {},
            hostContext: { locale: "en-US" },
          },
        },
      },
    ]);
  });

  it("echoes the version the view asked for", () => {
    const result = initializeResult(behavior(), "2025-11-21");
    expect(result.protocolVersion).toBe("2025-11-21");
  });

  it("answers with the latest spec version when the request names none", () => {
    expect(initializeResult(behavior(), undefined).protocolVersion).toBe("2026-01-26");
    expect(initializeResult(behavior(), "").protocolVersion).toBe("2026-01-26");
    expect(initializeResult(behavior(), 7).protocolVersion).toBe("2026-01-26");
  });

  it("advertises exactly the configured capabilities and context", () => {
    const { effects } = viewHostReceive(
      initialViewHostState(),
      behavior({
        hostCapabilities: { serverTools: {} },
        hostContext: { locale: "ko-KR", containerDimensions: { width: 320, height: 240 } },
      }),
      INITIALIZE,
    );
    const [effect] = effects;
    if (effect?.kind !== "respond" || effect.message.result === undefined) {
      throw new Error("expected an initialize response");
    }
    expect(effect.message.result["hostCapabilities"]).toEqual({ serverTools: {} });
    expect(effect.message.result["hostContext"]).toEqual({
      locale: "ko-KR",
      containerDimensions: { width: 320, height: 240 },
    });
  });

  it("still answers a late handshake after the window lapsed — the timeout labels, it does not lock", () => {
    const lapsed = viewHostElapsed(initialViewHostState());
    expect(lapsed.phase).toBe("no-handshake");
    const { state, effects } = viewHostReceive(lapsed, behavior(), INITIALIZE);
    expect(state.phase).toBe("connected");
    expect(effects).toHaveLength(1);
  });
});

describe("viewHostReceive — refusals and silence", () => {
  it("refuses an unknown request honestly with the spec's method-not-found code", () => {
    const { state, effects } = viewHostReceive(initialViewHostState(), behavior(), {
      jsonrpc: "2.0",
      id: 9,
      method: "ui/open-link",
      params: { url: "https://example.com" },
    });
    expect(state.phase).toBe("negotiating");
    const [effect] = effects;
    if (effect?.kind !== "respond") throw new Error("expected a response effect");
    expect(effect.message.id).toBe(9);
    expect(effect.message.error?.code).toBe(-32601);
    expect(effect.message.error?.message).toContain("ui/open-link");
  });

  it("consumes notifications silently — JSON-RPC notifications never get a response", () => {
    const { state, effects } = viewHostReceive(initialViewHostState(), behavior(), {
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: 1, height: 1 },
    });
    expect(effects).toEqual([]);
    expect(state).toEqual(initialViewHostState());
  });

  it("remembers the initialized ack on the state", () => {
    const { state } = viewHostReceive(initialViewHostState(), behavior(), {
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });
    expect(state.initializedSeen).toBe(true);
  });

  it.each([
    ["a string", "hello"],
    ["null", null],
    ["an array", [1, 2]],
    ["a non-RPC object", { type: "ggui:bootstrap-failed", reason: "x" }],
    ["jsonrpc 1.0 chatter", { jsonrpc: "1.0", id: 1, method: "ui/initialize" }],
    ["a methodless envelope", { jsonrpc: "2.0", id: 1 }],
  ])("ignores %s — not ours, not an error", (_label, data) => {
    const { state, effects } = viewHostReceive(initialViewHostState(), behavior(), data);
    expect(effects).toEqual([]);
    expect(state).toEqual(initialViewHostState());
  });
});

describe("viewHostReceive — the tools/call relay boundary", () => {
  const CALL = {
    jsonrpc: "2.0",
    id: "call-1",
    method: "tools/call",
    params: { name: "ggui_runtime_submit_action", arguments: { value: 1 } },
  };

  it("refuses tools/call in-band when no relay is wired (privilege off by default)", () => {
    const { effects } = viewHostReceive(initialViewHostState(), behavior(), CALL);
    const [effect] = effects;
    if (effect?.kind !== "respond") throw new Error("expected a refusal");
    expect(effect.message.error?.code).toBe(-32601);
  });

  it("emits the relay effect when a relay is wired", () => {
    const { effects } = viewHostReceive(
      initialViewHostState(),
      behavior({ toolRelay: true }),
      CALL,
    );
    expect(effects).toEqual([
      {
        kind: "relay-tool-call",
        id: "call-1",
        name: "ggui_runtime_submit_action",
        arguments: { value: 1 },
      },
    ]);
  });

  it("relays an argumentless call without inventing arguments", () => {
    const { effects } = viewHostReceive(initialViewHostState(), behavior({ toolRelay: true }), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ggui_runtime_submit_action" },
    });
    expect(effects).toEqual([
      { kind: "relay-tool-call", id: 2, name: "ggui_runtime_submit_action" },
    ]);
  });

  it("refuses a nameless tools/call rather than relaying garbage", () => {
    const { effects } = viewHostReceive(initialViewHostState(), behavior({ toolRelay: true }), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {},
    });
    const [effect] = effects;
    if (effect?.kind !== "respond") throw new Error("expected a refusal");
    expect(effect.message.error?.code).toBe(-32601);
  });
});

describe("viewHostElapsed", () => {
  it("lapses only from negotiating", () => {
    expect(viewHostElapsed(initialViewHostState()).phase).toBe("no-handshake");
    const connected: ViewHostState = { phase: "connected", initializedSeen: false };
    expect(viewHostElapsed(connected)).toBe(connected);
    const lapsed: ViewHostState = { phase: "no-handshake", initializedSeen: false };
    expect(viewHostElapsed(lapsed)).toBe(lapsed);
  });
});

describe("outbound builders", () => {
  it("builds the tools/call response envelope", () => {
    expect(toolCallResponse("call-1", { content: [] })).toEqual({
      jsonrpc: "2.0",
      id: "call-1",
      result: { content: [] },
    });
  });

  it("builds the id-less teardown farewell (a notification, by JSON-RPC rules)", () => {
    const farewell = teardownMessage();
    expect(farewell).toEqual({ jsonrpc: "2.0", method: "ui/resource-teardown", params: {} });
    expect("id" in farewell).toBe(false);
  });
});
