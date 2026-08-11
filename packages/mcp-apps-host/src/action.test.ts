/**
 * guuey#158 — the action relay's two invariants: never throw into the
 * sandbox bridge, and never forward an un-narrowed wire arm.
 */
import { describe, expect, it, vi } from "vitest";
import {
  asToolCallResult,
  createMcpUiActionRelay,
  UI_ACTION_UNAVAILABLE_TEXT,
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
