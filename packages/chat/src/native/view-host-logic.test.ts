import { describe, expect, it, vi } from "vitest";
import { UI_ACTION_UNAVAILABLE_TEXT, type ResolvedViewMount } from "@guuey/mcp-apps-host";
import type { ItemKey, ViewMountItem } from "../types.js";
import {
  chooseNativeViewMount,
  clampNativeViewHeight,
  lifecycleSignal,
  nextNativeViewPhase,
  relayNativeToolCall,
  toNativeFrameResource,
} from "./view-host-logic.js";

const KEY: ItemKey = "view:1";
const INLINE: ResolvedViewMount = {
  channel: "inline",
  resource: { uri: "ui://app/card", mimeType: "text/html", text: "<p>hi</p>" },
};

function viewItem(
  over: Partial<Pick<ViewMountItem, "mount" | "phase">> = {},
): Pick<ViewMountItem, "key" | "mount" | "phase"> {
  return { key: KEY, mount: INLINE, phase: "negotiating", ...over };
}

describe("chooseNativeViewMount", () => {
  it("mounts direct material as is", () => {
    expect(chooseNativeViewMount(viewItem(), new Map())).toEqual({ kind: "mount", mount: INLINE });
  });

  it("mounts a locator's resolution from resolvedMounts", () => {
    const locator = viewItem({ mount: { channel: "locator", resourceUri: "ui://app/card" } });
    expect(chooseNativeViewMount(locator, new Map([[KEY, INLINE]]))).toEqual({
      kind: "mount",
      mount: INLINE,
    });
  });

  it("is pending while a locator resolves", () => {
    const locator = viewItem({ mount: { channel: "locator", resourceUri: "ui://app/card" } });
    expect(chooseNativeViewMount(locator, new Map())).toEqual({ kind: "pending" });
  });

  it("is expired when the read failed or the plan says so", () => {
    const locator = viewItem({ mount: { channel: "locator", resourceUri: "ui://app/card" } });
    expect(chooseNativeViewMount(locator, new Map([[KEY, "expired"]]))).toEqual({ kind: "expired" });
    expect(chooseNativeViewMount(viewItem({ phase: "expired", mount: null }), new Map())).toEqual({
      kind: "expired",
    });
  });
});

describe("toNativeFrameResource", () => {
  it("passes inline text and blob content, defaulting the mime type", () => {
    expect(toNativeFrameResource({ uri: "ui://a", text: "<p/>" })).toEqual({
      uri: "ui://a",
      mimeType: "text/html",
      text: "<p/>",
    });
    expect(toNativeFrameResource({ uri: "ui://a", mimeType: "text/html", blob: "PHAvPg==" })).toEqual({
      uri: "ui://a",
      mimeType: "text/html",
      blob: "PHAvPg==",
    });
  });

  it("refuses a bare uri — the frame is never pointed at a URL", () => {
    expect(toNativeFrameResource({ uri: "https://example.com/app" })).toBeNull();
  });
});

describe("clampNativeViewHeight", () => {
  const bounds = { minHeight: 160, maxHeight: 760 };
  it("clamps both ways and rounds up", () => {
    expect(clampNativeViewHeight(10, bounds)).toBe(160);
    expect(clampNativeViewHeight(5000, bounds)).toBe(760);
    expect(clampNativeViewHeight(300.2, bounds)).toBe(301);
  });
  it("keeps the current height for a report without one", () => {
    expect(clampNativeViewHeight(undefined, bounds)).toBeNull();
    expect(clampNativeViewHeight(Number.NaN, bounds)).toBeNull();
  });
});

describe("nextNativeViewPhase", () => {
  it("connects on any sign of life, late ones too", () => {
    expect(nextNativeViewPhase("negotiating", "alive")).toBe("connected");
    expect(nextNativeViewPhase("no-handshake", "alive")).toBe("connected");
  });
  it("fails only a view that never connected", () => {
    expect(nextNativeViewPhase("negotiating", "failed")).toBe("no-handshake");
    expect(nextNativeViewPhase("connected", "failed")).toBe("connected");
  });
  it("reads the renderer lifecycle states it knows", () => {
    expect(lifecycleSignal("code-ready")).toBe("alive");
    expect(lifecycleSignal("error")).toBe("failed");
    expect(lifecycleSignal("mounting")).toBeNull();
  });
});

describe("relayNativeToolCall", () => {
  it("relays scoped to the item's actionScope", async () => {
    const relay = vi.fn(() => Promise.resolve({ content: [{ type: "text" as const, text: "ok" }] }));
    const result = await relayNativeToolCall(relay, "ui://app/card", "submit", { a: 1 });
    expect(relay).toHaveBeenCalledWith({ resourceUri: "ui://app/card", name: "submit", arguments: { a: 1 } });
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("answers in-band when there is no relay, no scope, or the relay rejects", async () => {
    const relay = vi.fn(() => Promise.reject(new Error("offline")));
    for (const result of [
      await relayNativeToolCall(undefined, "ui://app/card", "submit", {}),
      await relayNativeToolCall(relay, null, "submit", {}),
      await relayNativeToolCall(relay, "ui://app/card", "submit", {}),
    ]) {
      expect(result).toEqual({ content: [{ type: "text", text: UI_ACTION_UNAVAILABLE_TEXT }], isError: true });
    }
    expect(relay).toHaveBeenCalledTimes(1);
  });
});
