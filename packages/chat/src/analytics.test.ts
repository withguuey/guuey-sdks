import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatAnalyticsGui,
  chatCtaIdFor,
  createChatAnalytics,
  hostPosthogSink,
  resolveChatAnalytics,
  type ChatAnalyticsSetting,
  type ChatAnalyticsSink,
} from "./analytics.js";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "posthog");
  vi.restoreAllMocks();
});

function tracker(setting: ChatAnalyticsSetting | undefined, appId: { id: string | undefined } = { id: "app_1" }) {
  return createChatAnalytics(() => ({ appId: appId.id, setting }));
}

describe("createChatAnalytics", () => {
  it("opened once, turns 1-based, every event stamped app_id + surface inline + gui — never text", () => {
    const sink = vi.fn<ChatAnalyticsSink>();
    const t = tracker(sink);
    t.opened();
    t.opened();
    t.messageSent();
    t.messageSent();
    t.ctaClicked("https://guuey.com/pricing");
    expect(sink.mock.calls).toEqual([
      ["helper_opened", { app_id: "app_1", surface: "inline", gui: "on" }],
      ["helper_message_sent", { app_id: "app_1", turn: 1, surface: "inline", gui: "on" }],
      ["helper_message_sent", { app_id: "app_1", turn: 2, surface: "inline", gui: "on" }],
      ["helper_cta_clicked", { app_id: "app_1", cta: "https://guuey.com/pricing", surface: "inline", gui: "on" }],
    ]);
  });

  it("the first turn is the first interaction when nothing came before it", () => {
    const sink = vi.fn<ChatAnalyticsSink>();
    tracker(sink).messageSent();
    expect(sink.mock.calls.map((c) => c[0])).toEqual(["helper_opened", "helper_message_sent"]);
  });

  it("off, false, or no app id → nothing emits", () => {
    const sink = vi.fn<ChatAnalyticsSink>();
    Reflect.set(globalThis, "posthog", { capture: sink });
    for (const t of [tracker(undefined), tracker(false), tracker(true, { id: undefined }), tracker(true, { id: "" })]) {
      t.opened();
      t.messageSent();
      t.ctaClicked("x");
    }
    expect(sink).not.toHaveBeenCalled();
  });

  it("gguiEnabled false stamps gui off", () => {
    const sink = vi.fn<ChatAnalyticsSink>();
    tracker({ capture: sink, gguiEnabled: false }).opened();
    expect(sink.mock.calls).toEqual([["helper_opened", { app_id: "app_1", surface: "inline", gui: "off" }]]);
  });

  it("a throwing sink is contained", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = tracker(() => {
      throw new Error("boom");
    });
    expect(() => t.messageSent()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe("hostPosthogSink", () => {
  it("calls capture as a METHOD on the global, read at call time", () => {
    const sink = hostPosthogSink();
    sink("helper_opened", { app_id: "a", surface: "inline", gui: "on" }); // no client yet → dropped
    const received: Array<{ self: unknown; args: unknown[] }> = [];
    const client = {
      capture(this: unknown, ...args: unknown[]) {
        received.push({ self: this, args });
      },
    };
    Reflect.set(globalThis, "posthog", client);
    sink("helper_opened", { app_id: "a", surface: "inline", gui: "on" });
    expect(received).toEqual([{ self: client, args: ["helper_opened", { app_id: "a", surface: "inline", gui: "on" }] }]);
  });

  it("a global without a capture function is ignored", () => {
    Reflect.set(globalThis, "posthog", { capture: "nope" });
    expect(() => hostPosthogSink()("helper_opened", { app_id: "a", surface: "inline", gui: "on" })).not.toThrow();
  });
});

describe("resolveChatAnalytics / chatAnalyticsGui", () => {
  it("resolves each setting form", () => {
    const fn: ChatAnalyticsSink = () => {};
    expect(resolveChatAnalytics(undefined)).toBeNull();
    expect(resolveChatAnalytics(false)).toBeNull();
    expect(resolveChatAnalytics(true)?.gui).toBe("on");
    expect(resolveChatAnalytics(fn)?.sink).toBe(fn);
    expect(resolveChatAnalytics({ capture: fn, gguiEnabled: null })).toEqual({ sink: fn, gui: "on" });
    expect(resolveChatAnalytics({})?.gui).toBe("on");
  });

  it("only false is off", () => {
    expect(chatAnalyticsGui(false)).toBe("off");
    expect(chatAnalyticsGui(true)).toBe("on");
    expect(chatAnalyticsGui(null)).toBe("on");
    expect(chatAnalyticsGui(undefined)).toBe("on");
  });
});

describe("chatCtaIdFor", () => {
  it("prefers data-cta, else origin + path, never query or hash; a non-http scheme is reduced to the scheme", () => {
    expect(chatCtaIdFor({ dataset: { cta: " signup " }, href: "https://x.test/a?q=1" })).toBe("signup");
    expect(chatCtaIdFor({ href: "https://guuey.com/pricing?email=a@b.c#top" })).toBe("https://guuey.com/pricing");
    expect(chatCtaIdFor({ href: "mailto:someone@example.com" })).toBe("mailto:");
    expect(chatCtaIdFor({ href: "tel:+15551234" })).toBe("tel:");
    expect(chatCtaIdFor({ href: "" })).toBeNull();
    expect(chatCtaIdFor({ href: "not a url" })).toBeNull();
  });
});
