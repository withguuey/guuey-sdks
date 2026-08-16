/**
 * R6 under the host's CSP tripwire (guuey#235): when the embedding page's
 * own Content-Security-Policy blocked the view, the plan's `no-handshake`
 * label names the blocked URI and the allowance instead of the channel
 * heuristic ("couldn't start" / "showing plain content") — the verdict is
 * actionable and outranks the guess, on any channel. Without a diagnosis
 * the channel-aware labels stand unchanged (family 7 pins those).
 */
import { describe, expect, it } from "vitest";
import type { ViewCspDiagnosis } from "@guuey/mcp-apps-host";
import { viewNeverHandshakes } from "./corpus/fixtures.js";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy } from "./policy.js";
import type { ViewMountItem } from "./types.js";

const DIAGNOSIS: ViewCspDiagnosis = {
  blockedUri: "https://assets.mcp.example/runtime/v1.js",
  violatedDirective: "script-src-elem",
  suggestedEntry: "https://assets.mcp.example",
  message: "This page's Content-Security-Policy blocks https://assets.mcp.example/runtime/v1.js (script-src-elem) — the view cannot start. Add `script-src-elem https://assets.mcp.example` to the page's policy.",
};

function views(items: ReturnType<typeof planTranscript>["items"]): ViewMountItem[] {
  return items.filter((i): i is ViewMountItem => i.kind === "view");
}

describe("R6 no-handshake with a CSP diagnosis (guuey#235)", () => {
  it("labels the actionable cause on BOTH channels and carries the structured verdict", () => {
    const inputs = { ...viewNeverHandshakes(), viewDiagnoses: { "view.tInline": DIAGNOSIS, "view.tGgui": DIAGNOSIS } };
    const plan = planTranscript(inputs, calmPolicy());
    const [inline, ggui] = views(plan.items);
    expect(inline?.phase).toBe("no-handshake");
    expect(ggui?.phase).toBe("no-handshake");
    for (const v of [inline, ggui]) {
      expect(v?.diagnosis).toEqual(DIAGNOSIS);
      expect(v?.label).toContain("https://assets.mcp.example/runtime/v1.js");
      expect(v?.label).toContain("script-src-elem https://assets.mcp.example");
    }
  });

  it("without a diagnosis the channel-aware labels stand (the tripwire only ever ADDS)", () => {
    const plan = planTranscript(viewNeverHandshakes(), calmPolicy());
    const [inline, ggui] = views(plan.items);
    const s = calmPolicy().strings;
    expect(inline?.diagnosis).toBeNull();
    expect(inline?.label).toBe(s.viewInlineFallback);
    expect(ggui?.diagnosis).toBeNull();
    expect(ggui?.label).toBe(s.viewBootFailure);
  });

  it("is deterministic and preset-independent for the label (debug adds nothing to the copy itself)", () => {
    const inputs = { ...viewNeverHandshakes(), viewDiagnoses: { "view.tGgui": DIAGNOSIS } };
    const a = planTranscript(inputs, calmPolicy());
    const b = planTranscript(inputs, calmPolicy());
    expect(a).toEqual(b);
    const d = planTranscript(inputs, debugPolicy());
    expect(views(d.items)[1]?.label).toBe(views(a.items)[1]?.label);
    // The inline mount had no verdict — it keeps its own label.
    expect(views(a.items)[0]?.diagnosis).toBeNull();
  });
});
