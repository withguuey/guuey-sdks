// @vitest-environment jsdom
/**
 * guuey#2382 — the web kit turns A2UI rendering on for `<GuueyChat>` only;
 * the native kit has no renderer until its own leg, so a native host plans
 * with a policy that has no `a2ui` key, and that plan must be byte-identical
 * to the old client's (spec §10, N−1). Pinned on the `a2ui-n1-old-client-live`
 * fixture against its base-sha snapshot, planned as a native host plans
 * (`calmPolicy()`), and handed to `<NativeTranscript>`, whose list receives
 * exactly those items: the tool row with its JSON preview, no `a2ui` item.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { createElement, forwardRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayItem } from "../types.js";

const list = vi.hoisted(() => ({ data: null as DisplayItem[] | null }));

vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  const FlatList = forwardRef<unknown, { data: DisplayItem[] }>(function FlatList(props, _ref) {
    list.data = props.data;
    return null;
  });
  return {
    View: passthrough("div"),
    Text: passthrough("span"),
    ScrollView: passthrough("div"),
    Image: passthrough("img"),
    Pressable: passthrough("button"),
    FlatList,
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(false),
      addEventListener: () => ({ remove: () => {} }),
    },
    Linking: { openURL: () => Promise.resolve() },
  };
});

const { NativeTranscript } = await import("./transcript.js");
const { calmPolicy } = await import("../policy.js");
const { planTranscript } = await import("../plan.js");
const { driveTurn } = await import("../corpus/drive.js");

afterEach(cleanup);

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
const fixture = JSON.parse(readFileSync(join(CORPUS, "fixtures", "a2ui-n1-old-client-live.json"), "utf8"));
const snapshot = readFileSync(join(CORPUS, "__snapshots__", "a2ui-n1-old-client-live.snap"), "utf8");

describe("the native kit with a policy that has no a2ui plans as the old client did (guuey#2382, N−1)", () => {
  it("the plan is byte-identical to the base-sha snapshot, and the list draws exactly its items", () => {
    const policy = calmPolicy();
    expect(Object.hasOwn(policy, "a2ui")).toBe(false);
    const plan = planTranscript(driveTurn(fixture.events, { userText: fixture.userText }), policy);
    expect(`${JSON.stringify(plan, null, 2)}\n`).toBe(snapshot);

    render(<NativeTranscript plan={plan} onToggle={() => {}} resolvedMounts={new Map()} onViewPhase={() => {}} />);
    const drawn = [...(list.data ?? [])].reverse();
    expect(JSON.stringify(drawn)).toBe(JSON.stringify(plan.items));
    expect(drawn.some((i) => i.kind === "a2ui")).toBe(false);
    const tool = drawn.find((i) => i.kind === "tool");
    expect(tool?.kind === "tool" ? tool.result?.kind : undefined).toBe("data-result");
  });
});
