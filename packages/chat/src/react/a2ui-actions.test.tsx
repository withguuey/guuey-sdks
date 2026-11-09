// @vitest-environment jsdom
/**
 * guuey#2384 — the web kit's A2UI forms and actions (spec §9.1, §9.2, §9.4;
 * S4 RED (c), (d), (f) on the renderer).
 *
 * Every fixture goes through the planner, so the surface draws what a real
 * transcript would hand it. `onA2uiAction` stands in for the host's send
 * path (`<GuueyChat>` wires its composer gate; its own test drives that).
 *
 * - An unwired transcript draws each action button disabled, with its own
 *   "Not available here" note beside it (one description per button).
 * - A press validates first: each failing field shows its error, nothing is
 *   sent; a valid press hands the host the resolved record and its words.
 * - The confirm is kit-drawn (never `window.confirm`); cancelling sends nothing.
 * - A busy refusal says to wait, beside the pressed button.
 * - `sending` and `submitted` lock the form; "Edit answers" reopens it here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgBlock, AgMessage, AgReduceResult, JsonValue } from "@silverprotocol/core";
import { writeA2uiActionText } from "@guuey/mcp-apps-host/narrowing";
import { planTranscript } from "../plan.js";
import { calmPolicy } from "../policy.js";
import { defaultChatStrings } from "../strings.js";
import type { A2uiActionOutcome, A2uiActionRequest } from "../a2ui/action.js";
import type { A2uiItem, TranscriptInputs, TranscriptMessage, TranscriptPlan } from "../types.js";
import { Transcript, type TranscriptProps } from "./transcript.js";

afterEach(cleanup);

type Json = JsonValue;
const V = "v0.9";
const S = defaultChatStrings;

const form = (components: Json[]): Json[] => [
  { version: V, createSurface: { surfaceId: "order", catalogId: "guuey.a2ui.v1", title: "Your order" } },
  { version: V, updateComponents: { surfaceId: "order", components } },
];
const ORDER = form([
  { id: "root", component: "Column", children: ["name", "size", "agree", "go"] },
  { id: "name", component: "TextField", label: "Name", required: true, value: { path: "/name" } },
  { id: "size", component: "TextField", label: "Party size", inputType: "number", min: 1, max: 12, value: { path: "/size" } },
  { id: "agree", component: "CheckBox", label: "Window seat", checked: { path: "/window" } },
  {
    id: "go",
    component: "Button",
    label: "Place order",
    variant: "primary",
    action: { name: "submit", context: { name: { path: "/name" }, size: { path: "/size" }, window: { path: "/window" }, source: "chat" } },
  },
]);

type ToolResultBlock = Extract<AgBlock, { type: "tool-result" }>;
function fold(carriers: Json[][]): AgReduceResult {
  const messages: AgMessage[] = carriers.flatMap((list, i) => {
    const id = `t${i + 1}`;
    const result: ToolResultBlock = {
      type: "tool-result",
      toolCallId: id,
      content: [{ type: "text", text: `summary of ${id}` }],
      structuredContent: { "com.guuey/a2ui": { format: "a2ui", version: V, messages: list } },
    };
    return [
      { id: `m-${id}`, role: "assistant" as const, turnId: `turn${i}`, content: [{ type: "tool-call" as const, toolCallId: id, name: "show_form", input: {} }] },
      { id: `r-${id}`, role: "tool" as const, turnId: `turn${i}`, content: [result] },
    ];
  });
  return { messages, artifacts: [], memory: [], turns: carriers.map((_, i) => ({ turnId: `turn${i}`, threadId: "th", outcome: { type: "success" as const } })) };
}
function planOf(carriers: Json[][], users: TranscriptMessage[] = [], extra: Partial<TranscriptInputs> = {}): TranscriptPlan {
  const inputs: TranscriptInputs = {
    result: fold(carriers),
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [{ role: "user", text: "order please", clientMessageId: "cm_0", precedingTurnCount: 0 }, ...users],
    ...extra,
  };
  return planTranscript(inputs, { ...calmPolicy(), a2ui: { render: true } });
}

const noop = { onToggle: vi.fn(), resolvedMounts: new Map(), onViewPhase: vi.fn() };
function draw(plan: TranscriptPlan, extra: Partial<TranscriptProps> = {}) {
  const view = render(<Transcript plan={plan} window={false} {...noop} {...extra} />);
  const surface = view.container.querySelector<HTMLElement>(".guuey-chat-a2ui");
  if (surface === null) throw new Error("no surface drawn");
  return { ...view, surface };
}
const box = (surface: HTMLElement, name: string) => within(surface).getByRole("textbox", { name }) as HTMLInputElement;
const spin = (surface: HTMLElement, name: string) => within(surface).getByRole("spinbutton", { name }) as HTMLInputElement;
const button = (surface: HTMLElement, name: string) => within(surface).getByRole("button", { name }) as HTMLButtonElement;

/** A host send path that records each press and answers with `outcome`. */
function host(outcome: A2uiActionOutcome = "sent") {
  const calls: Array<{ item: A2uiItem; request: A2uiActionRequest }> = [];
  const onA2uiAction = vi.fn((item: A2uiItem, request: A2uiActionRequest): A2uiActionOutcome => {
    calls.push({ item, request });
    return outcome;
  });
  return { calls, onA2uiAction };
}

