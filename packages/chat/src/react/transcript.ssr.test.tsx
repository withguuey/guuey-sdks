// @vitest-environment jsdom
/**
 * `<Transcript>` under SSR → hydrate. The kit advertises server rendering
 * (`transcriptInputsFromHistory` is the SSR seam), so its markup must hydrate
 * without a mismatch — for the empty transcript a page renders on load AND for
 * a mid-reply transcript a page might render from history. Established while
 * bisecting guuey#216 (which turned out to be widget-local — a render-time
 * framing branch — not the kit); this keeps the kit's SSR claim honest.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import { GUUEY_CHAT_THEME } from "../theme.js";
import { calmPolicy } from "../policy.js";
import { planTranscript } from "../plan.js";
import type { TranscriptInputs } from "../types.js";
import { Transcript } from "./transcript.js";

const noopCtx = { onToggle: () => {}, resolvedMounts: new Map<string, never>(), onViewPhase: () => {} };

function inputs(over: Partial<TranscriptInputs> = {}): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [],
    ...over,
  };
}

describe("Transcript SSR → hydrate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("empty ready transcript hydrates without warning", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(" ")); });
    const plan = planTranscript(inputs(), calmPolicy());
    const el = <Transcript plan={plan} theme={GUUEY_CHAT_THEME} mode="light" {...noopCtx} />;
    const host = document.createElement("div");
    host.innerHTML = renderToString(el);
    document.body.appendChild(host);
    await act(async () => { hydrateRoot(host, el); });
    expect(errors.filter((e) => /hydrat|418|did not match/i.test(e))).toEqual([]);
  });

  it("first-reply state hydrates without warning (server rendered THIS state)", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(" ")); });
    const plan = planTranscript(
      inputs({
        status: "responding",
        assistantText: "Happy to explore that!",
        messages: [{ role: "user", text: "hi" }],
      }),
      calmPolicy(),
    );
    const el = <Transcript plan={plan} theme={GUUEY_CHAT_THEME} mode="light" {...noopCtx} />;
    const host = document.createElement("div");
    host.innerHTML = renderToString(el);
    document.body.appendChild(host);
    await act(async () => { hydrateRoot(host, el); });
    expect(errors.filter((e) => /hydrat|418|did not match/i.test(e))).toEqual([]);
  });
});
