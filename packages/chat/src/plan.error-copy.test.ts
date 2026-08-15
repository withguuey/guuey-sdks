/**
 * R11 voice knobs (guuey#135 wave-3c, dogfood finding 3): per-code copy +
 * verbatim-source voice as pure policy, so the widget's #162 posture — two
 * capacity codes in its own words, every other message verbatim — is
 * configuration, not a component override.
 */
import { describe, expect, it } from "vitest";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy } from "./policy.js";
import type { ErrorItem, TranscriptInputs } from "./types.js";

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

describe("R11 voice: copyByCode", () => {
  it("an exact per-code sentence wins over family copy", () => {
    const policy = calmPolicy({
      error: {
        verbatim: false,
        copyByCode: { POD_SATURATED: "High demand right now — please try again in a moment." },
        verbatimCodes: [],
      },
    });
    const item = errorItem(inputsWithError("503 saturated", "POD_SATURATED"), policy);
    expect(item.copy).toBe("High demand right now — please try again in a moment.");
    // The source message still rides the item for overrides (3b's addition).
    expect(item.message).toBe("503 saturated");
  });

  it("wins over a verbatim match too (precedence: copyByCode → verbatim → family)", () => {
    const policy = calmPolicy({
      error: { verbatim: false, copyByCode: { DRAINING: "Restarting." }, verbatimCodes: "all" },
    });
    expect(errorItem(inputsWithError("pod draining", "DRAINING"), policy).copy).toBe("Restarting.");
  });
});

describe("R11 voice: verbatimCodes", () => {
  it("a listed code renders its source message instead of family copy", () => {
    const policy = calmPolicy({
      error: { verbatim: false, copyByCode: {}, verbatimCodes: ["QUOTA_EXCEEDED"] },
    });
    const item = errorItem(
      inputsWithError("Monthly turn quota exhausted; resets Sep 1.", "QUOTA_EXCEEDED"),
      policy,
    );
    expect(item.copy).toBe("Monthly turn quota exhausted; resets Sep 1.");
    expect(item.family).toBe("quota");
  });

  it('"all" covers code-less client errors (the widget identity-copy case)', () => {
    const policy = calmPolicy({
      error: { verbatim: false, copyByCode: {}, verbatimCodes: "all" },
    });
    const item = errorItem(inputsWithError("The sign-in service didn't respond.", null), policy);
    expect(item.copy).toBe("The sign-in service didn't respond.");
  });

  it("a listed-form match never fires for code-less errors", () => {
    const policy = calmPolicy({
      error: { verbatim: false, copyByCode: {}, verbatimCodes: ["TIMEOUT"] },
    });
    const item = errorItem(inputsWithError("client-side failure", null), policy);
    expect(item.copy).toBe(policy.strings.errorTransient);
  });

  it("an EMPTY source message falls back to family copy, never a blank notice", () => {
    const policy = calmPolicy({
      error: { verbatim: false, copyByCode: {}, verbatimCodes: "all" },
    });
    const item = errorItem(inputsWithError("", "TIMEOUT"), policy);
    expect(item.copy).toBe(policy.strings.errorTransient);
  });
});

describe("R11 voice: defaults + debug formatting stay independent", () => {
  it("calm defaults keep family copy exactly as before", () => {
    const item = errorItem(inputsWithError("boom", "TIMEOUT"));
    expect(item.copy).toBe(calmPolicy().strings.errorTransient);
    expect(item.verbatim).toBeNull();
  });

  it("debug's verbatim raw line coexists with a verbatim VOICE", () => {
    const policy = debugPolicy({
      error: { verbatim: true, copyByCode: {}, verbatimCodes: "all" },
    });
    const item = errorItem(inputsWithError("readable body", "PLATFORM_ERROR"), policy);
    expect(item.copy).toBe("readable body");
    expect(item.verbatim).toBe("PLATFORM_ERROR: readable body");
  });
});
