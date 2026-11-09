/**
 * guuey#2381 — the `@guuey/chat/a2ui` subpath: a producer validates the
 * carrier it emits with the same validator the planner folds through. The
 * example carrier is the corpus's booking form (F1), the one the producer
 * docs will show (spec §14 S6 (d)).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { InvokeTurnEvent } from "@guuey/agent-client";
import { isJsonObject } from "@guuey/mcp-apps-host";
import { A2UI_CARRIER_KEY, validateA2uiCarrier } from "./a2ui.js";

interface StreamFixture {
  events: InvokeTurnEvent[];
}

describe("@guuey/chat/a2ui", () => {
  it("validates the corpus example carrier: one interactive surface that draws natively", () => {
    const f: StreamFixture = JSON.parse(
      readFileSync(new URL("./corpus/fixtures/a2ui-n1-old-client-live.json", import.meta.url), "utf8"),
    );
    const carriers = f.events.flatMap((e) =>
      e.kind === "message"
        ? (e.agEvents ?? []).flatMap((ev) =>
            ev.type === "tool.done" && isJsonObject(ev.structuredContent) ? [ev.structuredContent[A2UI_CARRIER_KEY]] : [],
          )
        : [],
    );
    expect(carriers).toHaveLength(1);
    const [carrier] = carriers;
    if (carrier === undefined) return;
    const out = validateA2uiCarrier(carrier);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [surface] = out.surfaces;
    expect(surface?.kind).toBe("drawn");
    if (surface?.kind !== "drawn") return;
    expect(surface.surface).toMatchObject({ surfaceId: "booking-1", title: "Book a table", interactive: true, degrade: {} });
  });
});
