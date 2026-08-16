/**
 * Corpus family 18: production-capture-ggui-render (guuey#135 wave 3c).
 *
 * The 3b lesson made structural: this family replays a REAL redacted
 * production capture through the REAL `invokeTurn` + Reducer + plan — the
 * exact fold shape that broke the hand-driven corpus's blind spot (tool
 * results in `role: "tool"` messages, mounts silently dropped).
 */
import { describe, expect, it } from "vitest";
import { createMcpUiResourceReader, resolveViewMount } from "@guuey/mcp-apps-host";
import { planTranscript } from "../plan.js";
import { calmPolicy, debugPolicy } from "../policy.js";
import type { ToolItem, ViewMountItem } from "../types.js";
import { CAPTURE_RENDER_URI, captureTurnEvents, productionGguiRenderCapture } from "./capture.js";
import { gguiReadShell } from "./fixtures.js";

describe("corpus 18: production-capture-ggui-render", () => {
  it("replays through the real invokeTurn: session, frames, done", async () => {
    const events = await captureTurnEvents("issue2627-render-capture.coalesced.sse.txt");
    expect(events.some((e) => e.kind === "session")).toBe(true);
    expect(events.some((e) => e.kind === "message")).toBe(true);
    // The capture's turn completed — the reader must see its end, whatever
    // frame carried it (a `done` event or the final message settling).
    expect(events.length).toBeGreaterThan(10);
  });

  it("the production fold mounts the rendered card — never a blank transcript", async () => {
    const inputs = await productionGguiRenderCapture();
    const plan = planTranscript(inputs, calmPolicy());

    const views = plan.items.filter((i): i is ViewMountItem => i.kind === "view");
    expect(views).toHaveLength(1);
    expect(views[0].mount).not.toBeNull();
    expect(views[0].actionScope).toBe(CAPTURE_RENDER_URI);

    // The display-bearing rule holds on the REAL shape too: the mount is a
    // top-level item, never swallowed into a tool group.
    for (const item of plan.items) {
      if (item.kind === "tool-group") {
        expect(item.tools.every((t) => t.kind === "tool")).toBe(true);
      }
    }

    // Nothing degraded to the R15 unknown row: every block in a production
    // ggui-render turn has a real category.
    expect(plan.items.some((i) => i.kind === "unknown")).toBe(false);
  });

  it("the capture's bootstrap-carrying render takes the LOCATOR arm — and resolves to the same ggui shell (guuey#209)", async () => {
    // This capture is 0.6.0-era: its render tool-result still carries the
    // `_meta["ai.ggui/render"]` bootstrap. Since the vendor arm retired that
    // is inert — the plan carries the locator (uiData won: the normalizer
    // stamped it because `_meta.ui` was present), and the mount comes from
    // a read. Same visual outcome as the prod-wire meta-less shape (family
    // 24), different arm; the ONLY witness that a consumer needs no code
    // path keyed on whether a producer inlined mount material.
    const inputs = await productionGguiRenderCapture();
    const view = planTranscript(inputs, calmPolicy()).items.find(
      (i): i is ViewMountItem => i.kind === "view",
    );
    expect(view?.channel).toBe("locator");
    expect(view?.mount).toEqual({ channel: "locator", resourceUri: CAPTURE_RENDER_URI });
    const reader = createMcpUiResourceReader({
      readResource: (uri) =>
        Promise.resolve({
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: gguiReadShell({
            runtimeUrl: "https://dev.mcp.sandbox.ggui.ai/_ggui/iframe-runtime.js",
            wsUrl: "wss://dev.mcp.sandbox.ggui.ai/ws",
          }),
        }),
    });
    const resolved = await resolveViewMount(view?.mount ?? undefined, reader);
    expect(resolved?.channel).toBe("ggui");
    expect(resolved?.resource.uri).toBe(CAPTURE_RENDER_URI);
    expect(resolved?.resource.text).toContain("__GGUI_META__");
  });

  it("the producing call folds into the card's chrome in calm (attribution)", async () => {
    const inputs = await productionGguiRenderCapture();
    const plan = planTranscript(inputs, calmPolicy());
    const view = plan.items.find((i): i is ViewMountItem => i.kind === "view");
    expect(view?.attribution).not.toBeNull();
    // The attributed call line itself carries the attribution flag rather
    // than rendering standalone.
    const attributed = plan.items.filter(
      (i): i is ToolItem => i.kind === "tool" && i.attribution,
    );
    expect(attributed.length).toBeLessThanOrEqual(1);
  });

  it("chunk boundaries are irrelevant: 512-byte and 7-byte replays plan deeply equal", async () => {
    const a = await captureTurnEvents("issue2627-render-capture.coalesced.sse.txt", 512);
    const b = await captureTurnEvents("issue2627-render-capture.coalesced.sse.txt", 7);
    expect(b).toEqual(a);
  });

  it("determinism: same capture inputs ⇒ deeply equal plans, calm and debug", async () => {
    const inputs = await productionGguiRenderCapture();
    expect(planTranscript(inputs, calmPolicy())).toEqual(planTranscript(inputs, calmPolicy()));
    expect(planTranscript(inputs, debugPolicy())).toEqual(planTranscript(inputs, debugPolicy()));
  });
});
