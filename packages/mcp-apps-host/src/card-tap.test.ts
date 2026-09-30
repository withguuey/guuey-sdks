/**
 * guuey#2031 — reading a card tap at tap time: the relayed `tools/call`, the
 * doorbell's structured mirror, the runtime's submit-result classifier (a
 * MIRROR, pinned case by case to the three unwrap tiers), and the label a tap
 * resolves to.
 *
 * Every wire value here is SYNTHETIC (`fixtures/card-tap.synthetic.ts` says
 * which runtime construction each copies): no live capture is on file.
 */
import { describe, expect, it } from "vitest";
import type { AgMessage } from "@silverprotocol/core";
import { readSubmitActionTap, readUserActionMeta, resolveTapLabel, submitActionOutcome } from "./card-tap.js";
import type { PaintPart } from "./paint-props.js";
import {
  CHIP_FIND,
  CHIP_HOURS,
  chipTapRequest,
  doorbellParams,
  GREETING_PROPS,
  greetingFold,
  repaintFold,
  SUBMIT_RESULTS,
  SYNTHETIC_SESSION,
} from "./fixtures/card-tap.synthetic.js";

/** Bidi formatting characters, built from code points so this source carries none of them. */
const RLO = String.fromCodePoint(0x202e);

const parts = (messages: readonly AgMessage[]): readonly PaintPart[] => messages.flatMap((m) => m.content);

describe("readSubmitActionTap — the tap inside a relayed tools/call", () => {
  it("reads the render session, the action id and the tapped reply id off a dispatch", () => {
    expect(readSubmitActionTap(chipTapRequest(CHIP_FIND.id))).toEqual({
      renderSessionId: SYNTHETIC_SESSION,
      actionId: "5a5a5a5a",
      dataId: CHIP_FIND.id,
    });
  });

  it("a bare-button dispatch (actionData null) is a tap with no reply id", () => {
    expect(readSubmitActionTap(chipTapRequest(null))).toEqual({ renderSessionId: SYNTHETIC_SESSION, actionId: "5a5a5a5a", dataId: null });
  });

  it("is null for every other runtime tool, for a non-dispatch kind, and for an envelope ggui's own guard refuses", () => {
    expect(readSubmitActionTap(chipTapRequest(CHIP_FIND.id, { name: "ggui_runtime_pull" }))).toBeNull();
    expect(readSubmitActionTap(chipTapRequest(CHIP_FIND.id, { kind: "openLink" }))).toBeNull();
    expect(readSubmitActionTap(chipTapRequest(CHIP_FIND.id, { actionId: "" }))).toBeNull();
    expect(readSubmitActionTap({ resourceUri: "ui://x", name: "ggui_runtime_submit_action" })).toBeNull();
  });
});

describe("readUserActionMeta — the doorbell's structured mirror", () => {
  it("reads the action id and session off the first content block's meta", () => {
    expect(readUserActionMeta(doorbellParams("5a5a5a5a"))).toEqual({ actionId: "5a5a5a5a", sessionId: SYNTHETIC_SESSION });
  });

  it("is null without the meta, or with it anywhere but the first block", () => {
    expect(readUserActionMeta(doorbellParams(null))).toBeNull();
    const params = doorbellParams("5a5a5a5a");
    const content = params["content"];
    expect(Array.isArray(content)).toBe(true);
    const moved = { ...params, content: [{ type: "text", text: "lead" }, ...(Array.isArray(content) ? content : [])] };
    expect(readUserActionMeta(moved)).toBeNull();
    expect(readUserActionMeta({})).toBeNull();
    expect(readUserActionMeta({ content: "text" })).toBeNull();
  });
});

describe("submitActionOutcome — the mirror of the runtime's classifier", () => {
  for (const c of SUBMIT_RESULTS) {
    it(`${c.name} → ${c.outcome}`, () => {
      expect(submitActionOutcome(c.result)).toBe(c.outcome);
    });
  }
});

describe("resolveTapLabel — the words a tap shows, at tap time", () => {
  it("a chip on a card painted in this session: the chip's label", () => {
    expect(resolveTapLabel({ request: chipTapRequest(CHIP_FIND.id), parts: parts(greetingFold()) })).toBe(CHIP_FIND.label);
  });

  it("a tap whose id is not a quick reply (a card button): null — the continuation copy", () => {
    expect(resolveTapLabel({ request: chipTapRequest("book-now"), parts: parts(greetingFold()) })).toBeNull();
    expect(resolveTapLabel({ request: chipTapRequest(null), parts: parts(greetingFold()) })).toBeNull();
  });

  it("a host-bound session that differs from the tap's own: null", () => {
    const request = chipTapRequest(CHIP_FIND.id);
    expect(resolveTapLabel({ request, parts: parts(greetingFold()), boundSessionId: SYNTHETIC_SESSION })).toBe(CHIP_FIND.label);
    expect(resolveTapLabel({ request, parts: parts(greetingFold()), boundSessionId: "render_elsewhere" })).toBeNull();
  });

  it("a label the producer normalizer refuses: null, never a trimmed or cut label", () => {
    const props = { ...GREETING_PROPS, quickReplies: [{ id: "bidi", label: `Open ${RLO}me` }, { id: "ws", label: "  Two   words " }] };
    const fold = parts(greetingFold(props));
    expect(resolveTapLabel({ request: chipTapRequest("bidi"), parts: fold })).toBeNull();
    expect(resolveTapLabel({ request: chipTapRequest("ws"), parts: fold })).toBe("Two words");
  });

  it("a card painted before a reload: its mounted document's props are the base", () => {
    const mountedFor = (sessionId: string) => (sessionId === SYNTHETIC_SESSION ? { sessionId, props: GREETING_PROPS } : undefined);
    expect(resolveTapLabel({ request: chipTapRequest(CHIP_HOURS.id), parts: [], mountedFor })).toBe(CHIP_HOURS.label);
    // Without the mounted document, the same tap has nothing to read.
    expect(resolveTapLabel({ request: chipTapRequest(CHIP_HOURS.id), parts: [] })).toBeNull();
  });

  it("the fold's repaints of a mounted card layer over its document", () => {
    const mountedFor = (sessionId: string) => ({ sessionId, props: GREETING_PROPS });
    const amended = parts(
      repaintFold("ggui_amend", "toolu_amend_9", {
        sessionId: SYNTHETIC_SESSION,
        kind: "replace",
        props: { quickReplies: [{ id: CHIP_HOURS.id, label: "Hours, amended" }] },
      }),
    );
    expect(resolveTapLabel({ request: chipTapRequest(CHIP_HOURS.id), parts: amended, mountedFor })).toBe("Hours, amended");
  });

  it("a mounted document for another session is never the base", () => {
    const mountedFor = () => ({ sessionId: "render_elsewhere", props: GREETING_PROPS });
    expect(resolveTapLabel({ request: chipTapRequest(CHIP_HOURS.id), parts: [], mountedFor })).toBeNull();
  });
});
