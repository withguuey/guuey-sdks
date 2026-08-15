/**
 * The corpus runner: every §8 fixture's named property, plus a full plan
 * snapshot per fixture (the reviewable rendering record). Plain-Node vitest
 * — mirror-CI-safe; the browser render of the same corpus is 3b's
 * Storybook/screenshot leg.
 */
import { describe, expect, it } from "vitest";
import { calmPolicy, debugPolicy } from "../policy.js";
import { planTranscript } from "../plan.js";
import type { DisplayItem, ToolGroupItem, ToolItem, ViewMountItem } from "../types.js";
import {
  abortedMidStream,
  bypassVsSilver,
  coldStart,
  consentGate,
  emptyTurn,
  fortyTools,
  giantJsonResult,
  historyDeadLocators,
  interleavedMediaCodeCitations,
  midstreamToolFailure,
  reasoningHeavy,
  saturatedThenServed,
  stalledThenAdopted,
  toolsAroundAView,
  unknownBlockStorm,
  userSendFailure,
  viewNeverHandshakes,
} from "./fixtures.js";

const calm = calmPolicy();
const debug = debugPolicy();

/** Every ToolItem in a plan, whether grouped or standalone. */
function allTools(items: DisplayItem[]): ToolItem[] {
  const tools: ToolItem[] = [];
  for (const item of items) {
    if (item.kind === "tool") tools.push(item);
    if (item.kind === "tool-group") tools.push(...item.tools);
  }
  return tools;
}