describe("an unwired transcript: every action button disabled, its own note beside it (§9.1.5)", () => {
  it("each action button is described by the note drawn with it, never one note for the row", () => {
    const { surface } = draw(
      planOf([
        form([
          { id: "root", component: "Row", children: ["a", "b"] },
          { id: "a", component: "Button", label: "Save", action: { name: "save" } },
          { id: "b", component: "Button", label: "Discard", action: { name: "discard" } },
        ]),
      ]),
    );
    const notes = Array.from(surface.querySelectorAll<HTMLElement>(".guuey-chat-a2ui-unavailable"));
    expect(notes.map((n) => n.textContent)).toEqual([S.a2uiUnavailable, S.a2uiUnavailable]);
    for (const [name, note] of [["Save", notes[0]], ["Discard", notes[1]]] as const) {
      const b = button(surface, name);
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("aria-describedby")).toBe(note?.id);
      // Beside the button it explains: the two share one parent, the button first.
      expect(b.parentElement).toBe(note?.parentElement);
      expect(b.nextElementSibling).toBe(note);
    }
    expect(new Set(notes.map((n) => n.id)).size).toBe(2);
  });
});

describe("S4 (c) — a press validates first; each failing field says why and nothing is sent", () => {
  it("a required field left empty and a number out of range: errors on the fields, no send", () => {
    const h = host();
    const { surface } = draw(planOf([ORDER]), { onA2uiAction: h.onA2uiAction });
    expect(surface.querySelector("[aria-invalid]")).toBeNull();
    fireEvent.change(spin(surface, "Party size"), { target: { value: "40" } });
    fireEvent.click(button(surface, "Place order"));
    expect(h.onA2uiAction).not.toHaveBeenCalled();
    const name = box(surface, "Name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(name.getAttribute("aria-describedby") ?? "")?.textContent).toBe(S.a2uiRequired);
    const size = spin(surface, "Party size");
    expect(size.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(size.getAttribute("aria-describedby") ?? "")?.textContent).toBe(S.a2uiFieldMax(12));
  });

  it("a required box and a required choice say so on a press; the choice's group is described by its error", () => {
    const h = host();
    const { surface } = draw(
      planOf([
        form([
          { id: "root", component: "Column", children: ["ok", "size", "go"] },
          { id: "ok", component: "CheckBox", label: "I agree", required: true, checked: { path: "/ok" } },
          { id: "size", component: "ChoicePicker", label: "Size", required: true, options: [{ label: "S", value: "s" }, { label: "M", value: "m" }], value: { path: "/size" } },
          { id: "go", component: "Button", label: "Send", action: { name: "go", context: { ok: { path: "/ok" }, size: { path: "/size" } } } },
        ]),
      ]),
      { onA2uiAction: h.onA2uiAction },
    );
    fireEvent.click(button(surface, "Send"));
    expect(h.onA2uiAction).not.toHaveBeenCalled();
    const ok = within(surface).getByRole("checkbox", { name: "I agree" });
    expect(document.getElementById(ok.getAttribute("aria-describedby") ?? "")?.textContent).toBe(S.a2uiRequired);
    const group = within(surface).getByRole("radiogroup", { name: "Size" });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(group.getAttribute("aria-describedby") ?? "")?.textContent).toBe(S.a2uiRequired);
    fireEvent.click(ok);
    fireEvent.click(within(surface).getByRole("radio", { name: "M" }));
    fireEvent.click(button(surface, "Send"));
    expect(h.calls[0]?.request.context).toEqual({ ok: true, size: "m" });
    expect(h.calls[0]?.request.summary.pairs).toEqual([
      { label: "I agree", value: S.a2uiYes },
      { label: "Size", value: "M" },
    ]);
  });

  it("editing a field clears its error; a valid press then sends", () => {
    const h = host();
    const { surface } = draw(planOf([ORDER]), { onA2uiAction: h.onA2uiAction });
    fireEvent.click(button(surface, "Place order"));
    expect(box(surface, "Name").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(box(surface, "Name"), { target: { value: "Ada" } });
    expect(box(surface, "Name").hasAttribute("aria-invalid")).toBe(false);
    fireEvent.click(button(surface, "Place order"));
    expect(h.onA2uiAction).toHaveBeenCalledTimes(1);
  });

  it("answers too long to send together: the press is refused with a note beside the button", () => {
    const h = host();
    const { surface } = draw(
      planOf([
        form([
          { id: "root", component: "Column", children: ["a", "b", "go"] },
          { id: "a", component: "TextField", label: "A", inputType: "long", value: { path: "/a" } },
          { id: "b", component: "TextField", label: "B", inputType: "long", value: { path: "/b" } },
          { id: "go", component: "Button", label: "Send", action: { name: "go", context: { a: { path: "/a" }, b: { path: "/b" } } } },
        ]),
      ]),
      { onA2uiAction: h.onA2uiAction },
    );
    fireEvent.change(box(surface, "A"), { target: { value: "x".repeat(2_100) } });
    fireEvent.change(box(surface, "B"), { target: { value: "y".repeat(2_100) } });
    fireEvent.click(button(surface, "Send"));
    expect(h.onA2uiAction).not.toHaveBeenCalled();
    const note = within(surface).getByText(S.a2uiTooLong);
    expect(button(surface, "Send").getAttribute("aria-describedby")).toBe(note.id);
  });
});

describe("S4 (d) — the press reaches the host's send path; a refusal says to wait", () => {
  it("a valid press hands the host the resolved record and the words of its human line", () => {
    const h = host();
    const { surface } = draw(planOf([ORDER]), { onA2uiAction: h.onA2uiAction });
    fireEvent.change(box(surface, "Name"), { target: { value: "Ada" } });
    fireEvent.change(spin(surface, "Party size"), { target: { value: "4" } });
    fireEvent.click(within(surface).getByRole("checkbox", { name: "Window seat" }));
    expect(button(surface, "Place order").disabled).toBe(false);
    expect(surface.querySelector(".guuey-chat-a2ui-unavailable")).toBeNull();
    fireEvent.click(button(surface, "Place order"));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.item.surfaceId).toBe("order");
    expect(h.calls[0]?.request).toEqual({
      surfaceId: "order",
      name: "submit",
      sourceComponentId: "go",
      context: { name: "Ada", size: 4, window: true, source: "chat" },
      summary: {
        label: "Place order",
        pairs: [
          { label: "Name", value: "Ada" },
          { label: "Party size", value: "4" },
          { label: "Window seat", value: S.a2uiYes },
        ],
      },
    });
  });

  it("the gate refuses mid-turn: the surface says to wait, beside the pressed button, and keeps every value", () => {
    const h = host("busy");
    const { surface } = draw(planOf([ORDER]), { onA2uiAction: h.onA2uiAction });
    fireEvent.change(box(surface, "Name"), { target: { value: "Ada" } });
    fireEvent.click(button(surface, "Place order"));
    const note = within(surface).getByText(S.a2uiWaitForReply);
    expect(button(surface, "Place order").getAttribute("aria-describedby")).toBe(note.id);
    expect(note.getAttribute("role")).toBe("status");
    expect(box(surface, "Name").value).toBe("Ada");
    expect(button(surface, "Place order").disabled).toBe(false);
  });
});

