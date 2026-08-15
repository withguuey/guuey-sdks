/**
 * Capture-derived corpus inputs (guuey#135 wave 3c — the lesson from 3b's
 * dogfood finding 1: the hand-driven corpus passed while the PRODUCTION
 * fold shape failed, because real pods fold tool results into separate
 * `role: "tool"` messages the hand-built sequences never produce).
 *
 * The rule this module enforces: at least one corpus family is derived
 * from a REAL redacted production capture, replayed through the REAL
 * `invokeTurn` (parse → status → text fold → AgEvent ingest) — so the
 * corpus can never again be green while production shapes are broken.
 *
 * Provenance: `captures/issue2627-render-capture.coalesced.sse.txt` is a byte copy
 * of `apps/widget/src/fixtures/issue2627-render-capture.coalesced.sse.txt` — the
 * redacted production SSE capture of a ggui-render turn (every id
 * remapped to a stable synthetic one of the same shape, credentials
 * dummied; see the widget's `scripts/derive-coalesced-capture.mjs`).
 * COALESCED is the valid production shape; the RAW variant of the same
 * capture deliberately parks the Reducer and stays in the widget as that
 * regression's pin. Captures are immutable records, so the copy cannot
 * drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invokeTurn, type InvokeTurnEvent } from "@guuey/agent-client";
import { driveTurn, type DriveOptions } from "./drive.js";
import type { TranscriptInputs } from "../types.js";

const CAPTURES = join(import.meta.dirname, "captures");

/** The capture's (redacted) render locator — what R6's actionScope must be. */
export const CAPTURE_RENDER_URI =
  "ui://ggui/render/render_00000000-0000-4000-8000-300000000001/c10a20553df2349b";

/**
 * Replay a capture through the REAL `invokeTurn`, chunked adversarially
 * (fixed-size slices that split SSE frames mid-line) so the parse path is
 * exercised the way a network delivers it, not a fixture's convenience.
 */
export async function captureTurnEvents(
  file: string,
  chunkSize = 512,
): Promise<InvokeTurnEvent[]> {
  const text = readFileSync(join(CAPTURES, file), "utf8");
  const transport = async function* (): AsyncGenerator<string> {
    for (let at = 0; at < text.length; at += chunkSize) {
      yield text.slice(at, at + chunkSize);
    }
  };
  const events: InvokeTurnEvent[] = [];
  const req = {
    url: "https://capture.replay.invalid/agent/invoke",
    body: { input: "capture replay" },
    signal: new AbortController().signal,
  };
  for await (const event of invokeTurn(req, transport)) events.push(event);
  return events;
}

/** The ggui-render production capture as `TranscriptInputs`. */
export async function productionGguiRenderCapture(
  opts: DriveOptions = {},
): Promise<TranscriptInputs> {
  const events = await captureTurnEvents("issue2627-render-capture.coalesced.sse.txt");
  // The capture ends without a `done` frame (capture-time truncation);
  // the corpus family asserts the SETTLED plan, so the drive settles it.
  return driveTurn(events, { userText: "capture replay", finalStatus: "ready", ...opts });
}
