// @vitest-environment jsdom
/**
 * WORKER_POD_RESOURCE_EXHAUSTED: the turn hit a temporary capacity limit and
 * was stopped. It reaches a client two ways, with one envelope: the in-band
 * `event: error` / `{code, message}` mid-turn, or a 503 + `Retry-After`
 * refusal before the stream. Either way it is transient: it carries its own
 * reader line, stays in the transient family, and so keeps the Retry button.
 * Nothing is resent automatically (see agent-client's saturation retry).
 *
 * The N−1 half: a client that predates the code knows neither the built-in
 * line nor a family for it. The code path such a client runs for it is the
 * one every unknown code takes today, pinned below with a code this client
 * has never seen: the transient family's copy plus Retry, and the pod's
 * message verbatim on a verbatim-posture host. Nothing renders blank.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AGENT_ERROR_CODES } from "@guuey/agent-client";
import { DefaultError, type TranscriptItemContext } from "./components.js";
import { planTranscript } from "../plan.js";
import { calmPolicy } from "../policy.js";
import { defaultChatStrings } from "../strings.js";
import type { ErrorItem, TranscriptInputs } from "../types.js";

afterEach(cleanup);

const CODE = "WORKER_POD_RESOURCE_EXHAUSTED";
/** What the pod sends; the client's own line is what a knowing client shows. */
const POD_LINE = defaultChatStrings.errorResourceExhausted;

function inputsWithError(message: string, code: string | null): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: { message, code },
    prompts: [],
    messages: [],
  };
}

function errorItem(inputs: TranscriptInputs, policy = calmPolicy()): ErrorItem {
  const item = planTranscript(inputs, policy).items.find((i) => i.kind === "error");
  if (item === undefined || item.kind !== "error") throw new Error("no error item planned");
  return item;
}

function ctx(overrides: Partial<TranscriptItemContext> = {}): TranscriptItemContext {
  return {
    strings: defaultChatStrings,
    onToggle: vi.fn(),
    resolvedMounts: new Map(),
    onViewPhase: vi.fn(),
    ...overrides,
  };
}

describe("WORKER_POD_RESOURCE_EXHAUSTED on a client that knows it", () => {
  it("is a published wire code", () => {
    expect(AGENT_ERROR_CODES.WORKER_POD_RESOURCE_EXHAUSTED).toBe(CODE);
  });

  it("renders its own reader line, in the transient family", () => {
    const item = errorItem(inputsWithError(POD_LINE, CODE));
    expect(item.family).toBe("transient");
    expect(item.copy).toBe(defaultChatStrings.errorResourceExhausted);
    expect(item.copy).not.toBe(defaultChatStrings.errorTransient);
  });

  it("the reader line names nothing internal", () => {
    expect(defaultChatStrings.errorResourceExhausted).not.toMatch(/pod|worker|memory|resource|cpu|exhausted/i);
    expect(defaultChatStrings.errorResourceExhausted.trim()).not.toBe("");
  });

  it("keeps the Retry button", () => {
    const item = errorItem(inputsWithError(POD_LINE, CODE));
    render(<DefaultError item={item} ctx={ctx({ onErrorAction: vi.fn() })} />);
    expect(screen.getByRole("alert").textContent).toContain(defaultChatStrings.errorResourceExhausted);
    expect(screen.getByRole("button", { name: defaultChatStrings.userRetry })).toBeTruthy();
  });

  it("a host's own per-code sentence still wins", () => {
    const policy = calmPolicy({ error: { verbatim: false, copyByCode: { [CODE]: "Busy, try again." }, verbatimCodes: [] } });
    expect(errorItem(inputsWithError(POD_LINE, CODE), policy).copy).toBe("Busy, try again.");
  });
});

describe("N−1: a client that does not know the code", () => {
  const UNSEEN = "A_CODE_THIS_CLIENT_HAS_NEVER_SEEN";

  it("falls back to the transient copy and keeps Retry", () => {
    const item = errorItem(inputsWithError(POD_LINE, UNSEEN));
    expect(item.family).toBe("transient");
    expect(item.copy).toBe(defaultChatStrings.errorTransient);
    expect(item.message).toBe(POD_LINE);
    render(<DefaultError item={item} ctx={ctx({ onErrorAction: vi.fn() })} />);
    expect(screen.getByRole("button", { name: defaultChatStrings.userRetry })).toBeTruthy();
  });

  it("a verbatim-posture host shows the pod's message as written", () => {
    const policy = calmPolicy({ error: { verbatim: false, copyByCode: {}, verbatimCodes: "all" } });
    expect(errorItem(inputsWithError(POD_LINE, UNSEEN), policy).copy).toBe(POD_LINE);
  });
});