describe("corpus", () => {
  it("1. forty-tools — grouping caps the rows; plan stays O(groups); keys stable", () => {
    const { full, midStream } = fortyTools();
    const plan = planTranscript(full, calm);
    // user + ONE group + the closing text — not 42 rows.
    expect(plan.items.map((i) => i.kind)).toEqual(["user", "tool-group", "text"]);
    const group = plan.items[1] as ToolGroupItem;
    expect(group.tools).toHaveLength(40);
    expect(group.failureCount).toBe(0);
    // Key stability: every tool key present mid-stream survives to the full plan.
    const midKeys = new Set(allTools(planTranscript(midStream, calm).items).map((t) => t.key));
    const fullKeys = new Set(allTools(plan.items).map((t) => t.key));
    for (const key of midKeys) expect(fullKeys.has(key)).toBe(true);
    expect(midKeys.has("tool.t7")).toBe(true);
    expect(plan).toMatchSnapshot();
  });

  it("2. midstream-tool-failure — failed inline; badge without unroll", () => {
    const plan = planTranscript(midstreamToolFailure(), calm);
    const group = plan.items.find((i): i is ToolGroupItem => i.kind === "tool-group");
    expect(group).toBeDefined();
    expect(group?.failureCount).toBe(1);
    expect(group?.failureBadge).toBe("1 failed");
    expect(group?.expanded).toBe(false); // badge, not unroll
    expect(group?.tools.find((t) => t.toolCallId === "t3")?.state).toBe("failed");
    expect(plan).toMatchSnapshot();
  });

  it("3. cold-start — R12 escalation at 0 / 2.5 s / 15 s", () => {
    expect(planTranscript(coldStart(0), calm).status?.copy).toBe("Connecting…");
    expect(planTranscript(coldStart(2500), calm).status?.copy).toBe("Starting your agent…");
    expect(planTranscript(coldStart(15_000), calm).status?.copy).toBe(
      "Starting your agent… first load can take a minute",
    );
    expect(planTranscript(coldStart(2500), calm)).toMatchSnapshot();
  });

  it("4. consent-gate — pending card → answered one-line collapse", () => {
    const pending = planTranscript(consentGate("pending"), calm);
    const pendingPrompt = pending.items.find((i) => i.kind === "prompt");
    expect(pendingPrompt?.expanded).toBe(true);
    const answered = planTranscript(consentGate("answered"), calm);
    const answeredPrompt = answered.items.find((i) => i.kind === "prompt");
    expect(answeredPrompt?.expanded).toBe(false);
    expect(pending).toMatchSnapshot();
  });

  it("5. bypass-text-only — plan identical to a silver text-only stream", () => {
    const { bypass, silver } = bypassVsSilver();
    const bypassPlan = planTranscript(bypass, calm);
    const silverPlan = planTranscript(silver, calm);
    expect(bypassPlan).toEqual(silverPlan);
    expect(bypassPlan.items.map((i) => i.kind)).toEqual(["user", "text"]);
    expect(bypassPlan).toMatchSnapshot();
  });

  it("6. giant-json-result — capped, size-labeled, the plan stays cheap", () => {
    const plan = planTranscript(giantJsonResult(), calm);
    const tool = allTools(plan.items).find((t) => t.toolCallId === "t1");
    expect(tool?.result?.state).toBe("giant");
    expect(tool?.result?.showBytes).toBe(true);
    expect(tool?.result?.preview?.length).toBeLessThanOrEqual(2048);
    // No full-payload copies anywhere in the plan (input was ~2 MB).
    expect(JSON.stringify(plan).length).toBeLessThan(10_000);
  });

  it("7. view-never-handshakes — channel-aware labels on both channels", () => {
    const plan = planTranscript(viewNeverHandshakes(), calm);
    const views = plan.items.filter((i): i is ViewMountItem => i.kind === "view");
    expect(views).toHaveLength(2);
    const inline = views.find((v) => v.key === "view.tInline");
    const ggui = views.find((v) => v.key === "view.tGgui");
    expect(inline?.channel).toBe("inline");
    expect(inline?.label).toBe("Showing plain content");
    expect(ggui?.channel).toBe("ggui");
    expect(ggui?.label).toBe("This view couldn't start");
    expect(plan).toMatchSnapshot();
  });

  it("8. aborted-mid-stream — partial kept + Stopped.; no orphaned spinner", () => {
    const plan = planTranscript(abortedMidStream(), calm);
    const text = plan.items.find((i) => i.kind === "text");
    expect(text?.kind === "text" && text.text).toBe("I was saying");
    expect(text?.kind === "text" && text.stopped).toBe(true);
    const tool = allTools(plan.items).find((t) => t.toolCallId === "t9");
    expect(tool?.state).toBe("orphaned"); // settled, never a spinner
    expect(plan.status?.state).toBe("aborted");
    expect(plan.status?.copy).toBe("Stopped.");
    expect(plan).toMatchSnapshot();
  });

  it("9. history-dead-locators — the expired path beside a healthy card", () => {
    const plan = planTranscript(historyDeadLocators(), calm);
    const views = plan.items.filter((i): i is ViewMountItem => i.kind === "view");
    const alive = views.find((v) => v.key === "card.1");
    const dead = views.find((v) => v.key === "card.2");
    expect(alive?.channel).toBe("locator");
    expect(alive?.phase).toBe("negotiating");
    expect(dead?.phase).toBe("expired");
    expect(dead?.mount).toBeNull();
    expect(dead?.label).toBe("This view expired");
    expect(plan).toMatchSnapshot();
  });

  it("10. empty-turn — status resolves, no empty bubble", () => {
    const plan = planTranscript(emptyTurn(), calm);
    expect(plan.items.map((i) => i.kind)).toEqual(["user"]);
    expect(plan.status).toBeNull();
    expect(plan).toMatchSnapshot();
  });

  it("11. unknown-block-storm — labeled rows; nothing blank, nothing raw in calm", () => {
    const calmPlan = planTranscript(unknownBlockStorm(), calm);
    const unknowns = calmPlan.items.filter((i) => i.kind === "unknown");
    expect(unknowns).toHaveLength(3);
    for (const u of unknowns) {
      expect(u.kind === "unknown" && u.label).toBe("Unrecognized content");
      expect(u.kind === "unknown" && u.byteSize).toBeGreaterThan(0);
      expect(u.kind === "unknown" && u.raw).toBeNull(); // calm: type + size only
    }
    const debugPlan = planTranscript(unknownBlockStorm(), debug);
    const debugUnknown = debugPlan.items.find((i) => i.kind === "unknown");
    expect(debugUnknown?.kind === "unknown" && debugUnknown.raw).not.toBeNull();
    expect(calmPlan).toMatchSnapshot();
  });

  it("12. interleaved-media-code-citations — ordering and aggregation", () => {
    const plan = planTranscript(interleavedMediaCodeCitations(), calm);
    const kinds = plan.items.map((i) => i.kind);
    expect(kinds).toEqual(["user", "media", "code", "citations", "text"]);
    const citations = plan.items.find((i) => i.kind === "citations");
    expect(citations?.kind === "citations" && citations.sources).toHaveLength(2);
    expect(citations?.kind === "citations" && citations.label).toBe("2 sources");
    expect(plan).toMatchSnapshot();
  });

  it("13. saturated-then-served — only R12 waiting, then a normal turn", () => {
    const { waiting, served } = saturatedThenServed();
    const waitingPlan = planTranscript(waiting, calm);
    expect(waitingPlan.status?.state).toBe("starting"); // the retry is invisible
    expect(waitingPlan.items.map((i) => i.kind)).toEqual(["user"]);
    const servedPlan = planTranscript(served, calm);
    expect(servedPlan.status).toBeNull();
    expect(servedPlan.items.some((i) => i.kind === "error")).toBe(false);
    expect(servedPlan).toMatchSnapshot();
  });

  it("14. reasoning-heavy — calm collapses to one line; debug expands", () => {
    const inputs = reasoningHeavy();
    const calmReasoning = planTranscript(inputs, calm).items.find((i) => i.kind === "reasoning");
    expect(calmReasoning?.expanded).toBe(false);
    expect(calmReasoning?.kind === "reasoning" && calmReasoning.label).toBe("Thought for a moment");
    const debugReasoning = planTranscript(inputs, debug).items.find((i) => i.kind === "reasoning");
    expect(debugReasoning?.expanded).toBe(true);
    expect(planTranscript(inputs, calm)).toMatchSnapshot();
  });

  it("15. tools-around-a-view — the group SPLITS at the view's position", () => {
    const plan = planTranscript(toolsAroundAView(), calm);
    const kinds = plan.items.map((i) => i.kind);
    // user · group(t1,t2) · attributed call line folds into · view · group(t4,t5)
    expect(kinds).toEqual(["user", "tool-group", "tool", "view", "tool-group"]);
    const groups = plan.items.filter((i): i is ToolGroupItem => i.kind === "tool-group");
    expect(groups[0].key).toBe("g.tool.t1");
    expect(groups[0].tools.map((t) => t.toolCallId)).toEqual(["t1", "t2"]);
    expect(groups[1].key).toBe("g.tool.t4");
    expect(groups[1].tools.map((t) => t.toolCallId)).toEqual(["t4", "t5"]);
    // The view is NEVER inside a collapse; its call line is attribution-folded.
    const view = plan.items.find((i): i is ViewMountItem => i.kind === "view");
    expect(view?.key).toBe("view.t3");
    expect(view?.attribution).toBe("via ggui render");
    const breaking = plan.items.find((i) => i.kind === "tool");
    expect(breaking?.kind === "tool" && breaking.attribution).toBe(true);
    expect(plan).toMatchSnapshot();
  });

  it("16. user-send-failure — R0 failed with retry; the message never disappears", () => {
    const plan = planTranscript(userSendFailure(), calm);
    expect(plan.items.map((i) => i.kind)).toEqual(["user"]);
    const user = plan.items[0];
    expect(user.kind === "user" && user.state).toBe("failed");
    expect(user.kind === "user" && user.retry).toBe(true);
    expect(user.kind === "user" && user.text).toBe("did this go through?");
    expect(plan).toMatchSnapshot();
  });

  it("17. stalled-then-adopted — calm identical; debug carries the marker (#192)", () => {
    const { adopted, streamed } = stalledThenAdopted();
    expect(planTranscript(adopted, calm)).toEqual(planTranscript(streamed, calm));
    expect(planTranscript(adopted, calm).recovery).toBeNull();
    expect(planTranscript(adopted, debug).recovery).toBe("recovered from history");
    expect(planTranscript(streamed, debug).recovery).toBeNull();
  });

  it("determinism — same inputs ⇒ a deeply equal plan (spec §7, literally)", () => {
    const inputs = midstreamToolFailure();
    expect(planTranscript(inputs, calm)).toEqual(planTranscript(inputs, calm));
    expect(planTranscript(inputs, debug)).toEqual(planTranscript(inputs, debug));
  });

  it("overrides — a carried user expansion wins over the policy default", () => {
    const inputs = midstreamToolFailure();
    const plan = planTranscript(inputs, calm, { "g.tool.t1": { expanded: true } });
    const group = plan.items.find((i) => i.kind === "tool-group");
    expect(group?.expanded).toBe(true);
  });
});
