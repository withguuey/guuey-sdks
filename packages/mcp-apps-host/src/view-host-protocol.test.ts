import { describe, expect, it } from "vitest";
import {
  diagnoseCspViolation,
  initializeResult,
  initialViewHostState,
  resourceReadResponse,
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
    resourceRelay: false,
    modelContextSink: false,
    messageSink: false,
    linkOpener: false,
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

describe("viewHostReceive — ui/open-link (guuey#522, the golden flip)", () => {
  it("a wired opener: a valid https ask answers {} FIRST and surfaces the open-link effect", () => {
    const { effects } = viewHostReceive(initialViewHostState(), behavior({ linkOpener: true }), {
      jsonrpc: "2.0",
      id: 9,
      method: "ui/open-link",
      params: { url: "https://docs.guuey.com/hosting" },
    });
    expect(effects).toHaveLength(2);
    const [respond, open] = effects;
    if (respond?.kind !== "respond") throw new Error("expected a response effect first");
    expect(respond.message.id).toBe(9);
    expect(respond.message.result).toEqual({});
    if (open?.kind !== "open-link") throw new Error("expected the open-link effect");
    expect(open.url).toBe("https://docs.guuey.com/hosting");
  });

  it("the scheme wall: javascript/data/mailto/relative/non-string refuse -32602 with ZERO effects beyond the answer", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "mailto:a@b.c", // platform-narrowed: http/https ONLY (#515 family)
      "/relative/path",
      42,
    ]) {
      const { effects } = viewHostReceive(initialViewHostState(), behavior({ linkOpener: true }), {
        jsonrpc: "2.0",
        id: 10,
        method: "ui/open-link",
        params: { url },
      });
      expect(effects).toHaveLength(1);
      const [effect] = effects;
      if (effect?.kind !== "respond") throw new Error("expected a response effect");
      expect(effect.message.error?.code).toBe(-32602);
      expect(effect.message.error?.message).toContain("http");
    }
  });

  it("an UNWIRED opener keeps today's honest refusal — opt-out is a choice, not an accident", () => {
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
    // (This pin's original example was size-changed; that notification now
    // legitimately surfaces an EFFECT for the embedder — see its own suite
    // — but the JSON-RPC rule stands: a notification never earns a respond.)
    const { state, effects } = viewHostReceive(initialViewHostState(), behavior(), {
      jsonrpc: "2.0",
      method: "ui/notifications/unknown-future-thing",
      params: { anything: true },
    });
    expect(effects).toEqual([]);
    expect(state).toEqual(initialViewHostState());

    const sized = viewHostReceive(initialViewHostState(), behavior(), {
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: 1, height: 1 },
    });
    expect(sized.effects.some((e) => e.kind === "respond")).toBe(false);
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

describe("viewHostReceive — size-changed (spec notification, App → Host)", () => {
  it("surfaces a finite width/height as a size-changed effect", () => {
    const { state, effects } = viewHostReceive(initialViewHostState(), behavior(), {
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: 320, height: 480 },
    });
    expect(state.phase).toBe("negotiating"); // a notification moves no phase
    expect(effects).toEqual([{ kind: "size-changed", width: 320, height: 480 }]);
  });

  it("surfaces a height-only report (the common transcript-card case)", () => {
    const { effects } = viewHostReceive(initialViewHostState(), behavior(), {
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 420 },
    });
    expect(effects).toEqual([{ kind: "size-changed", height: 420 }]);
  });

  it("consumes a malformed report silently — non-finite and non-numeric never surface", () => {
    for (const params of [{}, { width: "wide" }, { height: Infinity }, { height: NaN }]) {
      const { effects } = viewHostReceive(initialViewHostState(), behavior(), {
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params,
      });
      expect(effects).toEqual([]);
    }
  });
});