describe("the confirm is kit-drawn (§9.1.1)", () => {
  const confirmed = form([
    { id: "root", component: "Column", children: ["go"] },
    {
      id: "go",
      component: "Button",
      label: "Cancel booking",
      variant: "danger",
      action: { name: "cancel" },
      confirm: { title: "Cancel this booking?", message: "The table is released.", confirmLabel: "Yes, cancel" },
    },
  ]);

  it("a press opens the kit's own dialog, never window.confirm; cancelling sends nothing and returns focus", () => {
    const native = vi.spyOn(window, "confirm");
    const h = host();
    const { surface } = draw(planOf([confirmed]), { onA2uiAction: h.onA2uiAction });
    const pressed = button(surface, "Cancel booking");
    fireEvent.click(pressed);
    const dialog = within(surface).getByRole("alertdialog", { name: "Cancel this booking?" });
    expect(dialog.getAttribute("aria-describedby")).toBe(within(dialog).getByText("The table is released.").id);
    expect(native).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: S.a2uiCancel }));
    fireEvent.click(within(dialog).getByRole("button", { name: S.a2uiCancel }));
    expect(h.onA2uiAction).not.toHaveBeenCalled();
    expect(within(surface).queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(button(surface, "Cancel booking"));
    native.mockRestore();
  });

  it("Escape cancels; confirming sends", () => {
    const h = host();
    const { surface } = draw(planOf([confirmed]), { onA2uiAction: h.onA2uiAction });
    fireEvent.click(button(surface, "Cancel booking"));
    fireEvent.keyDown(within(surface).getByRole("alertdialog"), { key: "Escape" });
    expect(within(surface).queryByRole("alertdialog")).toBeNull();
    expect(h.onA2uiAction).not.toHaveBeenCalled();
    fireEvent.click(button(surface, "Cancel booking"));
    fireEvent.click(within(surface).getByRole("button", { name: "Yes, cancel" }));
    expect(h.calls.map((c) => c.request.name)).toEqual(["cancel"]);
    expect(within(surface).queryByRole("alertdialog")).toBeNull();
  });
});

