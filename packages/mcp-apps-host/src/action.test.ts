/**
 * guuey#158 — the action relay's two invariants: never throw into the
 * sandbox bridge, and never forward an un-narrowed wire arm.
 */
import { describe, expect, it, vi } from "vitest";
import {
  admittedTelemetryArguments,
  asToolCallResult,
  createMcpUiActionRelay,
  isAdmittedRenderFailureReport,
  MAX_UI_RENDER_FAILURE_CATCHES,
  MAX_UI_RENDER_FAILURE_ID_CHARS,
  MAX_UI_TELEMETRY_EVENTS,
  PULL_CIRCUIT_THRESHOLD,
  UI_ACTION_HOST_CALLBACK_THREW,
  UI_ACTION_PULL_CIRCUIT_CLOSED,
  UI_ACTION_PULL_CIRCUIT_OPEN,
  UI_ACTION_TOOLS,
  UI_ACTION_UNAVAILABLE_TEXT,
  UI_RENDER_FAILURE_PHASES,
  UI_RENDER_FAILURE_TOOL,
  UI_SEMANTIC_ACTION_TOOLS,
  UI_TELEMETRY_KINDS,
  UI_TELEMETRY_TOOL,
} from "./action.js";

const URI = "ui://ggui/render/sess-1/hash-1";