describe("viewHostReceive — resources/read (spec request, App → Host)", () => {
  const READ = {
    jsonrpc: "2.0",
    id: "read-1",
    method: "resources/read",
    params: { uri: "ui://tool/card.html" },
  };

  it("relays when the read hook is wired", () => {
    const { effects } = viewHostReceive(
      initialViewHostState(),
      behavior({ resourceRelay: true }),
      READ,
    );
    expect(effects).toEqual([
      { kind: "relay-resource-read", id: "read-1", uri: "ui://tool/card.html" },
    ]);
  });

  it("refuses in-band when no read hook is wired — never a hang", () => {
    const { effects } = viewHostReceive(initialViewHostState(), behavior(), READ);
    expect(effects).toHaveLength(1);
    const effect = effects[0]!;
    if (effect.kind !== "respond") throw new Error("expected an in-band refusal");
    expect(effect.message.id).toBe("read-1");
    expect(effect.message.error?.message).toContain("method_not_supported");
  });

  it("a uri-less read is refused, not relayed", () => {
    const { effects } = viewHostReceive(
      initialViewHostState(),
      behavior({ resourceRelay: true }),
      { jsonrpc: "2.0", id: 9, method: "resources/read", params: {} },
    );
    expect(effects).toHaveLength(1);
    expect(effects[0]!.kind).toBe("respond");
  });

  it("names every answered method in the refusal, capability-accurately", () => {
    const { effects } = viewHostReceive(
      initialViewHostState(),
      behavior({ toolRelay: true, resourceRelay: true }),
      { jsonrpc: "2.0", id: 2, method: "ui/unknown", params: {} },
    );
    const effect = effects[0]!;
    if (effect.kind !== "respond") throw new Error("expected a refusal");
    expect(effect.message.error?.message).toContain("tools/call");
    expect(effect.message.error?.message).toContain("resources/read");
  });
});

describe("resourceReadResponse", () => {
  it("wraps an entry as the spec's ReadResourceResult", () => {
    expect(
      resourceReadResponse("read-1", { uri: "ui://tool/card.html", text: "<p>hi</p>" }),
    ).toEqual({
      jsonrpc: "2.0",
      id: "read-1",
      result: { contents: [{ uri: "ui://tool/card.html", text: "<p>hi</p>" }] },
    });
  });

  it("answers a miss, a deny, and a failure with the ONE not-found error (deny == miss)", () => {
    const refusal = resourceReadResponse("read-1", undefined);
    expect(refusal.error).toEqual({ code: -32002, message: "resource unavailable" });
    expect(refusal.result).toBeUndefined();
  });
});

describe("diagnoseCspViolation — pure verdict (guuey#235)", () => {
  const origins = {
    resourceDomains: ["https://assets.mcp.example", "https://*.cdn.example"],
    connectDomains: ["https://mcp.example", "wss://mcp.example"],
    frameDomains: ["https://frames.example"],
  };

  it("matches a blocked URI on a declared origin and names the allowance (blocked origin under the effective directive)", () => {
    const d = diagnoseCspViolation(
      {
        blockedURI: "https://assets.mcp.example/runtime/v1.js?x=1",
        violatedDirective: "script-src",
        effectiveDirective: "script-src-elem",
      },
      origins,
    );
    expect(d).toMatchObject({
      blockedUri: "https://assets.mcp.example/runtime/v1.js?x=1",
      violatedDirective: "script-src-elem",
      suggestedEntry: "https://assets.mcp.example",
    });
    expect(d?.message).toContain("`script-src-elem https://assets.mcp.example`");
  });

  it("matches connect-src (https + wss) and frame-src declarations", () => {
    expect(
      diagnoseCspViolation({ blockedURI: "wss://mcp.example/live", violatedDirective: "connect-src" }, origins)
        ?.suggestedEntry,
    ).toBe("wss://mcp.example");
    expect(
      diagnoseCspViolation({ blockedURI: "https://frames.example/x", violatedDirective: "frame-src" }, origins)
        ?.suggestedEntry,
    ).toBe("https://frames.example");
  });

  it("matches wildcard subdomain declarations by suffix", () => {
    expect(
      diagnoseCspViolation({ blockedURI: "https://a.b.cdn.example/lib.js", violatedDirective: "script-src-elem" }, origins)
        ?.suggestedEntry,
    ).toBe("https://a.b.cdn.example");
    // The apex is NOT covered by `*.cdn.example` (CSP wildcard semantics).
    expect(
      diagnoseCspViolation({ blockedURI: "https://cdn.example/lib.js", violatedDirective: "script-src-elem" }, origins),
    ).toBeUndefined();
  });

  it("is undefined for violations that are NOT the view's: other hosts, bare policy tokens, no declaration", () => {
    expect(
      diagnoseCspViolation({ blockedURI: "https://analytics.other/x.js", violatedDirective: "script-src-elem" }, origins),
    ).toBeUndefined();
    // Bare tokens carry no host — `eval` here is exactly the zod v4 probe of guuey#236.
    for (const token of ["eval", "inline", "data", "blob"]) {
      expect(diagnoseCspViolation({ blockedURI: token, violatedDirective: "script-src" }, origins)).toBeUndefined();
    }
    expect(
      diagnoseCspViolation({ blockedURI: "https://assets.mcp.example/x.js", violatedDirective: "script-src-elem" }, undefined),
    ).toBeUndefined();
    expect(
      diagnoseCspViolation({ blockedURI: "https://assets.mcp.example/x.js", violatedDirective: "script-src-elem" }, {}),
    ).toBeUndefined();
  });

  it("ignores a malformed declared origin instead of throwing (producer wire data)", () => {
    expect(
      diagnoseCspViolation(
        { blockedURI: "https://assets.mcp.example/x.js", violatedDirective: "script-src-elem" },
        { resourceDomains: ["not a url", "https://assets.mcp.example"] },
      )?.suggestedEntry,
    ).toBe("https://assets.mcp.example");
  });
});


