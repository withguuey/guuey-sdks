import { describe, expect, it } from "vitest";
import { RENDER_GATE_REFUSAL_CODES } from "@ggui-ai/protocol";
import type { JsonValue } from "@silverprotocol/core";
import { toolResultRenderRefusal } from "./render-refusal.js";
import { toolResultViewMount } from "./card-mount.js";

/** The envelope ggui's `ggui_render` emits for a pre-generation refusal (migration doc, 2026-09-04). */
const REFUSED: JsonValue = {
  outcome: "refused",
  refusal: {
    code: "app_policy_missing",
    message: "This app has no render policy on this deployment.",
    fix: "PUT /v1/provisioning/apps/{appId}/policy from the platform that owns it.",
    retry: "after-fix",
    handshake: "intact",
  },
};

/** A committed 0.14.0 render — identity present, `outcome: 'rendered'`. */
const RENDERED: JsonValue = {
  outcome: "rendered",
  sessionId: "render_1",
  action: "create",
  contractHash: "c10a20553df2349b",
  blueprintId: "bp_1",
  variantKey: "v1",
  cache: { hit: false },
  resourceUri: "ui://ggui/render/render_1/hash",
};

/** The SAME committed render as a `draft-2026-08-*` server emitted it — no `outcome` at all. */
const RENDERED_PRE_0_14: JsonValue = {
  sessionId: "render_1",
  action: "create",
  contractHash: "c10a20553df2349b",
  blueprintId: "bp_1",
  variantKey: "v1",
  cache: { hit: false },
  resourceUri: "ui://ggui/render/render_1/hash",
};

describe("toolResultRenderRefusal — the typed read of a pre-generation refusal (guuey#836)", () => {
  it("returns the refusal envelope, typed, for a conformant `outcome: 'refused'` result", () => {
    const refusal = toolResultRenderRefusal({ structuredContent: REFUSED });
    expect(refusal).toBeDefined();
    expect(refusal!.code).toBe("app_policy_missing");
    expect(refusal!.retry).toBe("after-fix");
    expect(refusal!.handshake).toBe("intact");
    expect(refusal!.fix).toContain("/policy");
  });

  it("a refused result mounts NOTHING — the dispatcher and the refusal read agree on the same block", () => {
    const block = {
      type: "tool-result" as const,
      toolCallId: "toolu_1",
      content: [{ type: "text" as const, text: "app_policy_missing: …" }],
      isError: true,
      structuredContent: REFUSED,
    };
    expect(toolResultViewMount(block)).toBeUndefined();
    expect(toolResultRenderRefusal(block)).toBeDefined();
  });

  it("a rendered 0.14.0 result is not a refusal", () => {
    expect(toolResultRenderRefusal({ structuredContent: RENDERED })).toBeUndefined();
  });

  it("a committed render from the PREVIOUS wire (no `outcome`) is not a refusal — the old shape stays tolerated", () => {
    // The window's skew: our prod may read a draft-2026-08 server while this
    // ships, and a 0.14.0 server's rendered results are read by older hosts.
    // Neither direction may produce a false refusal.
    expect(toolResultRenderRefusal({ structuredContent: RENDERED_PRE_0_14 })).toBeUndefined();
  });

  it("a FAILED result (§7.1 envelope, identity committed) is not a refusal", () => {
    const failed: JsonValue = {
      outcome: "failed",
      sessionId: "render_2",
      action: "create",
      contractHash: "c10a20553df2349b",
      blueprintId: "bp_1",
      variantKey: "v1",
      cache: { hit: false },
      error: { code: "generation_failed", message: "the model produced no interface" },
    };
    // Whether or not the failure envelope's own `error` shape parses on this
    // version, the answer here is the same: not a refusal.
    expect(toolResultRenderRefusal({ structuredContent: failed })).toBeUndefined();
  });

  it("a payload that only SAYS refused — unregistered code, or no `fix` — is not a refusal (the guard is the protocol's own parse)", () => {
    const unregistered: JsonValue = {
      outcome: "refused",
      refusal: { code: "made_up_code", message: "m", fix: "f", retry: "later", handshake: "intact" },
    };
    const noFix: JsonValue = {
      outcome: "refused",
      refusal: { code: "trial_expired", message: "m", retry: "never", handshake: "intact" },
    };
    expect(toolResultRenderRefusal({ structuredContent: unregistered })).toBeUndefined();
    expect(toolResultRenderRefusal({ structuredContent: noFix })).toBeUndefined();
  });

  it("no structuredContent, or a non-object, is not a refusal", () => {
    expect(toolResultRenderRefusal({})).toBeUndefined();
    expect(toolResultRenderRefusal({ structuredContent: "app_policy_missing" })).toBeUndefined();
    expect(toolResultRenderRefusal({ structuredContent: null })).toBeUndefined();
  });

  it("every registry render-gate code is accepted — the reader never lags the registry", () => {
    for (const code of RENDER_GATE_REFUSAL_CODES) {
      const refusal = toolResultRenderRefusal({
        structuredContent: {
          outcome: "refused",
          refusal: { code, message: "m", fix: "f", retry: "later", handshake: "intact" },
        },
      });
      expect(refusal?.code, code).toBe(code);
    }
  });
});
