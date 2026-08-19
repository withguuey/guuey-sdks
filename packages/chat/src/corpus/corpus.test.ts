/**
 * The corpus runner: every §8 fixture's named property, plus a full plan
 * snapshot per fixture (the reviewable rendering record). Plain-Node vitest
 * — mirror-CI-safe; the browser render of the same corpus is 3b's
 * Storybook/screenshot leg.
 */
import { describe, expect, it } from "vitest";
import { createMcpUiResourceReader, resolveViewMount } from "@guuey/mcp-apps-host";
import { calmPolicy, debugPolicy } from "../policy.js";
import { buildHitlAnswer, hitlPromptsFromFold } from "../hitl.js";
import { oauthAuthorizeAsk, oauthAuthorizeHref } from "../oauth.js";
import { newestViewKey, planTranscript } from "../plan.js";
import type { DisplayItem, ToolGroupItem, ToolItem, ViewMountItem, ViewRefItem } from "../types.js";
import {
  abortedMidStream,
  bypassVsSilver,
  coldStart,
  consentGate,
  emptyTurn,
  fortyTools,
  GGUI_RESOURCE_URI,
  gguiReadShell,
  PROD_WIRE_RENDER_URI,
  PROD_WIRE_RUNTIME_URL,
  PROD_WIRE_WS_URL,
  prodWireGguiRender,
  giantJsonResult,
  historyDeadLocators,
  interleavedMediaCodeCitations,
  metaLessLocator,
  midstreamToolFailure,
  persistedPlusLive,
  promotedView,
  reasoningHeavy,
  saturatedThenServed,
  stalledThenAdopted,
  hitlGrantModes,
  noticeRows,
  OAUTH_ASK_AUTHORIZE_URL,
  oauthAuthAsk,
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

  it("4. consent-gate — pending grant-mode card → answered one-line collapse (guuey#207 hitl arm)", () => {
    const pending = planTranscript(consentGate("pending"), calm);
    const pendingPrompt = pending.items.find((i) => i.kind === "prompt");
    expect(pendingPrompt?.expanded).toBe(true);
    expect(pendingPrompt).toMatchObject({
      promptKind: "hitl",
      askKind: "approval",
      grantModes: [expect.objectContaining({ id: "always" }), expect.objectContaining({ id: "once" })],
      state: "pending",
    });
    const answered = planTranscript(consentGate("answered"), calm);
    const answeredPrompt = answered.items.find((i) => i.kind === "prompt");
    expect(answeredPrompt?.expanded).toBe(false);
    expect(answeredPrompt).toMatchObject({ promptKind: "hitl", state: "resolved", chosenModeLabel: "Always allow" });
    // The agent's own settled text is untouched by the trailing paused turn.
    expect(pending.items.some((i) => i.kind === "text")).toBe(true);
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
    // guuey#209: the ggui vendor arm is retired — a ggui render (even one
    // still carrying its `_meta` bootstrap) is a LOCATOR at plan time; the
    // "ggui" trust channel is assigned at resolution from the uri. The
    // channel-aware label still names it a boot failure, by the same rule.
    expect(ggui?.channel).toBe("locator");
    expect(ggui?.mount).toEqual({ channel: "locator", resourceUri: GGUI_RESOURCE_URI });
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

  it("19. persisted-plus-live — the fold owns its trailing turns; the prefix stays flat; overlapping cards dedupe", () => {
    const inputs = persistedPlusLive();
    const plan = planTranscript(inputs, calm);

    // The persisted prefix turn (the fold never saw it) renders as flat text.
    const texts = plan.items.filter((i) => i.kind === "text");
    expect(texts.some((t) => t.kind === "text" && t.text === "Here are some options.")).toBe(true);
    // The fold's settled turn renders RICH: its text and its view mount.
    expect(texts.some((t) => t.kind === "text" && t.text === "Booked the second option.")).toBe(true);
    // ...and exactly once — the trailing flat duplicate was replaced, not doubled.
    expect(texts.filter((t) => t.kind === "text" && t.text === "Booked the second option.")).toHaveLength(1);
    const views = plan.items.filter((i): i is ViewMountItem => i.kind === "view");
    const liveView = views.find((v) => v.key === "view.tA");
    expect(liveView?.actionScope).toBe(
      "ui://ggui/render/render_00000000-0000-4000-8000-300000000001/c0ffee",
    );
    // The live turn's completed tool renders as a ROW mid-turn, and the
    // still-active call rides the status line (the acceptance: thread-view
    // live turns light up like agent-chat's).
    const liveTool = allTools(plan.items).find((t) => t.toolCallId === "tB");
    expect(liveTool?.state).toBe("done");
    expect(plan.status?.state).toBe("using-tool");
    // Turn A's ALSO-persisted card deduped (the live mount owns the identity);
    // the old pre-session card still renders.
    expect(views.some((v) => v.key === "card.5")).toBe(false);
    expect(views.some((v) => v.key === "card.1")).toBe(true);
    // All three user turns present, in order.
    expect(plan.items.filter((i) => i.kind === "user")).toHaveLength(3);
    expect(planTranscript(inputs, calm)).toEqual(plan);
    expect(plan).toMatchSnapshot();
  });

  it("20. hitl-grant-modes — the persisted declaration renders; answers echo; cancelled re-asks (draft.2)", () => {
    const base = hitlGrantModes();
    const ask = (() => {
      const t = base.result?.turns.find((x) => x.outcome?.type === "paused");
      if (t?.outcome?.type !== "paused") throw new Error("fixture must pause");
      return t.outcome.asks[0]!;
    })();

    // Pending: one action per declared mode + the universal decline —
    // rendered from the PERSISTED record, display text = the asker's label.
    const pending = { ...base, prompts: hitlPromptsFromFold(base.result) };
    const pendingPlan = planTranscript(pending, calm);
    const card = pendingPlan.items.find((i) => i.kind === "prompt");
    if (card?.kind !== "prompt" || card.promptKind !== "hitl") throw new Error("hitl card expected");
    expect(card.state).toBe("pending");
    expect(card.message).toBe("Remember your seating preference?");
    expect(card.grantModes.map((m) => m.label ?? m.id)).toEqual(["Always", "Just this chat"]);
    expect(pendingPlan).toMatchSnapshot();

    // Resolved with a mode: the record collapses to the CHOSEN LABEL (ids
    // are echo-only identity). The answer itself validates by construction
    // and carries the requestState byte-echo.
    const answer = buildHitlAnswer(ask, { grantModeId: "m.durable" });
    expect(answer).toEqual({
      askId: "ask-remember-1",
      status: "resolved",
      grantModeId: "m.durable",
      requestState: "rs-bytes-1",
    });
    const resolved = {
      ...base,
      prompts: hitlPromptsFromFold(base.result, {
        "ask-remember-1": { status: "resolved", grantModeId: "m.durable" },
      }),
    };
    const record = planTranscript(resolved, calm).items.find((i) => i.kind === "prompt");
    if (record?.kind !== "prompt" || record.promptKind !== "hitl") throw new Error("hitl record expected");
    expect(record.state).toBe("resolved");
    expect(record.chosenModeLabel).toBe("Always");

    // Dismissal = cancelled = still-pending/re-askable (the #16 ruling):
    // the card collapses to a dismissed record but STAYS answerable when
    // expanded — unlike declined, the durable deny.
    expect(buildHitlAnswer(ask, "dismiss").status).toBe("cancelled");
    expect(buildHitlAnswer(ask, "decline").status).toBe("declined");
    const cancelled = {
      ...base,
      prompts: hitlPromptsFromFold(base.result, { "ask-remember-1": { status: "cancelled" } }),
    };
    const dismissed = planTranscript(cancelled, calm).items.find((i) => i.kind === "prompt");
    if (dismissed?.kind !== "prompt" || dismissed.promptKind !== "hitl") throw new Error("hitl record expected");
    expect(dismissed.state).toBe("cancelled");
    expect(dismissed.expanded).toBe(false);
    const reopened = planTranscript(cancelled, calm, { "p.ask-remember-1": { expanded: true } })
      .items.find((i) => i.kind === "prompt");
    expect(reopened?.kind === "prompt" && reopened.expanded).toBe(true);

    // An undeclared echo can never dispatch: construction throws.
    expect(() => buildHitlAnswer(ask, { grantModeId: "not-declared" })).toThrow();
    // With a declaration, a plain accept can't stand in for a mode pick.
    expect(() => buildHitlAnswer(ask, "accept")).toThrow();
  });

  it("25. oauth-auth-ask — kind:auth + authConfig oauth2 plans as the SAME hitl card with an oauth arm; a mode pick is a link, not an answer (guuey#178)", () => {
    const base = oauthAuthAsk();
    const askId = "mcp-oauth:app_1:linear:thread-oauth";
    const ask = (() => {
      const t = base.result?.turns.find((x) => x.outcome?.type === "paused");
      if (t?.outcome?.type !== "paused") throw new Error("fixture must pause");
      return t.outcome.asks[0]!;
    })();
    // The paused turn folded AFTER the agent's own turn — two turns, one card.
    expect(base.result?.turns.map((t) => t.outcome?.type)).toEqual(["success", "paused"]);

    const pending = { ...base, prompts: hitlPromptsFromFold(base.result) };
    const pendingPlan = planTranscript(pending, calm);
    const card = pendingPlan.items.find((i) => i.kind === "prompt");
    if (card?.kind !== "prompt" || card.promptKind !== "hitl") throw new Error("hitl card expected");
    expect(card.state).toBe("pending");
    expect(card.askKind).toBe("auth");
    expect(card.message).toBe("Trip Planner wants to use your Linear account");
    expect(card.grantModes.map((m) => m.label)).toEqual(["Always allow", "Allow this chat"]);
    // The oauth arm is derived from the persisted declaration — the SAME
    // narrowing every surface uses (`oauthAuthorizeAsk`).
    expect(card.oauth).toEqual({ authorizationUrl: OAUTH_ASK_AUTHORIZE_URL, scopes: [] });
    expect(oauthAuthorizeAsk(ask)).toEqual(card.oauth);
    expect(pendingPlan).toMatchSnapshot();

    // A mode pick is a LINK: authorizationUrl + &mode=<id> + &returnTo=<here>.
    // (Nothing is posted anywhere — there is no answer door for this ask.)
    expect(oauthAuthorizeHref(ask, "once", "https://app.example.com/chat?tab=1")).toBe(
      `${OAUTH_ASK_AUTHORIZE_URL}&mode=once&returnTo=${encodeURIComponent("https://app.example.com/chat?tab=1")}`,
    );
    expect(() => oauthAuthorizeHref(ask, "never-declared", "https://app.example.com/")).toThrow();
    // A family-20 approval ask has no oauth arm.
    expect(oauthAuthorizeAsk({ askId: "x", kind: "approval", grantModes: ask.grantModes })).toBeNull();

    // The local ledger after the pick: the record reads "Connecting — <mode>"
    // (the surface navigates away on web; on native the card stays until the
    // next turn's preflight resolves `connected`).
    const sent = { ...base, prompts: hitlPromptsFromFold(base.result, { [askId]: { status: "resolved", grantModeId: "always" } }) };
    const record = planTranscript(sent, calm).items.find((i) => i.kind === "prompt");
    if (record?.kind !== "prompt" || record.promptKind !== "hitl") throw new Error("hitl record expected");
    expect(record.state).toBe("resolved");
    expect(record.chosenModeLabel).toBe("Always allow");
    expect(record.oauth).not.toBeNull();

    // "Not now" = cancelled = still pending, re-askable — nothing written.
    expect(buildHitlAnswer(ask, "dismiss").status).toBe("cancelled");
    const dismissed = { ...base, prompts: hitlPromptsFromFold(base.result, { [askId]: { status: "cancelled" } }) };
    const rec = planTranscript(dismissed, calm).items.find((i) => i.kind === "prompt");
    expect(rec?.kind === "prompt" && rec.state).toBe("cancelled");
  });

  it("21. notice-rows — both arrival paths render labeled, never agent-voiced (draft.2)", () => {
    const inputs = noticeRows();
    const calmPlan = planTranscript(inputs, calm);
    const notices = calmPlan.items.filter((i) => i.kind === "notice");
    expect(notices).toHaveLength(2);
    // The flat adapter notice precedes the conversation; the fold-borne
    // framework notice anchors before its assistant turn's content.
    expect(notices[0]?.kind === "notice" && notices[0].text).toBe("Session resumed on a new device");
    expect(notices[0]?.kind === "notice" && notices[0].source).toBe("adapter");
    expect(notices[1]?.kind === "notice" && notices[1].text).toBe("Model fell back to concise mode");
    expect(notices[1]?.kind === "notice" && notices[1].source).toBe("framework");
    // Calm hides provenance; debug shows the facet verbatim.
    expect(notices.every((n) => n.kind === "notice" && n.sourceLabel === null)).toBe(true);
    const debugNotices = planTranscript(inputs, debug).items.filter((i) => i.kind === "notice");
    expect(debugNotices[0]?.kind === "notice" && debugNotices[0].sourceLabel).toBe("adapter");
    // A notice is never an assistant bubble: the assistant text renders
    // separately and exactly once.
    const texts = calmPlan.items.filter((i) => i.kind === "text");
    expect(texts.filter((t) => t.kind === "text" && t.text === "Done.")).toHaveLength(1);
    expect(texts.some((t) => t.kind === "text" && t.text.includes("concise mode"))).toBe(false);
    expect(calmPlan).toMatchSnapshot();
  });

  it("23. meta-less-locator — a `_meta`-withholding producer's render still mounts (as a locator), never dark (guuey#209)", () => {
    const inputs = metaLessLocator();
    const plan = planTranscript(inputs, calm);
    const view = plan.items.find((i): i is ViewMountItem => i.kind === "view");
    expect(view).toBeDefined();
    expect(view?.key).toBe("view.t1");
    expect(view?.channel).toBe("locator");
    expect(view?.mount).toEqual({ channel: "locator", resourceUri: "ui://ggui/render/render_dark/h1" });
    // The #158 action scope binds to the same locator, whichever channel carried it.
    expect(view?.actionScope).toBe("ui://ggui/render/render_dark/h1");
    // The #204 promotion walk sees it too — a meta-less card can be the stage's newest.
    expect(newestViewKey(inputs)?.key).toBe("view.t1");
    // Nothing degraded to R15 — a locator is a first-class mount, not unknown content.
    expect(plan.items.some((i) => i.kind === "unknown")).toBe(false);
    expect(plan).toMatchSnapshot();
  });

  it("22. promoted-view — the stage's mount chips (guuey#204); others stay; no/stale key = no-op", () => {
    const { inputs, promotedKey } = promotedView();
    // Hosts derive the key, never hand-build it.
    expect(newestViewKey(inputs)?.key).toBe(promotedKey);
    const baseline = planTranscript(inputs, calm);
    expect(
      baseline.items.filter((i): i is ViewMountItem => i.kind === "view").map((v) => v.key),
    ).toEqual(["view.t1", "view.t2"]);
    const promoted = planTranscript({ ...inputs, promotedViewKey: promotedKey }, calm);
    const byKey = new Map(promoted.items.map((i) => [i.key, i]));
    const ref = byKey.get(promotedKey);
    expect(ref?.kind).toBe("viewRef");
    expect(ref?.kind === "viewRef" && ref.label).toContain("on canvas");
    // The interactive surface exists exactly ONCE: one full mount remains.
    expect(byKey.get("view.t1")?.kind).toBe("view");
    expect(promoted.items.filter((i) => i.kind === "view")).toHaveLength(1);
    // The chip keeps the mount's key (overrides/phase identity survives).
    const refs = promoted.items.filter((i): i is ViewRefItem => i.kind === "viewRef");
    expect(refs.map((r) => r.key)).toEqual([promotedKey]);
    // No key and a stale key are byte-identical no-ops; the swap is deterministic.
    expect(planTranscript(inputs, calm)).toEqual(baseline);
    expect(planTranscript({ ...inputs, promotedViewKey: "view.nope" }, calm)).toEqual(baseline);
    expect(planTranscript({ ...inputs, promotedViewKey: promotedKey }, calm)).toEqual(promoted);
    expect(promoted).toMatchSnapshot();
  });

  it("25. chips-presentation — EVERY view chips; the promoted key marks the selection; views roster carries the mounts (guuey#301)", () => {
    const { inputs, promotedKey } = promotedView();
    const chips = calmPolicy({ view: { timeoutMs: 8000, presentation: "chips" } });
    const plan = planTranscript({ ...inputs, promotedViewKey: promotedKey }, chips);
    // No live mounts remain in the transcript — the stage owns the render.
    expect(plan.items.filter((i) => i.kind === "view")).toHaveLength(0);
    const refs = plan.items.filter((i): i is ViewRefItem => i.kind === "viewRef");
    expect(refs.map((r) => r.key)).toEqual(["view.t1", "view.t2"]);
    // Selection: exactly the promoted chip, labeled as on-stage.
    expect(refs.map((r) => r.selected)).toEqual([false, true]);
    expect(refs[1]?.label).toContain("on canvas");
    expect(refs[0]?.label).not.toContain("on canvas");
    // The host-canvas contract: mounts survive OUTSIDE the items.
    expect(plan.views.map((v) => v.key)).toEqual(["view.t1", "view.t2"]);
    expect(plan.views.every((v) => v.mount !== null)).toBe(true);
    // Without a promoted key every chip is unselected — same roster.
    const unselected = planTranscript(inputs, chips);
    expect(
      unselected.items.filter((i): i is ViewRefItem => i.kind === "viewRef").map((r) => r.selected),
    ).toEqual([false, false]);
    // Determinism: same inputs + policy ⇒ same plan.
    expect(planTranscript({ ...inputs, promotedViewKey: promotedKey }, chips)).toEqual(plan);
    expect(plan).toMatchSnapshot();
  });

  it("24. prod-wire-ggui-render — ggui's production posture: no _meta, no uiData, a structuredContent locator → mounts as a locator (guuey#209)", () => {
    const inputs = prodWireGguiRender();
    const plan = planTranscript(inputs, calm);
    const view = plan.items.find((i): i is ViewMountItem => i.kind === "view");
    expect(view).toBeDefined();
    expect(view?.key).toBe("view.t1");
    // The retired arm never runs: the plan carries the LOCATOR, and the
    // channel at plan time is the arm ("locator"), not a vendor tag.
    expect(view?.channel).toBe("locator");
    expect(view?.mount).toEqual({ channel: "locator", resourceUri: PROD_WIRE_RENDER_URI });
    // #158's action scope binds to the same durable locator.
    expect(view?.actionScope).toBe(PROD_WIRE_RENDER_URI);
    // The producing call folds into the card's chrome (R4 display-bearing).
    expect(view?.attribution).not.toBeNull();
    // #204's promotion walk sees the prod-shaped card as the newest.
    expect(newestViewKey(inputs)?.key).toBe("view.t1");
    // Nothing hits R15 — this is a first-class mount, not unknown content.
    expect(plan.items.some((i) => i.kind === "unknown")).toBe(false);
    expect(plan).toMatchSnapshot();
  });

  it("24b. the prod-wire locator resolves through the REAL reader assembly to the ggui channel + the runtime shell", async () => {
    const plan = planTranscript(prodWireGguiRender(), calm);
    const view = plan.items.find((i): i is ViewMountItem => i.kind === "view");
    const requested: string[] = [];
    const reader = createMcpUiResourceReader({
      readResource: (uri) => {
        requested.push(uri);
        return Promise.resolve({
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: gguiReadShell({ runtimeUrl: PROD_WIRE_RUNTIME_URL, wsUrl: PROD_WIRE_WS_URL }),
        });
      },
    });
    const resolved = await resolveViewMount(view?.mount ?? undefined, reader);
    // ONE read of the plan's own locator…
    expect(requested).toEqual([PROD_WIRE_RENDER_URI]);
    // …the "ggui" sandbox-trust channel — the reader's `uiResourceChannel`
    // verdict on the REQUESTED uri, assigned at resolution, never carried in
    // from the tool result (which carried nothing to carry)…
    expect(resolved?.channel).toBe("ggui");
    if (resolved?.channel !== "ggui") throw new Error("narrowed above");
    // …and the mount material: ggui's runtime + the live channel minted at
    // read time (C2). Everything the bootstrap arm used to inline, fresher.
    expect(resolved.resource.uri).toBe(PROD_WIRE_RENDER_URI);
    expect(resolved.resource.text).toContain(PROD_WIRE_RUNTIME_URL);
    expect(resolved.resource.text).toContain("__GGUI_META__");
    expect(resolved.resource.text).toContain(PROD_WIRE_WS_URL);
    expect(resolved.resource.text).toContain("minted-fresh-at-read");
  });

  it("24c. a bootstrap-carrying render (fixture 7's shape) takes the SAME locator arm — same visual outcome, different arm", async () => {
    // Family 7 still carries `_meta["ai.ggui/render"]` on its ggui result (a
    // pod that inlines mount material). Post-retirement the bootstrap is
    // inert: same locator arm as the prod-wire shape, same reader, same
    // channel + shell out — the visual outcome is unchanged; only the arm
    // that produced it moved.
    const plan = planTranscript(viewNeverHandshakes(), calm);
    const ggui = plan.items.find((i): i is ViewMountItem => i.kind === "view" && i.key === "view.tGgui");
    expect(ggui?.mount).toEqual({ channel: "locator", resourceUri: GGUI_RESOURCE_URI });
    const reader = createMcpUiResourceReader({
      readResource: (uri) =>
        Promise.resolve({
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: gguiReadShell({ runtimeUrl: PROD_WIRE_RUNTIME_URL, wsUrl: PROD_WIRE_WS_URL }),
        }),
    });
    const resolved = await resolveViewMount(ggui?.mount ?? undefined, reader);
    expect(resolved?.channel).toBe("ggui");
    expect(resolved?.resource.uri).toBe(GGUI_RESOURCE_URI);
    expect(resolved?.resource.text).toContain("__GGUI_META__");
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