/** A host's own error: its name is logged, its text never is. */
class HostBug extends Error {
  override name = "HostBug";
}
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
      "ggui_runtime_report_render_failure",
      "ggui_runtime_submit_action",
      "ggui_runtime_telemetry",
    ]);
    expect([...UI_SEMANTIC_ACTION_TOOLS]).toEqual(["ggui_runtime_submit_action"]);
    expect(UI_SEMANTIC_ACTION_TOOLS.has("ggui_runtime_telemetry")).toBe(false);
    expect(UI_SEMANTIC_ACTION_TOOLS.has("ggui_runtime_report_render_failure")).toBe(false);
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

  it("while closed, an in-band refusal is a door that answered: it ends the run of unavailable pulls (guuey#1978)", async () => {
    let refused = false;
    const callTool = vi.fn(async () =>
      refused ? { content: [{ type: "text", text: "session_not_found: gone" }], isError: true } : undefined,
    );
    const unrestorable: string[] = [];
    const relay = createMcpUiActionRelay({ callTool, onSessionUnrestorable: (uri) => unrestorable.push(uri) });
    await relay({ resourceUri: URI, name: PULL, arguments: {} }); // 1 unavailable
    await relay({ resourceUri: URI, name: PULL, arguments: {} }); // 2 unavailable
    refused = true;
    await relay({ resourceUri: URI, name: PULL, arguments: {} }); // refused → the run ends
    refused = false;
    await relay({ resourceUri: URI, name: PULL, arguments: {} }); // 1 unavailable
    await relay({ resourceUri: URI, name: PULL, arguments: {} }); // 2 unavailable
    expect(callTool).toHaveBeenCalledTimes(5);
    expect(unrestorable).toEqual([]);
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

describe("createMcpUiActionRelay — onSessionUnrestorable (guuey#1249 item 4)", () => {
  const PULL = "ggui_runtime_pull";

  it("fires ONCE at the trip, with the locator, and never on later short-circuited polls", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const callTool = vi.fn(async () => undefined); // dead session
      const seen: string[] = [];
      const relay = createMcpUiActionRelay({ callTool, onSessionUnrestorable: (uri) => seen.push(uri) });
      for (let i = 0; i < PULL_CIRCUIT_THRESHOLD + 5; i += 1) {
        await relay({ resourceUri: URI, name: PULL, arguments: {} });
      }
      expect(seen).toEqual([URI]); // exactly once, carrying the locator
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT fire before the circuit trips (fewer than N unavailable pulls)", async () => {
    const callTool = vi.fn(async () => undefined);
    const seen: string[] = [];
    const relay = createMcpUiActionRelay({ callTool, onSessionUnrestorable: (uri) => seen.push(uri) });
    for (let i = 0; i < PULL_CIRCUIT_THRESHOLD - 1; i += 1) {
      await relay({ resourceUri: URI, name: PULL, arguments: {} });
    }
    expect(seen).toEqual([]);
  });

  it("a throwing host callback never breaks the relay's never-reject contract", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const callTool = vi.fn(async () => undefined);
      const relay = createMcpUiActionRelay({
        callTool,
        onSessionUnrestorable: () => {
          throw new HostBug("host detail alice@example.com");
        },
      });
      // The pull that trips the circuit must still resolve to an in-band error,
      // not reject — even though the host callback throws at the trip.
      let res: Awaited<ReturnType<typeof relay>> | undefined;
      for (let i = 0; i < PULL_CIRCUIT_THRESHOLD; i += 1) {
        res = await relay({ resourceUri: URI, name: PULL, arguments: {} });
      }
      expect(res?.isError).toBe(true);
      // Never silent: one line names the callback and the error's name, never its text.
      const threw = warn.mock.calls.filter((c) => c[0] === UI_ACTION_HOST_CALLBACK_THREW);
      expect(threw).toHaveLength(1);
      expect(threw[0]?.[1]).toEqual({ callback: "onSessionUnrestorable", resourceUri: URI, name: "HostBug" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("alice@example.com");
    } finally {
      warn.mockRestore();
    }
  });

  it("is terminal once open — a would-be-later-success is never attempted, so it fires once", async () => {
    // The open circuit short-circuits every subsequent pull WITHOUT touching
    // the door (action.ts trip check), so a session that came back to life is
    // never observed: unrestorable is terminal for this mount. Recovery is a
    // fresh thread/mount (the widget's "start a new chat"), never an in-place
    // reopen — the callback stays a once-per-mount signal.
    let dead = true;
    const callTool = vi.fn(async () =>
      dead ? undefined : { content: [{ type: "text", text: "live" }] },
    );
    const seen: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const relay = createMcpUiActionRelay({ callTool, onSessionUnrestorable: (uri) => seen.push(uri) });
      for (let i = 0; i < PULL_CIRCUIT_THRESHOLD; i += 1) {
        await relay({ resourceUri: URI, name: PULL, arguments: {} }); // trips
      }
      callTool.mockClear();
      dead = false; // the session "recovers" — but the open circuit never asks
      for (let i = 0; i < 4; i += 1) {
        await relay({ resourceUri: URI, name: PULL, arguments: {} });
      }
      expect(callTool).not.toHaveBeenCalled(); // door untouched while open
      expect(seen).toEqual([URI]); // fired exactly once, at the trip
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createMcpUiActionRelay — an open circuit recovers only through a probe pull, for a host that can hear it", () => {
  const PULL = "ggui_runtime_pull";
  const REFRESH = "ggui_runtime_refresh_ws_token";
  const LIVE = { content: [{ type: "text", text: "live" }] };
  const REFUSED = { content: [{ type: "text", text: "not allowed" }], isError: true };

  /** A door whose pull and refresh answers the test sets; every call is recorded. */
  function door() {
    const state = { pull: undefined as unknown, refresh: LIVE as unknown };
    const callTool = vi.fn(async (_uri: string, name: string) => (name === PULL ? state.pull : state.refresh));
    const pulls = () => callTool.mock.calls.filter((c) => c[1] === PULL).length;
    return { state, callTool, pulls };
  }
  async function trip(relay: ReturnType<typeof createMcpUiActionRelay>, uri = URI) {
    for (let i = 0; i < PULL_CIRCUIT_THRESHOLD; i += 1) await relay({ resourceUri: uri, name: PULL, arguments: {} });
  }
  function silenceWarn() {
    return vi.spyOn(console, "warn").mockImplementation(() => {});
  }

  it("a successful refresh lets ONE probe pull through; a probe the session answers closes it and says so once", async () => {
    const warn = silenceWarn();
    try {
      const d = door();
      const restored: string[] = [];
      const unrestorable: string[] = [];
      const relay = createMcpUiActionRelay({
        callTool: d.callTool,
        onSessionUnrestorable: (uri) => unrestorable.push(uri),
        onSessionRestored: (uri) => restored.push(uri),
      });
      await trip(relay);
      expect(unrestorable).toEqual([URI]);
      expect(d.pulls()).toBe(PULL_CIRCUIT_THRESHOLD);
      await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
      d.state.pull = LIVE;
      const probe = await relay({ resourceUri: URI, name: PULL, arguments: {} });
      expect(probe).toEqual(LIVE);
      expect(restored).toEqual([URI]);
      expect(warn.mock.calls.filter((c) => c[0] === UI_ACTION_PULL_CIRCUIT_CLOSED)).toHaveLength(1);
      // Closed: every later pull reaches the door again.
      await relay({ resourceUri: URI, name: PULL, arguments: {} });
      await relay({ resourceUri: URI, name: PULL, arguments: {} });
      expect(d.pulls()).toBe(PULL_CIRCUIT_THRESHOLD + 3);
      expect(restored).toEqual([URI]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a failed probe leaves it open, and the host hears nothing new", async () => {
    const warn = silenceWarn();
    try {
      const d = door();
      const restored: string[] = [];
      const unrestorable: string[] = [];
      const relay = createMcpUiActionRelay({
        callTool: d.callTool,
        onSessionUnrestorable: (uri) => unrestorable.push(uri),
        onSessionRestored: (uri) => restored.push(uri),
      });
      await trip(relay);
      await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
      await relay({ resourceUri: URI, name: PULL, arguments: {} }); // the probe: still unavailable
      expect(d.pulls()).toBe(PULL_CIRCUIT_THRESHOLD + 1);
      for (let i = 0; i < 3; i += 1) await relay({ resourceUri: URI, name: PULL, arguments: {} });
      expect(d.pulls()).toBe(PULL_CIRCUIT_THRESHOLD + 1); // open again: no pull reaches the door
      expect(unrestorable).toEqual([URI]);
      expect(restored).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a probe that throws in transport leaves it open too", async () => {
    const warn = silenceWarn();
    try {
      let throwing = false;
      const callTool = vi.fn(async (_uri: string, name: string) => {
        if (name === PULL && throwing) throw new Error("network");
        return name === PULL ? undefined : LIVE;
      });
      const restored: string[] = [];
      const unrestorable: string[] = [];
      const relay = createMcpUiActionRelay({
        callTool,
        onSessionUnrestorable: (uri) => unrestorable.push(uri),
        onSessionRestored: (uri) => restored.push(uri),
      });
      await trip(relay);
      await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
      throwing = true;
      const probe = await relay({ resourceUri: URI, name: PULL, arguments: {} });
      expect(probe.isError).toBe(true);
      callTool.mockClear();
      await relay({ resourceUri: URI, name: PULL, arguments: {} });
      expect(callTool).not.toHaveBeenCalled();
      expect(unrestorable).toEqual([URI]);
      expect(restored).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a probe answered with an in-band refusal leaves it open, whatever the refusal's code; a later probe the session answers still restores", async () => {
    // guuey#1978: both doors relay ggui's refusal of an ended session's pull as
    // a 200 carrying `isError`; that answer must not read as the session live.
    const REFUSALS = [
      { content: [{ type: "text", text: "session_not_found: no session render_x for this app" }], isError: true },
      { content: [{ type: "text", text: "Something went wrong" }], isError: true },
      { content: [], isError: true },
    ];
    for (const refusal of REFUSALS) {
      const warn = silenceWarn();
      try {
        const d = door();
        const restored: string[] = [];
        const unrestorable: string[] = [];
        const relay = createMcpUiActionRelay({
          callTool: d.callTool,
          onSessionUnrestorable: (uri) => unrestorable.push(uri),
          onSessionRestored: (uri) => restored.push(uri),
        });
        await trip(relay);
        await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
        d.state.pull = refusal;
        const probe = await relay({ resourceUri: URI, name: PULL, arguments: {} });
        expect(probe).toEqual(refusal); // the card still gets the door's answer
        expect(restored).toEqual([]);
        expect(warn.mock.calls.filter((c) => c[0] === UI_ACTION_PULL_CIRCUIT_CLOSED)).toHaveLength(0);
        for (let i = 0; i < 3; i += 1) await relay({ resourceUri: URI, name: PULL, arguments: {} });
        expect(d.pulls()).toBe(PULL_CIRCUIT_THRESHOLD + 1); // still open: no pull reaches the door
        expect(unrestorable).toEqual([URI]); // no second verdict either
        // The control: the next refresh arms a new probe, and a probe the session answers restores.
        await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
        d.state.pull = LIVE;
        expect(await relay({ resourceUri: URI, name: PULL, arguments: {} })).toEqual(LIVE);
        expect(restored).toEqual([URI]);
      } finally {
        warn.mockRestore();
      }
    }
  });

  it("a pull in flight across the trip that comes back refused does not close the circuit", async () => {
    const warn = silenceWarn();
    try {
      let answerInFlight: (value: unknown) => void = () => undefined;
      const inFlight = new Promise<unknown>((resolve) => {
        answerInFlight = resolve;
      });
      let calls = 0;
      const callTool = vi.fn(async () => {
        calls += 1;
        return calls === 1 ? inFlight : undefined;
      });
      const restored: string[] = [];
      const unrestorable: string[] = [];
      const relay = createMcpUiActionRelay({
        callTool,
        onSessionUnrestorable: (uri) => unrestorable.push(uri),
        onSessionRestored: (uri) => restored.push(uri),
      });
      const slow = relay({ resourceUri: URI, name: PULL, arguments: {} });
      await trip(relay);
      expect(unrestorable).toEqual([URI]);
      answerInFlight(REFUSED);
      await slow;
      callTool.mockClear();
      await relay({ resourceUri: URI, name: PULL, arguments: {} });
      expect(callTool).not.toHaveBeenCalled(); // still open
      expect(restored).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a host that wires only onSessionUnrestorable keeps today's terminal contract, refresh or not", async () => {
    const warn = silenceWarn();
    try {
      const d = door();
      const unrestorable: string[] = [];
      const relay = createMcpUiActionRelay({ callTool: d.callTool, onSessionUnrestorable: (uri) => unrestorable.push(uri) });
      await trip(relay);
      await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
      d.state.pull = LIVE;
      for (let i = 0; i < 3; i += 1) await relay({ resourceUri: URI, name: PULL, arguments: {} });
      expect(d.pulls()).toBe(PULL_CIRCUIT_THRESHOLD); // never another pull
      expect(unrestorable).toEqual([URI]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a refused or unavailable refresh arms no probe", async () => {
    const warn = silenceWarn();
    try {
      const d = door();
      const restored: string[] = [];
      const relay = createMcpUiActionRelay({ callTool: d.callTool, onSessionRestored: (uri) => restored.push(uri) });
      await trip(relay);
      d.state.refresh = REFUSED;
      await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
      d.state.refresh = undefined;
      await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
      d.state.pull = LIVE;
      await relay({ resourceUri: URI, name: PULL, arguments: {} });
      expect(d.pulls()).toBe(PULL_CIRCUIT_THRESHOLD);
      expect(restored).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a refresh before the trip arms nothing: the circuit still opens at the threshold", async () => {
    const warn = silenceWarn();
    try {
      const d = door();
      const relay = createMcpUiActionRelay({ callTool: d.callTool, onSessionRestored: () => undefined });
      await relay({ resourceUri: URI, name: PULL, arguments: {} });
      await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
      await relay({ resourceUri: URI, name: PULL, arguments: {} });
      await relay({ resourceUri: URI, name: PULL, arguments: {} }); // the trip
      await relay({ resourceUri: URI, name: PULL, arguments: {} }); // short-circuited
      expect(d.pulls()).toBe(PULL_CIRCUIT_THRESHOLD);
    } finally {
      warn.mockRestore();
    }
  });

  it("one refresh buys exactly one probe, even with pulls in flight together", async () => {
    const warn = silenceWarn();
    try {
      const d = door();
      const relay = createMcpUiActionRelay({ callTool: d.callTool, onSessionRestored: () => undefined });
      await trip(relay);
      await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
      await Promise.all([1, 2, 3].map(() => relay({ resourceUri: URI, name: PULL, arguments: {} })));
      expect(d.pulls()).toBe(PULL_CIRCUIT_THRESHOLD + 1);
    } finally {
      warn.mockRestore();
    }
  });

  it("the probe is per locator: one card's refresh never opens another's", async () => {
    const warn = silenceWarn();
    try {
      const URI2 = "ui://ggui/render/sess-2/hash-2";
      const d = door();
      const relay = createMcpUiActionRelay({ callTool: d.callTool, onSessionRestored: () => undefined });
      await trip(relay, URI);
      await trip(relay, URI2);
      await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
      d.callTool.mockClear();
      await relay({ resourceUri: URI2, name: PULL, arguments: {} });
      expect(d.callTool).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("after a restore, a new trip is a new verdict: unrestorable and restored alternate", async () => {
    const warn = silenceWarn();
    try {
      const d = door();
      const events: string[] = [];
      const relay = createMcpUiActionRelay({
        callTool: d.callTool,
        onSessionUnrestorable: () => events.push("unrestorable"),
        onSessionRestored: () => events.push("restored"),
      });
      for (let round = 0; round < 2; round += 1) {
        d.state.pull = undefined;
        await trip(relay);
        await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
        d.state.pull = LIVE;
        await relay({ resourceUri: URI, name: PULL, arguments: {} });
      }
      expect(events).toEqual(["unrestorable", "restored", "unrestorable", "restored"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a throwing onSessionRestored never breaks the never-reject contract", async () => {
    const warn = silenceWarn();
    try {
      const d = door();
      const relay = createMcpUiActionRelay({
        callTool: d.callTool,
        onSessionRestored: () => {
          throw new HostBug("host detail alice@example.com");
        },
      });
      await trip(relay);
      await relay({ resourceUri: URI, name: REFRESH, arguments: {} });
      d.state.pull = LIVE;
      await expect(relay({ resourceUri: URI, name: PULL, arguments: {} })).resolves.toEqual(LIVE);
      const threw = warn.mock.calls.filter((c) => c[0] === UI_ACTION_HOST_CALLBACK_THREW);
      expect(threw).toHaveLength(1);
      expect(threw[0]?.[1]).toEqual({ callback: "onSessionRestored", resourceUri: URI, name: "HostBug" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("alice@example.com");
    } finally {
      warn.mockRestore();
    }
  });

  // guuey#2012 + guuey#1978 — one close rule: only a probe that started after
  // THIS trip, answered without isError, closes the circuit.

  const PULL_REQUEST = { resourceUri: URI, name: PULL, arguments: {} };
  const REFRESH_REQUEST = { resourceUri: URI, name: REFRESH, arguments: {} };

  /** A door whose pulls wait until the test answers them, by arrival index; a refresh answers LIVE. */
  function heldDoor() {
    const held: Array<(answer: unknown) => void> = [];
    const callTool = vi.fn(
      (_uri: string, name: string): Promise<unknown> =>
        name === PULL ? new Promise((resolve) => held.push(resolve)) : Promise.resolve(LIVE),
    );
    const answer = (index: number, value: unknown): void => {
      const resolve = held[index];
      if (resolve === undefined) throw new Error(`pull #${index} never reached the door`);
      resolve(value);
    };
    return { callTool, answer, pulls: () => held.length };
  }
  type HeldDoor = ReturnType<typeof heldDoor>;
  type Relay = ReturnType<typeof createMcpUiActionRelay>;

  /** One pull that must reach the door, answered at once. */
  async function answeredPull(relay: Relay, d: HeldDoor, value: unknown) {
    const index = d.pulls();
    const out = relay(PULL_REQUEST);
    d.answer(index, value);
    return out;
  }
  function closedLines(warn: ReturnType<typeof silenceWarn>) {
    return warn.mock.calls.filter((c) => c[0] === UI_ACTION_PULL_CIRCUIT_CLOSED);
  }

  it("a pull already in flight at the trip never closes it: the card gets its answer, the host hears nothing, the circuit holds (guuey#2012)", async () => {
    const warn = silenceWarn();
    try {
      const d = heldDoor();
      const restored: string[] = [];
      const unrestorable: string[] = [];
      const relay = createMcpUiActionRelay({
        callTool: d.callTool,
        onSessionUnrestorable: (uri) => unrestorable.push(uri),
        onSessionRestored: (uri) => restored.push(uri),
      });
      for (let i = 0; i < PULL_CIRCUIT_THRESHOLD - 1; i += 1) await answeredPull(relay, d, undefined);
      // Two pulls in flight together; the first answer trips the circuit.
      const tripping = relay(PULL_REQUEST);
      const inFlight = relay(PULL_REQUEST);
      d.answer(PULL_CIRCUIT_THRESHOLD - 1, undefined);
      await tripping;
      expect(unrestorable).toEqual([URI]);
      d.answer(PULL_CIRCUIT_THRESHOLD, LIVE);
      expect(await inFlight).toEqual(LIVE);
      expect(restored).toEqual([]);
      expect(closedLines(warn)).toHaveLength(0);
      // Still open: the next pull never reaches the door.
      const reached = d.pulls();
      const shortCircuited = relay(PULL_REQUEST);
      expect(d.pulls()).toBe(reached);
      expect((await shortCircuited).isError).toBe(true);
      // Control: the refresh-and-probe still restores it.
      await relay(REFRESH_REQUEST);
      expect(await answeredPull(relay, d, LIVE)).toEqual(LIVE);
      expect(restored).toEqual([URI]);
      expect(closedLines(warn)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a host that wires only onSessionUnrestorable never sees the resumed line, even when a pull in flight answers after the trip (guuey#2012)", async () => {
    const warn = silenceWarn();
    try {
      const d = heldDoor();
      const unrestorable: string[] = [];
      const relay = createMcpUiActionRelay({ callTool: d.callTool, onSessionUnrestorable: (uri) => unrestorable.push(uri) });
      for (let i = 0; i < PULL_CIRCUIT_THRESHOLD - 1; i += 1) await answeredPull(relay, d, undefined);
      const tripping = relay(PULL_REQUEST);
      const inFlight = relay(PULL_REQUEST);
      d.answer(PULL_CIRCUIT_THRESHOLD - 1, undefined);
      await tripping;
      d.answer(PULL_CIRCUIT_THRESHOLD, LIVE);
      await inFlight;
      expect(unrestorable).toEqual([URI]);
      expect(closedLines(warn)).toHaveLength(0);
      const reached = d.pulls();
      const shortCircuited = relay(PULL_REQUEST);
      expect(d.pulls()).toBe(reached);
      await shortCircuited;
    } finally {
      warn.mockRestore();
    }
  });

  it("a probe the session answers with isError leaves it open: an ended session's in-band refusal is no restore (guuey#1978)", async () => {
    const warn = silenceWarn();
    try {
      const d = door();
      const restored: string[] = [];
      const unrestorable: string[] = [];
      const relay = createMcpUiActionRelay({
        callTool: d.callTool,
        onSessionUnrestorable: (uri) => unrestorable.push(uri),
        onSessionRestored: (uri) => restored.push(uri),
      });
      await trip(relay);
      await relay(REFRESH_REQUEST);
      d.state.pull = REFUSED;
      expect(await relay(PULL_REQUEST)).toEqual(REFUSED); // the card still gets the session's own answer
      expect(restored).toEqual([]);
      expect(closedLines(warn)).toHaveLength(0);
      for (let i = 0; i < 3; i += 1) await relay(PULL_REQUEST);
      expect(d.pulls()).toBe(PULL_CIRCUIT_THRESHOLD + 1); // still open: only the probe reached the door
      // Control: the next refresh's probe that the session answers restores it.
      await relay(REFRESH_REQUEST);
      d.state.pull = LIVE;
      expect(await relay(PULL_REQUEST)).toEqual(LIVE);
      expect(restored).toEqual([URI]);
      expect(unrestorable).toEqual([URI]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a probe of an earlier trip never closes a later one", async () => {
    const warn = silenceWarn();
    try {
      const d = heldDoor();
      const events: string[] = [];
      const relay = createMcpUiActionRelay({
        callTool: d.callTool,
        onSessionUnrestorable: () => events.push("unrestorable"),
        onSessionRestored: () => events.push("restored"),
      });
      for (let i = 0; i < PULL_CIRCUIT_THRESHOLD; i += 1) await answeredPull(relay, d, undefined);
      // Two refreshes, two probes of the first trip in flight.
      await relay(REFRESH_REQUEST);
      const earlyProbe = relay(PULL_REQUEST);
      await relay(REFRESH_REQUEST);
      const lateProbe = relay(PULL_REQUEST);
      d.answer(PULL_CIRCUIT_THRESHOLD + 1, LIVE);
      await lateProbe; // closes the first trip
      for (let i = 0; i < PULL_CIRCUIT_THRESHOLD; i += 1) await answeredPull(relay, d, undefined); // the second trip
      d.answer(PULL_CIRCUIT_THRESHOLD, LIVE);
      expect(await earlyProbe).toEqual(LIVE);
      expect(events).toEqual(["unrestorable", "restored", "unrestorable"]);
      const reached = d.pulls();
      const shortCircuited = relay(PULL_REQUEST);
      expect(d.pulls()).toBe(reached);
      await shortCircuited;
    } finally {
      warn.mockRestore();
    }
  });

  it("a refresh while the probe is in flight arms nothing for the next trip", async () => {
    const warn = silenceWarn();
    try {
      const d = heldDoor();
      const events: string[] = [];
      const relay = createMcpUiActionRelay({
        callTool: d.callTool,
        onSessionUnrestorable: () => events.push("unrestorable"),
        onSessionRestored: () => events.push("restored"),
      });
      for (let i = 0; i < PULL_CIRCUIT_THRESHOLD; i += 1) await answeredPull(relay, d, undefined);
      await relay(REFRESH_REQUEST);
      const probe = relay(PULL_REQUEST);
      await relay(REFRESH_REQUEST); // still open: this one arms
      d.answer(PULL_CIRCUIT_THRESHOLD, LIVE);
      await probe; // closes the trip
      for (let i = 0; i < PULL_CIRCUIT_THRESHOLD; i += 1) await answeredPull(relay, d, undefined); // a new trip
      expect(events).toEqual(["unrestorable", "restored", "unrestorable"]);
      // No refresh since this trip: the next pull is short-circuited, not a probe.
      const reached = d.pulls();
      const shortCircuited = relay(PULL_REQUEST);
      expect(d.pulls()).toBe(reached);
      await shortCircuited;
    } finally {
      warn.mockRestore();
    }
  });
});

describe("card-health telemetry: only the closed kind set reaches the door", () => {
  const TURI = "ui://ggui/render/sess-1/h";
  const BOOT = JSON.stringify({ hasStaticContent: true, hasLiveTrio: true, bridgeCapable: false });
  const mixed = {
    sessionId: "sess-1",
    events: [
      { at: 0, kind: "boot.path", detail: BOOT },
      { at: 5, kind: "channel_failover_swap", detail: JSON.stringify({ from: "ws", to: "sse" }) },
      { at: 9, kind: "gesture.dispatch", detail: JSON.stringify({ intent: "book a table", toolName: "reserve" }) },
      { at: 12, kind: "status.connected", detail: "leaked text" },
      { at: 40, kind: "status.connected" },
      { at: 900, kind: "doorbell.ring", detail: "render_0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0" },
    ],
  };

  it("the kind set is exactly the eight kinds the server doors admit", () => {
    expect(Object.fromEntries(UI_TELEMETRY_KINDS)).toEqual({
      "boot.path": "boot-path",
      "boot.static_only_no_bridge": "none",
      "status.connecting": "none",
      "status.reconnecting": "none",
      "status.connected": "none",
      "status.disconnected": "none",
      "subscribe.resolved": "subscribe",
      "doorbell.ring": "render-session-id",
    });
    expect(UI_TELEMETRY_TOOL).toBe("ggui_runtime_telemetry");
  });

  it("drops whole events outside the set or with a detail their kind does not admit, and keeps the rest in order", () => {
    expect(admittedTelemetryArguments(mixed)).toEqual({
      sessionId: "sess-1",
      events: [
        { at: 0, kind: "boot.path", detail: BOOT },
        { at: 40, kind: "status.connected" },
        { at: 900, kind: "doorbell.ring", detail: "render_0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0" },
      ],
    });
    expect(admittedTelemetryArguments({ events: [{ at: 1, kind: "epoch.frozen", detail: "2" }] })).toBeUndefined();
    expect(admittedTelemetryArguments({ events: [{ at: 1, kind: "status.connected", note: "x" }] })).toBeUndefined();
    expect(admittedTelemetryArguments({ sessionId: "s", events: "boot.path" })).toBeUndefined();
    expect(admittedTelemetryArguments(undefined)).toBeUndefined();
  });

  it("a doorbell detail that is not a render_<uuid> drops that event", () => {
    for (const detail of ["sess-1", "RENDER_0F1E2D3C-4B5A-4978-8796-A5B4C3D2E1F0", "render_0f1e2d3c", "x".repeat(44)]) {
      expect(admittedTelemetryArguments({ events: [{ at: 1, kind: "doorbell.ring", detail }] })).toBeUndefined();
    }
  });

  it("keeps at most the per-call cap, the newest events", () => {
    const events = Array.from({ length: MAX_UI_TELEMETRY_EVENTS + 5 }, (_, i) => ({ at: i, kind: "status.connected" }));
    const out = admittedTelemetryArguments({ events });
    expect(Array.isArray(out?.["events"]) && out["events"].length).toBe(MAX_UI_TELEMETRY_EVENTS);
  });

  it("the relay sends only the admitted events to the door", async () => {
    const callTool = vi.fn(async () => ({ content: [], structuredContent: { ok: true } }));
    const relay = createMcpUiActionRelay({ callTool });
    const out = await relay({ resourceUri: TURI, name: "ggui_runtime_telemetry", arguments: mixed });
    expect(out.isError).toBeUndefined();
    expect(callTool).toHaveBeenCalledWith(TURI, "ggui_runtime_telemetry", admittedTelemetryArguments(mixed));
  });

  it("nothing admitted: the door is never called, and the card gets an ok acknowledgement", async () => {
    const callTool = vi.fn();
    const relay = createMcpUiActionRelay({ callTool });
    const out = await relay({
      resourceUri: TURI,
      name: "ggui_runtime_telemetry",
      arguments: { events: [{ at: 1, kind: "gesture.result", detail: "x" }] },
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(out).toEqual({ content: [], structuredContent: { ok: true } });
  });

  it("an older door that refuses the tool answers in-band, and never trips the pull circuit or the unrestorable signal", async () => {
    const onSessionUnrestorable = vi.fn();
    const callTool = vi.fn(async (_uri: string, name: string) => {
      if (name === "ggui_runtime_telemetry") throw new Error("400 Unsupported action tool");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const relay = createMcpUiActionRelay({ callTool, onSessionUnrestorable });
    for (let i = 0; i < PULL_CIRCUIT_THRESHOLD + 1; i++) {
      const out = await relay({ resourceUri: TURI, name: "ggui_runtime_telemetry", arguments: mixed });
      expect(out.isError).toBe(true);
    }
    expect(onSessionUnrestorable).not.toHaveBeenCalled();
    const pull = await relay({ resourceUri: TURI, name: "ggui_runtime_pull", arguments: { sessionId: "sess-1" } });
    expect(pull.isError).toBeUndefined();
    expect(callTool).toHaveBeenLastCalledWith(TURI, "ggui_runtime_pull", { sessionId: "sess-1" });
  });
});

describe("the render-failure report: exactly five arguments, checked before the door (ggui#1609)", () => {
  const RURI = "ui://ggui/render/sess-1/h";
  const report = { sessionId: "sess-1", appId: "app_demo", phase: "mount", errorName: "TypeError", catches: 1 };

  it("is relayable, never a user gesture", () => {
    expect(UI_RENDER_FAILURE_TOOL).toBe("ggui_runtime_report_render_failure");
    expect(UI_ACTION_TOOLS.has(UI_RENDER_FAILURE_TOOL)).toBe(true);
    expect(UI_SEMANTIC_ACTION_TOOLS.has(UI_RENDER_FAILURE_TOOL)).toBe(false);
    expect([...UI_RENDER_FAILURE_PHASES]).toEqual(["mount", "update"]);
    expect(MAX_UI_RENDER_FAILURE_ID_CHARS).toBe(256);
    expect(MAX_UI_RENDER_FAILURE_CATCHES).toBe(100);
  });

  it("admits the exact five: both phases, catches 0 and 100, a 64-character errorName, ids of 1 and 256 characters", () => {
    for (const args of [
      report,
      { ...report, phase: "update" },
      { ...report, catches: 0 },
      { ...report, catches: 100 },
      { ...report, errorName: `E${"r".repeat(63)}` },
      { ...report, sessionId: "s", appId: "a" },
      { ...report, sessionId: "x".repeat(256), appId: "x".repeat(256) },
    ]) {
      expect(isAdmittedRenderFailureReport(args), JSON.stringify(args).slice(0, 80)).toBe(true);
    }
  });

  it("refuses an unknown key, a missing key, and every value outside its rule", () => {
    const noSession: { [field: string]: unknown } = { ...report };
    delete noSession["sessionId"];
    for (const args of [
      { ...report, message: "Cannot read properties of undefined" },
      noSession,
      {},
      { ...report, catches: -1 },
      { ...report, catches: 101 },
      { ...report, catches: 1.5 },
      { ...report, catches: "3" },
      { ...report, phase: "render" },
      { ...report, errorName: "1Error" },
      { ...report, errorName: `E${"r".repeat(64)}` },
      { ...report, errorName: "TypeError: x is undefined" },
      { ...report, sessionId: "" },
      { ...report, appId: "" },
      { ...report, sessionId: "x".repeat(257) },
      { ...report, appId: "x".repeat(257) },
      undefined,
    ]) {
      expect(isAdmittedRenderFailureReport(args), JSON.stringify(args ?? null).slice(0, 80)).toBe(false);
    }
  });

  it("the relay forwards an admitted report to the door unchanged, the same object the card sent", async () => {
    const answer = { content: [], structuredContent: { ok: true } };
    const callTool = vi.fn(async () => answer);
    const relay = createMcpUiActionRelay({ callTool });
    const out = await relay({ resourceUri: RURI, name: UI_RENDER_FAILURE_TOOL, arguments: report });
    expect(out).toEqual(answer);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(RURI, UI_RENDER_FAILURE_TOOL, report);
  });

  it("the server's {ok: false, code: SESSION_NOT_FOUND} passes through to the card as it came", async () => {
    const answer = { content: [], structuredContent: { ok: false, code: "SESSION_NOT_FOUND" } };
    const relay = createMcpUiActionRelay({ callTool: vi.fn(async () => answer) });
    expect(await relay({ resourceUri: RURI, name: UI_RENDER_FAILURE_TOOL, arguments: report })).toEqual(answer);
  });

  it("a report the doors would refuse never reaches them: the card is answered in-band unavailable", async () => {
    const callTool = vi.fn();
    const relay = createMcpUiActionRelay({ callTool });
    for (const args of [{ ...report, stack: "at render (card.js:1:1)" }, { ...report, catches: 101 }, undefined]) {
      const out = await relay({ resourceUri: RURI, name: UI_RENDER_FAILURE_TOOL, ...(args === undefined ? {} : { arguments: args }) });
      expect(out).toEqual({ content: [{ type: "text", text: UI_ACTION_UNAVAILABLE_TEXT }], isError: true });
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it("a failing report never trips the pull circuit or the unrestorable signal", async () => {
    const onSessionUnrestorable = vi.fn();
    const callTool = vi.fn(async (_uri: string, name: string) => {
      if (name === UI_RENDER_FAILURE_TOOL) throw new Error("400 Unsupported action tool");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const relay = createMcpUiActionRelay({ callTool, onSessionUnrestorable });
    for (let i = 0; i < PULL_CIRCUIT_THRESHOLD + 1; i++) {
      const out = await relay({ resourceUri: RURI, name: UI_RENDER_FAILURE_TOOL, arguments: report });
      expect(out.isError).toBe(true);
    }
    expect(onSessionUnrestorable).not.toHaveBeenCalled();
    const pull = await relay({ resourceUri: RURI, name: "ggui_runtime_pull", arguments: { sessionId: "sess-1" } });
    expect(pull.isError).toBeUndefined();
  });
});