describe("S4 (f) on the renderer — sending, submitted, Edit answers", () => {
  const actionRow = (id: string): TranscriptMessage => ({
    role: "user",
    text:
      writeA2uiActionText(
        { surfaceId: "order", name: "submit", sourceComponentId: "go", actionId: id, context: { name: "Ada" } },
        { label: "Place order", pairs: [{ label: "Name", value: "Ada" }] },
      ) ?? "",
    clientMessageId: id,
    precedingTurnCount: 1,
  });

  it("while the action turn is on its way: values read-only, the press disabled, a Sending stamp", () => {
    const { surface } = draw(planOf([ORDER], [actionRow("cm_1")], { sendStates: { cm_1: "sending" } }), { onA2uiAction: host().onA2uiAction });
    expect(box(surface, "Name").readOnly).toBe(true);
    expect(within(surface).getByRole("checkbox", { name: "Window seat" }).hasAttribute("disabled")).toBe(true);
    expect(button(surface, "Place order").disabled).toBe(true);
    expect(within(surface).getByText(S.a2uiSending)).toBeTruthy();
    expect(within(surface).queryByRole("button", { name: S.a2uiEditAnswers })).toBeNull();
  });

  it("answered in words: a Sent stamp, and Edit answers reopens the form here for another submit", () => {
    const h = host();
    const plan = planOf([ORDER], [actionRow("cm_1")]);
    const { surface } = draw(plan, { onA2uiAction: h.onA2uiAction });
    expect(box(surface, "Name").readOnly).toBe(true);
    expect(button(surface, "Place order").disabled).toBe(true);
    expect(within(surface).getByText(S.a2uiSent)).toBeTruthy();
    fireEvent.click(button(surface, S.a2uiEditAnswers));
    expect(box(surface, "Name").readOnly).toBe(false);
    expect(within(surface).queryByText(S.a2uiSent)).toBeNull();
    fireEvent.change(box(surface, "Name"), { target: { value: "Grace" } });
    fireEvent.click(button(surface, "Place order"));
    expect(h.calls.map((c) => c.request.context["name"])).toEqual(["Grace"]);
  });

  it("the reopen belongs to that one action turn: a later submit closes the form again", () => {
    const h = host();
    const first = planOf([ORDER], [actionRow("cm_1")]);
    const view = draw(first, { onA2uiAction: h.onA2uiAction });
    fireEvent.click(button(view.surface, S.a2uiEditAnswers));
    expect(box(view.surface, "Name").readOnly).toBe(false);
    const second = planOf([ORDER], [actionRow("cm_1"), { ...actionRow("cm_2"), precedingTurnCount: 1 }]);
    act(() => view.rerender(<Transcript plan={second} window={false} {...noop} onA2uiAction={h.onA2uiAction} />));
    expect(box(view.surface, "Name").readOnly).toBe(true);
    expect(within(view.surface).getByText(S.a2uiSent)).toBeTruthy();
  });

  it("an unwired transcript shows the Sent stamp with nothing to reopen", () => {
    const { surface } = draw(planOf([ORDER], [actionRow("cm_1")]));
    expect(within(surface).getByText(S.a2uiSent)).toBeTruthy();
    expect(within(surface).queryByRole("button", { name: S.a2uiEditAnswers })).toBeNull();
  });
});

describe("the action turn's face (S4 (e) on the renderer)", () => {
  it("draws the human line as the turn's words in the action bubble, never the block", () => {
    const row: TranscriptMessage = {
      role: "user",
      text:
        writeA2uiActionText(
          { surfaceId: "order", name: "submit", sourceComponentId: "go", actionId: "cm_1", context: { name: "Ada" } },
          { label: "Place order", pairs: [{ label: "Name", value: "Ada" }] },
        ) ?? "",
      clientMessageId: "cm_1",
      precedingTurnCount: 1,
    };
    const { container } = draw(planOf([ORDER], [row]));
    const turn = container.querySelector<HTMLElement>(".guuey-chat-action-turn");
    expect(turn?.querySelector(".guuey-chat-action-label")?.textContent).toBe("Place order: Name = Ada");
    expect(container.textContent).not.toContain("guuey_a2ui_action");
    expect(screen.queryByText(/partySize|"name"/)).toBeNull();
  });
});
