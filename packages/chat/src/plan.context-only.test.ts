/**
 * guuey#2549 — a user turn sent WITHOUT words (its content rode on the page
 * context) is planned as its own turn: the item carries the kind and the
 * renderer draws `strings.contextOnlyTurn`, never an empty bubble. Typed and
 * relayed text never takes it. The two refusals of such a turn read "add a
 * few words", with no Retry (the same turn meets the same refusal).
 */
import { describe, expect, it } from "vitest";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { DisplayItem, TranscriptInputs, TranscriptMessage, UserMessageItem } from "./types.js";

function inputs(messages: TranscriptMessage[], over: Partial<TranscriptInputs> = {}): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages,
    ...over,
  };
}

function users(items: readonly DisplayItem[]): UserMessageItem[] {
  return items.filter((i): i is UserMessageItem => i.kind === "user");
}

const DIRECTIVE = 'Call ggui_consume NOW.\n\n<ggui_directive kind="user-action">\n  <session_id>s1</session_id>\n</ggui_directive>';

describe("guuey#2549: a turn without words", () => {
  it("an empty row with its kind plans as a no-words turn", () => {
    const { items } = planTranscript(
      inputs([{ role: "user", text: "", clientMessageId: "c1", inputKind: "context-only" }]),
      calmPolicy(),
    );
    expect(users(items)[0]).toMatchObject({ text: "", inputKind: "context-only", directive: false });
  });

  it("a row with words never takes the kind, even if one is stamped", () => {
    const { items } = planTranscript(
      inputs([{ role: "user", text: "what is this?", inputKind: "context-only" }]),
      calmPolicy(),
    );
    expect(users(items)[0]).not.toHaveProperty("inputKind");
  });

  it("an empty row without a kind stays an ordinary row", () => {
    const { items } = planTranscript(inputs([{ role: "user", text: "" }]), calmPolicy());
    expect(users(items)[0]).not.toHaveProperty("inputKind");
  });

  it("a directive row never takes the kind", () => {
    const { items } = planTranscript(inputs([{ role: "user", text: DIRECTIVE, inputKind: "context-only" }]), calmPolicy());
    expect(users(items)[0]).toMatchObject({ directive: true });
    expect(users(items)[0]).not.toHaveProperty("inputKind");
  });

  for (const [code, key] of [
    ["INPUT_KIND_NOT_ADVERTISED", "errorInputKindNotAdvertised"],
    ["INPUT_KIND_NOT_DECLARED", "errorInputKindNotDeclared"],
  ] as const) {
    it(`a refused no-words send (${code}) reads its own line, with no Retry`, () => {
      const policy = calmPolicy();
      const { items } = planTranscript(
        inputs([{ role: "user", text: "", clientMessageId: "c1", inputKind: "context-only" }], {
          error: { message: "runtime words", code },
          sendStates: { c1: "failed" },
        }),
        policy,
      );
      expect(users(items)[0]).toMatchObject({
        state: "failed",
        retry: false,
        inputKind: "context-only",
        failureLine: policy.strings[key],
      });
      expect(items.filter((i) => i.kind === "error")).toHaveLength(0);
    });
  }
});