// ─── ui/update-model-context (guuey#335) ───────────────────────────────────
describe("ui/update-model-context", () => {
  it("with a sink wired: answers success AND emits the delivery effect", () => {
    const { effects } = viewHostReceive(
      initialViewHostState(),
      behavior({ modelContextSink: true }),
      {
        jsonrpc: "2.0",
        id: 16,
        method: "ui/update-model-context",
        params: { structuredContent: { slot: "tuesday-3pm" } },
      },
    );
    expect(effects).toEqual([
      { kind: "respond", message: { jsonrpc: "2.0", id: 16, result: {} } },
      { kind: "model-context-update", params: { structuredContent: { slot: "tuesday-3pm" } } },
    ]);
  });

  it("unwired: refuses in-band like every other unsupported method", () => {
    const { effects } = viewHostReceive(initialViewHostState(), behavior(), {
      jsonrpc: "2.0",
      id: 16,
      method: "ui/update-model-context",
      params: {},
    });
    expect(effects).toHaveLength(1);
    const only = effects[0];
    if (only?.kind !== "respond") throw new Error("expected a respond effect");
    expect(JSON.stringify(only.message)).toContain("method_not_supported");
  });

  it("the wired method joins the answered list in refusals of OTHER methods", () => {
    const { effects } = viewHostReceive(
      initialViewHostState(),
      behavior({ modelContextSink: true }),
      { jsonrpc: "2.0", id: 9, method: "ui/no-such-thing", params: {} },
    );
    const only = effects[0];
    if (only?.kind !== "respond") throw new Error("expected a respond effect");
    expect(JSON.stringify(only.message)).toContain("ui/update-model-context");
  });

  it("malformed params collapse to an empty bag — success + delivery, never a hang", () => {
    const { effects } = viewHostReceive(
      initialViewHostState(),
      behavior({ modelContextSink: true }),
      { jsonrpc: "2.0", id: 17, method: "ui/update-model-context", params: "nope" },
    );
    expect(effects[0]).toEqual({
      kind: "respond",
      message: { jsonrpc: "2.0", id: 17, result: {} },
    });
    expect(effects[1]).toEqual({ kind: "model-context-update", params: {} });
  });
});


// ─── ui/message (guuey#422) ────────────────────────────────────────────────
describe("ui/message", () => {
  it("with a sink wired: answers accepted AND emits the user-message effect", () => {
    const { effects } = viewHostReceive(
      initialViewHostState(),
      behavior({ messageSink: true }),
      {
        jsonrpc: "2.0",
        id: 31,
        method: "ui/message",
        params: { role: "user", content: [{ type: "text", text: "Call ggui_consume NOW…" }] },
      },
    );
    expect(effects[0]).toEqual({
      kind: "respond",
      message: { jsonrpc: "2.0", id: 31, result: {} },
    });
    expect(effects[1]).toEqual({
      kind: "user-message",
      id: 31,
      params: { role: "user", content: [{ type: "text", text: "Call ggui_consume NOW…" }] },
    });
  });

  it("unwired: refuses in-band — never a silent drop", () => {
    const { effects } = viewHostReceive(initialViewHostState(), behavior(), {
      jsonrpc: "2.0",
      id: 32,
      method: "ui/message",
      params: { role: "user", content: [] },
    });
    const only = effects[0];
    if (only?.kind !== "respond") throw new Error("expected respond");
    expect(JSON.stringify(only.message)).toContain("method_not_supported");
  });

  it("wired, the method joins the answered list in other refusals", () => {
    const { effects } = viewHostReceive(
      initialViewHostState(),
      behavior({ messageSink: true }),
      { jsonrpc: "2.0", id: 33, method: "ui/no-such", params: {} },
    );
    const only = effects[0];
    if (only?.kind !== "respond") throw new Error("expected respond");
    expect(JSON.stringify(only.message)).toContain("ui/message");
  });
});
