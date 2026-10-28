// @vitest-environment jsdom
/**
 * guuey#2453 — the error item's face follows its planned tone. `retry` (an
 * app that did not wake in time: nothing is broken) draws the plain surface
 * with no error tint, and the in-place Retry is the only cue; `fault` (and an
 * item built without a tone) keeps the error tint.
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
    expect(screen.getByRole("alert").textContent).toContain("Your agent didn't wake up in time. Try again.");
    expect(screen.getByRole("button").textContent).toBe(defaultChatStrings.userRetry);
  });

  it("a fault item, and an item built without a tone, wear the fault class", () => {
    render(<DefaultError item={item("fault")} ctx={ctx()} />);
    expect(toneClass()).toEqual(["guuey-chat-error-fault"]);
    cleanup();
    render(<DefaultError item={item(undefined)} ctx={ctx()} />);
    expect(toneClass()).toEqual(["guuey-chat-error-fault"]);
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

  it("the stylesheet draws the retry line in the plain text colour, and its Retry without the error colour", () => {
    const text = declarations(".guuey-chat-send-failed-retry");
    expect(text).toMatch(/color:\s*var\(--guuey-chat-ink, var\(--_guuey-chat-ink\)\)/);
    expect(text).not.toContain("chat-error");
    const retry = declarations(".guuey-chat-send-failed-retry .guuey-chat-retry");
    expect(retry).toMatch(/color:\s*var\(--guuey-chat-accent/);
    expect(retry).not.toContain("chat-error");
    // The fault line keeps its error colour.
    expect(declarations(".guuey-chat-send-failed")).toContain("--guuey-chat-error");
  });
});
