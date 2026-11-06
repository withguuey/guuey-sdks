// @vitest-environment jsdom
/**
 * guuey#2453 — the error item's face follows its planned tone. `retry` (an
 * app that did not wake in time: nothing is broken) draws the plain surface
 * with no error tint, and the in-place Retry is the only cue; an item without
 * a tone is a fault and keeps the error tint (the `failureTone` convention).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DefaultError, DefaultUserMessage, type TranscriptItemContext } from "./components.js";
import { defaultChatStrings } from "../strings.js";
import type { ErrorItem, UserMessageItem } from "../types.js";

afterEach(cleanup);

const css = readFileSync(join(import.meta.dirname, "..", "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The concatenated declarations of every block whose selector list includes exactly `selector`. */
function declarations(selector: string): string {
  let out = "";
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    if ((m[1] ?? "").split(",").map((s) => s.trim()).includes(selector)) out += m[2] ?? "";
  }
  return out;
}

const ctx = (): TranscriptItemContext => ({
  strings: defaultChatStrings,
  onToggle: vi.fn(),
  resolvedMounts: new Map(),
  onViewPhase: vi.fn(),
  onErrorAction: vi.fn(),
});

const item = (tone: ErrorItem["tone"]): ErrorItem => ({
  kind: "error",
  key: "error",
  expanded: true,
  family: "transient",
  code: tone === "retry" ? "WAKE_TIMED_OUT" : "TIMEOUT",
  message: "agent responded 503",
  copy: tone === "retry" ? defaultChatStrings.errorWakeTimedOut : defaultChatStrings.errorTransient,
  verbatim: null,
  ...(tone !== undefined ? { tone } : {}),
});

/** The alert's tone class: the one that is neither the base nor the family class. */
function toneClass(): string[] {
  const alert = screen.getByRole("alert");
  return Array.from(alert.classList).filter((c) => c !== "guuey-chat-error" && c !== "guuey-chat-error-transient");
}

describe("DefaultError tone (guuey#2453)", () => {
  it("a retry item wears the retry class and keeps its in-place Retry", () => {
    render(<DefaultError item={item("retry")} ctx={ctx()} />);
    expect(toneClass()).toEqual(["guuey-chat-error-retry"]);
    expect(screen.getByRole("alert").textContent).toContain("This agent didn't wake up in time. Please try again.");
    expect(screen.getByRole("button").textContent).toBe(defaultChatStrings.userRetry);
  });

  it("an item without a tone is a fault and wears the fault class", () => {
    render(<DefaultError item={item(undefined)} ctx={ctx()} />);
    expect(toneClass()).toEqual(["guuey-chat-error-fault"]);
  });

  it("both Retry buttons wear the accent: the retry row's by its tone rule, a failed send's chip in both tones by its own", () => {
    const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? [];
    const accent = blocks.filter((b) => /color:\s*var\(--guuey-chat-accent/.test(b) && /-retry\s/.test(b));
    const selectorsOf = (b: string) => b.split("{")[0]!.split(",").map((s) => s.trim());
    expect(accent.map(selectorsOf)).toEqual([[".guuey-chat-error-retry .guuey-chat-error-action"]]);
    // guuey#2611: a failed send's Retry is an accent chip (accent fill, on-accent words) in both tones, and no
    // retry-tone rule overrides it, so a fault's Retry never takes the error colour and the chip's words keep their pair.
    expect(declarations(".guuey-chat-retry")).toMatch(/background:\s*var\(--guuey-chat-accent/);
    expect(blocks.filter((b) => b.includes(".guuey-chat-send-failed-retry .guuey-chat-retry"))).toEqual([]);
  });

  it("the stylesheet draws the retry tone on the plain surface, with no error tint on the box or its Retry", () => {
    const box = declarations(".guuey-chat-error-retry");
    expect(box).toMatch(/background:\s*var\(--guuey-chat-surface, var\(--_guuey-chat-surface\)\)/);
    expect(box).toMatch(/border-color:\s*var\(--guuey-chat-canvas-muted/);
    expect(box).not.toContain("chat-error");
    const action = declarations(".guuey-chat-error-retry .guuey-chat-error-action");
    expect(action).toMatch(/color:\s*var\(--guuey-chat-accent/);
    expect(action).not.toContain("chat-error");
    // The base box (the fault face) keeps its tint.
    expect(declarations(".guuey-chat-error")).toContain("--guuey-chat-error");
  });
});

describe("the refused bubble's tone (guuey#2453)", () => {
  const failed = (failureTone?: "retry"): UserMessageItem => ({
    kind: "user",
    key: "u0",
    expanded: true,
    text: "hello",
    directive: false,
    state: "failed",
    retry: true,
    failureLine: defaultChatStrings.errorWakeTimedOut,
    ...(failureTone !== undefined ? { failureTone } : {}),
  });
  const line = () => document.querySelector(".guuey-chat-send-failed");

  it("a retry bubble's line wears the retry class and keeps its Retry", () => {
    render(<DefaultUserMessage item={failed("retry")} ctx={ctx()} />);
    expect(Array.from(line()?.classList ?? [])).toEqual(["guuey-chat-send-failed", "guuey-chat-send-failed-retry"]);
    expect(screen.getByText(defaultChatStrings.userRetry)).toBeTruthy();
  });

  it("a bubble without a tone draws as before", () => {
    render(<DefaultUserMessage item={failed()} ctx={ctx()} />);
    expect(Array.from(line()?.classList ?? [])).toEqual(["guuey-chat-send-failed"]);
  });

  it("the stylesheet draws the retry line in the plain text colour, and Retry without the error colour in both tones", () => {
    const text = declarations(".guuey-chat-send-failed-retry");
    expect(text).toMatch(/color:\s*var\(--guuey-chat-ink, var\(--_guuey-chat-ink\)\)/);
    expect(text).not.toContain("chat-error");
    const retry = declarations(".guuey-chat-retry");
    expect(retry).toMatch(/background:\s*var\(--guuey-chat-accent/);
    expect(retry).toMatch(/color:\s*var\(--guuey-chat-on-accent/);
    expect(retry).not.toContain("chat-error");
    // The fault line keeps its error colour.
    expect(declarations(".guuey-chat-send-failed")).toContain("--guuey-chat-error");
  });
});
