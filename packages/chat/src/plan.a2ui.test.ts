/**
 * guuey#2381 — the `a2ui` plan kind (spec §8, §5.7, §6, §11; S1 RED (d), (e), (a4), (g)).
 *
 * - A valid carrier under `policy.a2ui.render`: the tool row folds into the
 *   item's chrome (no data result, attribution), and one `a2ui` item per surface.
 * - An invalid carrier, render off, or a failed result: today's plan, byte-identical.
 * - One precedence with the view mount, the store's: a result that mounts a
 *   view is a card live and reloaded, and its carrier is never read.
 * - The surface fold across the transcript: a later revision supersedes, a
 *   deleted surface draws nothing, an orphan update keeps today's face, and
 *   any carrier that takes the old face (invalid, oversize, or on a failed
 *   result) closes the open form it names.
 * - History: the same carriers, served as `toolResults` on a history read
 *   (guuey#2388), plan through the same fold as live.
 */
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { toolResultMountSource } from "@guuey/mcp-apps-host";
import type { AgBlock, AgReduceResult, JsonValue } from "@silverprotocol/core";
import {
  threadHistoryRowsToCards,
  threadHistoryRowsToMessages,
  threadHistoryRowsToToolCalls,
  threadHistoryRowsToToolResults,
  type InvokeTurnEvent,
  type ThreadHistoryRow,
} from "@guuey/agent-client";
import { transcriptInputsFromHistory } from "./history-inputs.js";
import { newestViewKey, planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy, type TranscriptPolicy, type TranscriptPolicyOverrides } from "./policy.js";
import { A2UI_LIMITS } from "./a2ui/limits.js";
import type { A2uiDebugEvent, A2uiItem, ChatDebugEvent, DisplayItem, ToolItem, TranscriptInputs, TranscriptPlan } from "./types.js";
import { driveTurn } from "./corpus/drive.js";

const V = "v0.9";
type Json = JsonValue;
const on = (policy: TranscriptPolicy = calmPolicy()): TranscriptPolicy => ({ ...policy, a2ui: { render: true } });

const create = (surfaceId: string, title?: string): Json => ({
  version: V,
  createSurface: { surfaceId, catalogId: "guuey.a2ui.v1", ...(title !== undefined ? { title } : {}) },
});
const components = (surfaceId: string, list: Json[]): Json => ({ version: V, updateComponents: { surfaceId, components: list } });
const dataModel = (surfaceId: string, value: Json, path?: string): Json => ({
  version: V,
  updateDataModel: { surfaceId, value, ...(path !== undefined ? { path } : {}) },
});
const del = (surfaceId: string): Json => ({ version: V, deleteSurface: { surfaceId } });
const carrier = (messages: Json[]): Json => ({ format: "a2ui", version: V, messages });

/** An interactive surface: one bound field and a submit action. */
const form = (surfaceId: string, title = "Your details"): Json[] => [
  create(surfaceId, title),
  components(surfaceId, [
    { id: "root", component: "Column", children: ["name", "go"] },
    { id: "name", component: "TextField", label: "Name", value: { path: "/name" }, required: true },
    { id: "go", component: "Button", label: "Send", action: { name: "submit", context: { name: { path: "/name" } } } },
  ]),
];
/** A read-only surface. */
const card = (surfaceId: string, text: string, title = "Status"): Json[] => [
  create(surfaceId, title),
  components(surfaceId, [{ id: "root", component: "Text", text }]),
];

type ToolResultBlock = Extract<AgBlock, { type: "tool-result" }>;
interface Call {
  id: string;
  name?: string;
  structuredContent?: Json;
  uiData?: Json;
  isError?: boolean;
}

function resultBlock(c: Call): ToolResultBlock {
  return {
    type: "tool-result",
    toolCallId: c.id,
    content: [{ type: "text", text: `summary of ${c.id}` }],
    ...(c.structuredContent !== undefined && typeof c.structuredContent === "object" && c.structuredContent !== null && !Array.isArray(c.structuredContent)
      ? { structuredContent: c.structuredContent }
      : {}),
    ...(c.uiData !== undefined ? { uiData: c.uiData } : {}),
    ...(c.isError === true ? { isError: true } : {}),
  };
}

function fold(...calls: Call[]): AgReduceResult {
  return {
    messages: calls.flatMap((c) => [
      { id: `m-${c.id}`, role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: c.id, name: c.name ?? "show_form", input: {} }] },
      { id: `r-${c.id}`, role: "tool" as const, content: [resultBlock(c)] },
    ]),
    artifacts: [],
    memory: [],
    turns: [],
  };
}

const withCarrier = (id: string, messages: Json[], name?: string): Call => ({
  id,
  ...(name !== undefined ? { name } : {}),
  structuredContent: { "com.guuey/a2ui": carrier(messages) },
});

function inputsOf(result: AgReduceResult): TranscriptInputs {
  return {
    result,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [{ role: "user", text: "go" }],
  };
}

const plan = (result: AgReduceResult, policy: TranscriptPolicy = on()): TranscriptPlan => planTranscript(inputsOf(result), policy);
const a2uiOf = (items: DisplayItem[]): A2uiItem[] => items.filter((i): i is A2uiItem => i.kind === "a2ui");
const toolsOf = (items: DisplayItem[]): ToolItem[] => items.filter((i): i is ToolItem => i.kind === "tool");

describe("S1 (d) — the planner arm", () => {
  it("a carrier → the tool row (attribution, no result) and one a2ui item per surface", () => {
    const p = plan(fold(withCarrier("t1", [...form("form-1"), ...card("note-1", "Hi")])));
    expect(p.items.map((i) => i.kind)).toEqual(["user", "tool", "a2ui", "a2ui"]);
    const [tool] = toolsOf(p.items);
    expect(tool).toMatchObject({ key: "tool.t1", result: null, attribution: true, state: "done" });
    const [formItem, noteItem] = a2uiOf(p.items);
    expect(formItem).toMatchObject({
      key: "a2ui.t1.form-1",
      surfaceId: "form-1",
      revision: 1,
      title: "Your details",
      phase: "open",
      label: null,
      attribution: "via show form",
      toolTitle: "show form",
      origin: "live",
      dataModel: {},
      fields: { "/name": { kind: "text", componentId: "name", required: true } },
    });
    expect(formItem?.root).toMatchObject({ id: "root", component: "Column", children: [{ id: "name" }, { id: "go" }] });
    expect(noteItem).toMatchObject({ key: "a2ui.t1.note-1", root: { component: "Text", text: "Hi" } });
    expect(p.views).toEqual([]);
  });

  it("render off (the default, the key absent): the carrier keeps today's face", () => {
    // The byte-level baseline is the a2ui-n1 corpus: each snapshot there was
    // planned by the kit at the base sha, before this kind existed.
    expect(Object.hasOwn(calmPolicy(), "a2ui")).toBe(false);
    expect(Object.hasOwn(debugPolicy(), "a2ui")).toBe(false);
    const off = plan(fold(withCarrier("t1", form("form-1"))), calmPolicy());
    expect(a2uiOf(off.items)).toEqual([]);
    expect(toolsOf(off.items)[0]?.result?.kind).toBe("data-result");
  });

  it("an override can turn a2ui OFF, never on (amended at S2); its facts are debug events", () => {
    // The type admits only `false`.
    expectTypeOf<NonNullable<TranscriptPolicyOverrides["a2ui"]>>().toEqualTypeOf<{ render: false }>();
    expectTypeOf<Extract<ChatDebugEvent, { type: "a2ui-invalid" | "a2ui-degraded" | "a2ui-orphan" }>>().toEqualTypeOf<A2uiDebugEvent>();
    // A host's untyped object (a JSON config, a JS caller) that names `true` anyway: dropped.
    const fromJson: TranscriptPolicyOverrides = JSON.parse('{"a2ui":{"render":true}}');
    expect(Object.hasOwn(calmPolicy(fromJson), "a2ui")).toBe(false);
    expect(a2uiOf(plan(fold(withCarrier("t1", form("form-1"))), calmPolicy(fromJson)).items)).toEqual([]);
    // Nor does anything but an explicit false reach the policy.
    for (const raw of ['{"a2ui":{"render":"false"}}', '{"a2ui":true}', '{"a2ui":null}', '{"a2ui":{}}']) {
      const odd: TranscriptPolicyOverrides = JSON.parse(raw);
      expect(Object.hasOwn(calmPolicy(odd), "a2ui"), raw).toBe(false);
    }
    // An explicit false is honoured, over either preset.
    expect(calmPolicy({ a2ui: { render: false } }).a2ui).toEqual({ render: false });
    expect(debugPolicy({ a2ui: { render: false } }).a2ui).toEqual({ render: false });
  });

  it("an invalid carrier → today's plan, byte-identical to render off", () => {
    const invalid: Json[][] = [
      [{ version: V }], // no recognized key
      [create("has space")], // bad surface id
      [create("s"), components("s", [{ id: "root", component: "Card", child: "root" }])], // a cycle
      [
        create("f"),
        components("f", [
          { id: "root", component: "Column", children: ["name", "x"] },
          { id: "name", component: "TextField", value: { path: "/name" } },
          { id: "x", component: "Blink" },
        ]),
      ], // a component fault on an interactive surface
    ];
    for (const messages of invalid) {
      const f = fold(withCarrier("t1", messages));
      expect(JSON.stringify(plan(f, on()))).toBe(JSON.stringify(plan(f, calmPolicy())));
    }
    const oversize = fold({ id: "t1", structuredContent: { "com.guuey/a2ui": carrier(card("s", "x".repeat(A2UI_LIMITS.carrierUnits))) } });
    expect(JSON.stringify(plan(oversize, on()))).toBe(JSON.stringify(plan(oversize, calmPolicy())));
  });

  it("a carrier on a failed result keeps today's face", () => {
    const f = fold({ ...withCarrier("t1", form("form-1")), isError: true });
    expect(JSON.stringify(plan(f, on()))).toBe(JSON.stringify(plan(f, calmPolicy())));
  });

  it("a carrier that `_meta.ui` moved to `uiData` is still an a2ui item", () => {
    const p = plan(fold({ id: "t1", uiData: { "com.guuey/a2ui": carrier(card("note-1", "Moved")) } }));
    expect(a2uiOf(p.items).map((i) => i.key)).toEqual(["a2ui.t1.note-1"]);
    expect(toolsOf(p.items)[0]).toMatchObject({ result: null, attribution: true });
  });

  it("an a2ui image obeys policy.media under policy A: chipOnly, a narrowed list or the byte cap never loads it", () => {
    const hosted = "https://cdn.guueyusercontent.com/a.png";
    const f = fold(withCarrier("t1", [create("s"), components("s", [{ id: "root", component: "Image", src: hosted, alt: "a" }])]));
    const display = (policy: TranscriptPolicy) => {
      const root = a2uiOf(plan(f, policy).items)[0]?.root;
      return root?.component === "Image" ? root.display : undefined;
    };
    const base = on();
    expect(display(base)).toEqual({ kind: "image", src: hosted });
    expect(display({ ...base, media: { ...base.media, chipOnly: true } })).toMatchObject({ kind: "link", url: hosted });
    expect(display({ ...base, media: { ...base.media, origins: ["https://only.guueyusercontent.com"] } })).toMatchObject({ kind: "link" });
    const big = `data:image/png;base64,${"A".repeat(2000)}`;
    const g = fold(withCarrier("t1", [create("s"), components("s", [{ id: "root", component: "Image", src: big }])]));
    const root = a2uiOf(plan(g, { ...base, media: { ...base.media, maxInlineBytes: 1000 } }).items)[0]?.root;
    expect(root).toMatchObject({ component: "Image", display: { kind: "chip" } });
  });

  it("the F1 stream (live) draws the booking form natively", () => {
    const f: { userText: string; events: InvokeTurnEvent[] } = JSON.parse(
      readFileSync(new URL("./corpus/fixtures/a2ui-n1-old-client-live.json", import.meta.url), "utf8"),
    );
    const p = planTranscript(driveTurn(f.events, { userText: f.userText }), on());
    const [item] = a2uiOf(p.items);
    expect(item).toMatchObject({ key: "a2ui.call-booking.booking-1", title: "Book a table", phase: "open", dataModel: { partySize: 4 } });
    expect(Object.keys(item?.fields ?? {}).sort()).toEqual(["/date", "/partySize"]);
    expect(p.items.map((i) => i.kind)).toEqual(["user", "tool", "a2ui", "text"]);
  });

  it("debug: the explicit tool line stays, the item carries no via-chrome, and the facts are recorded", () => {
    const p = plan(
      fold(
        withCarrier("t1", [create("s1"), components("s1", [{ id: "root", component: "Blink" }])]),
        withCarrier("t2", [{ version: V }]),
      ),
      on(debugPolicy()),
    );
    const [first] = toolsOf(p.items);
    expect(first).toMatchObject({ attribution: false, result: null });
    expect(a2uiOf(p.items)[0]).toMatchObject({ attribution: null, toolTitle: "show form" });
    expect(p.a2uiEvents).toEqual([
      { type: "a2ui-degraded", key: "a2ui.t1.s1", counts: { "unknown-component": 1 } },
      { type: "a2ui-invalid", key: "tool.t2", reason: "unrecognized-message" },
    ]);
  });

  it("calm records no facts: the plan carries no a2uiEvents key", () => {
    const p = plan(fold(withCarrier("t1", [{ version: V }])));
    expect(Object.hasOwn(p, "a2uiEvents")).toBe(false);
  });

  it("a result drawn without its call (a history result) draws its surfaces, unattributed", () => {
    const result: AgReduceResult = {
      messages: [{ id: "r", role: "assistant", content: [resultBlock(withCarrier("t9", card("note-9", "Alone")))] }],
      artifacts: [],
      memory: [],
      turns: [],
    };
    const p = plan(result);
    expect(a2uiOf(p.items)).toEqual([expect.objectContaining({ key: "a2ui.t9.note-9", attribution: null, toolTitle: null })]);
    expect(p.items.some((i) => i.kind === "data-result")).toBe(false);
  });

  it("a result drawn without its call keeps its media like a paired one, and a carrier that drew nothing keeps its data row", () => {
    const PNG = "iVBORw0KGgo=";
    const withImage = (c: Call): ToolResultBlock => {
      const block = resultBlock(c);
      return { ...block, content: [...block.content, { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG } }] };
    };
    const alone = (...blocks: ToolResultBlock[]): AgReduceResult => ({
      messages: [{ id: "r", role: "assistant", content: blocks }],
      artifacts: [],
      memory: [],
      turns: [],
    });
    const paired = plan({
      ...fold(withCarrier("t8", card("n8", "Paired"))),
      messages: [
        { id: "m-t8", role: "assistant", content: [{ type: "tool-call", toolCallId: "t8", name: "show_form", input: {} }] },
        { id: "r-t8", role: "tool", content: [withImage(withCarrier("t8", card("n8", "Paired")))] },
      ],
    });
    expect(paired.items.map((i) => i.kind)).toEqual(["user", "tool", "media", "a2ui"]);
    const drawn = plan(alone(withImage(withCarrier("t9", card("n9", "Alone")))));
    expect(drawn.items.map((i) => i.kind)).toEqual(["user", "a2ui", "media"]);
    const deleted = plan(alone(resultBlock(withCarrier("t1", card("n1", "One"))), withImage(withCarrier("t2", [del("n1")]))));
    expect(deleted.items.map((i) => i.kind)).toEqual(["user", "data-result", "media"]);
  });
});

describe("S1 (e) — the surface fold across the transcript", () => {
  it("a later carrier supersedes: the surface draws once, at its latest revision", () => {
    const p = plan(fold(withCarrier("t1", form("form-1")), withCarrier("t2", [dataModel("form-1", { name: "Ada" })])));
    const [first, second] = a2uiOf(p.items);
    expect(first).toMatchObject({ key: "a2ui.t1.form-1", revision: 1, phase: "superseded", label: "Your details, updated below" });
    expect(second).toMatchObject({ key: "a2ui.t2.form-1", revision: 2, phase: "open", label: null, dataModel: { name: "Ada" } });
    expect(second?.root).toEqual(first?.root);
  });

  it("an untitled superseded surface names its tool, else the fallback", () => {
    const untitled = (id: string): Json[] => [{ version: V, createSurface: { surfaceId: id, catalogId: "c" } }, components(id, [{ id: "root", component: "Divider" }])];
    const p = plan(fold(withCarrier("t1", untitled("s")), withCarrier("t2", untitled("s"))));
    expect(a2uiOf(p.items)[0]?.label).toBe("show form, updated below");
    const bare: AgReduceResult = {
      messages: [
        { id: "r1", role: "assistant", content: [resultBlock(withCarrier("x1", untitled("s"))), resultBlock(withCarrier("x2", untitled("s")))] },
      ],
      artifacts: [],
      memory: [],
      turns: [],
    };
    expect(a2uiOf(plan(bare).items)[0]?.label).toBe("Card, updated below");
  });

  it("deleteSurface draws nothing: no revision of the surface stays, and its tool row is unattributed", () => {
    const p = plan(fold(withCarrier("t1", form("form-1")), withCarrier("t2", [del("form-1")])));
    expect(a2uiOf(p.items)).toEqual([]);
    const tools = toolsOf(p.items);
    expect(tools.map((t) => [t.key, t.result, t.attribution])).toEqual([
      ["tool.t1", null, true],
      ["tool.t2", null, false],
    ]);
  });

  it("a surface created again after a delete draws its new revision", () => {
    const p = plan(fold(withCarrier("t1", card("s", "one")), withCarrier("t2", [del("s")]), withCarrier("t3", card("s", "two"))));
    expect(a2uiOf(p.items).map((i) => [i.key, i.phase, i.revision])).toEqual([["a2ui.t3.s", "open", 2]]);
  });

  it("an orphan update draws nothing and hides nothing: today's face, and debug names it", () => {
    const orphans: Array<[string, Json]> = [
      ["ghost", dataModel("ghost", { a: 1 })],
      ["late", components("late", [{ id: "root", component: "Text", text: "here" }])],
    ];
    for (const [surfaceId, message] of orphans) {
      const f = fold(withCarrier("t1", [message]));
      expect(JSON.stringify(plan(f))).toBe(JSON.stringify(plan(f, calmPolicy())));
      const debug = plan(f, on(debugPolicy()));
      expect(a2uiOf(debug.items)).toEqual([]);
      expect(toolsOf(debug.items)[0]?.result?.kind).toBe("data-result");
      expect(debug.a2uiEvents).toEqual([{ type: "a2ui-orphan", key: "tool.t1", surfaceId }]);
    }
  });

  it("an orphan beside a drawn surface: the surface draws, the orphan is named", () => {
    const p = plan(fold(withCarrier("t1", [...card("n", "here"), dataModel("ghost", { a: 1 })])), on(debugPolicy()));
    expect(a2uiOf(p.items).map((i) => i.key)).toEqual(["a2ui.t1.n"]);
    expect(p.a2uiEvents).toEqual([{ type: "a2ui-orphan", key: "tool.t1", surfaceId: "ghost" }]);
  });

  it("surfaces fold independently", () => {
    const p = plan(fold(withCarrier("t1", [...card("a", "A1"), ...card("b", "B1")]), withCarrier("t2", card("a", "A2"))));
    expect(a2uiOf(p.items).map((i) => [i.key, i.phase])).toEqual([
      ["a2ui.t1.a", "superseded"],
      ["a2ui.t1.b", "open"],
      ["a2ui.t2.a", "open"],
    ]);
  });
});

describe("S1 (a4) — a carrier that cannot draw closes the open form above it", () => {
  const overCap = (surfaceId: string): Json => dataModel(surfaceId, { blob: "x".repeat(A2UI_LIMITS.dataModelUnits) });

  it("a form, then an over-cap update: superseded with the couldn't-draw chip, the tool row shows its result", () => {
    const p = plan(fold(withCarrier("t1", form("form-1")), withCarrier("t2", [overCap("form-1")])));
    const items = a2uiOf(p.items);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "a2ui.t1.form-1", phase: "superseded", label: "Updated below, couldn't draw" });
    const second = toolsOf(p.items)[1];
    expect(second).toMatchObject({ key: "tool.t2", attribution: false });
    expect(second?.result?.kind).toBe("data-result");
  });

  it("an envelope fault naming the surface closes it too", () => {
    const p = plan(fold(withCarrier("t1", form("form-1")), withCarrier("t2", [dataModel("form-1", 1, "/a~2")])));
    expect(a2uiOf(p.items)[0]).toMatchObject({ phase: "superseded", label: "Updated below, couldn't draw" });
  });

  it("an oversize carrier naming the form closes it (its ids read by the bounded scan)", () => {
    const huge = withCarrier("t2", [dataModel("form-1", { blob: "x".repeat(20_000) })]);
    const p = plan(fold(withCarrier("t1", form("form-1")), huge), on(debugPolicy()));
    expect(a2uiOf(p.items)[0]).toMatchObject({ key: "a2ui.t1.form-1", phase: "superseded", label: "Updated below, couldn't draw" });
    expect(toolsOf(p.items)[1]?.result?.kind).toBe("data-result");
    expect(p.a2uiEvents).toEqual([{ type: "a2ui-invalid", key: "tool.t2", reason: "too-large" }]);
  });

  it("a carrier on a failed result naming the form closes it; the failed row keeps today's face", () => {
    const failed: Call = { ...withCarrier("t2", [dataModel("form-1", { name: "Ada" })]), isError: true };
    const p = plan(fold(withCarrier("t1", form("form-1")), failed), on(debugPolicy()));
    expect(a2uiOf(p.items)).toHaveLength(1);
    expect(a2uiOf(p.items)[0]).toMatchObject({ key: "a2ui.t1.form-1", phase: "superseded", label: "Updated below, couldn't draw" });
    expect(toolsOf(p.items)[1]).toMatchObject({ key: "tool.t2", state: "failed", attribution: false });
    expect(p.a2uiEvents).toEqual([{ type: "a2ui-invalid", key: "tool.t2", reason: "tool-failed" }]);
  });

  it("a read-only surface stays open: nothing on it can be submitted", () => {
    const p = plan(fold(withCarrier("t1", card("note", "hi")), withCarrier("t2", [{ version: V, updateDataModel: { surfaceId: "note", path: "/a~2", value: 1 } }])));
    expect(a2uiOf(p.items)[0]).toMatchObject({ phase: "open", label: null });
  });

  it("a later valid revision after a failed one draws open; the closed one keeps its chip", () => {
    const p = plan(
      fold(withCarrier("t1", form("form-1")), withCarrier("t2", [overCap("form-1")]), withCarrier("t3", [dataModel("form-1", { name: "Bo" })])),
    );
    expect(a2uiOf(p.items).map((i) => [i.key, i.phase, i.label, i.revision])).toEqual([
      ["a2ui.t1.form-1", "superseded", "Updated below, couldn't draw", 1],
      ["a2ui.t3.form-1", "open", null, 2],
    ]);
  });
});

describe("the per-transcript cap (spec §6)", () => {
  it(`${A2UI_LIMITS.itemsPerTranscript} items plan; a later carrier draws the old face`, () => {
    const calls = Array.from({ length: A2UI_LIMITS.itemsPerTranscript + 1 }, (_, i) => withCarrier(`t${i}`, card(`s${i}`, `n${i}`)));
    const p = plan(fold(...calls), on(debugPolicy()));
    expect(a2uiOf(p.items)).toHaveLength(A2UI_LIMITS.itemsPerTranscript);
    const last = toolsOf(p.items).at(-1);
    expect(last?.result?.kind).toBe("data-result");
    expect(p.a2uiEvents?.at(-1)).toEqual({ type: "a2ui-invalid", key: `tool.t${A2UI_LIMITS.itemsPerTranscript}`, reason: "too-many-items" });
  });
});

describe("S1 (g) — determinism", () => {
  it("same inputs give a deep-equal plan", () => {
    const f = fold(withCarrier("t1", form("form-1")), withCarrier("t2", [dataModel("form-1", { name: "Ada" })]), withCarrier("t3", card("n", "x")));
    expect(plan(f)).toEqual(plan(f));
    expect(JSON.stringify(plan(f))).toBe(JSON.stringify(plan(f)));
  });
});

describe("history (spec §11, adapted to guuey#2388's toolResults) — the same fold as live", () => {
  const rows = (calls: Call[]): ThreadHistoryRow[] => {
    const out: ThreadHistoryRow[] = [
      { seq: 1, at: "2026-10-01T00:00:01.000Z", kind: "text", authorRole: "user", text: "go", clientMessageId: "cm_1" },
    ];
    let seq = 2;
    for (const [i, c] of calls.entries()) {
      out.push({
        seq: seq++,
        at: "2026-10-01T00:00:02.000Z",
        kind: "text",
        authorRole: "agent",
        text: null,
        clientMessageId: `cm_1#agent#${2 * i}`,
        toolCalls: [{ toolCallId: c.id, name: c.name ?? "show_form", input: {} }],
      });
      out.push({
        seq: seq++,
        at: "2026-10-01T00:00:03.000Z",
        kind: "text",
        authorRole: "agent",
        text: null,
        clientMessageId: `cm_1#agent#${2 * i + 1}`,
        toolResults: [{ toolCallId: c.id, toolName: c.name ?? "show_form", block: resultBlock(c) }],
      });
    }
    return out;
  };
  const historyInputs = (r: ThreadHistoryRow[]): TranscriptInputs =>
    transcriptInputsFromHistory({
      messages: threadHistoryRowsToMessages(r),
      cards: threadHistoryRowsToCards(r),
      toolResults: threadHistoryRowsToToolResults(r),
      toolCalls: threadHistoryRowsToToolCalls(r),
    });

  const calls = [withCarrier("t1", form("form-1")), withCarrier("t2", [dataModel("form-1", { name: "Ada" })]), withCarrier("t3", [overCap()])];
  function overCap(): Json {
    return dataModel("form-1", { blob: "x".repeat(A2UI_LIMITS.dataModelUnits) });
  }

  it("the client mapper keeps the carrier's structuredContent verbatim and draws no message or card from it", () => {
    const r = rows(calls);
    expect(threadHistoryRowsToCards(r)).toEqual([]);
    expect(threadHistoryRowsToMessages(r).map((m) => m.role)).toEqual(["user"]);
    expect(threadHistoryRowsToToolResults(r).map((t) => t.block.structuredContent)).toEqual(calls.map((c) => c.structuredContent));
  });

  it("a turn with a carrier, an update and one that cannot draw plans identically live and from history", () => {
    const live = plan(fold(...calls));
    const reloaded = planTranscript(historyInputs(rows(calls)), on());
    const strip = (items: DisplayItem[]): Array<Omit<A2uiItem, "origin">> => a2uiOf(items).map(({ origin: _origin, ...rest }) => rest);
    expect(a2uiOf(reloaded.items).every((i) => i.origin === "history")).toBe(true);
    expect(strip(reloaded.items)).toEqual(strip(live.items));
    expect(toolsOf(reloaded.items).map((t) => [t.key, t.attribution, t.result?.kind ?? null])).toEqual(
      toolsOf(live.items).map((t) => [t.key, t.attribution, t.result?.kind ?? null]),
    );
  });

  it("a result with a uiData resource and the marker mounts its view live and reloaded; newestViewKey names a view in the plan", () => {
    const CARD_UI: Json = { uri: "ui://cards/c1", mimeType: "text/html", text: "<div>card</div>" };
    const both: Call = { ...withCarrier("t1", form("form-1")), uiData: CARD_UI };
    const f = fold(both);
    const live = plan(f);
    const kinds = (items: DisplayItem[]): string[] => items.map((i) => i.kind);
    expect(kinds(live.items)).toEqual(["user", "tool", "view"]);
    const newest = newestViewKey({ result: f });
    expect(newest?.key).toBe("view.t1");
    expect(live.items.some((i) => i.key === newest?.key)).toBe(true);
    // The store keeps a UI-carrying result as its card row (fold-rows' toolResultCarriesUi).
    const stored: ThreadHistoryRow[] = [
      { seq: 1, at: "2026-10-01T00:00:01.000Z", kind: "text", authorRole: "user", text: "go", clientMessageId: "cm_1" },
      {
        seq: 2,
        at: "2026-10-01T00:00:02.000Z",
        kind: "text",
        authorRole: "agent",
        text: null,
        clientMessageId: "cm_1#agent#0",
        toolCalls: [{ toolCallId: "t1", name: "show_form", input: {} }],
      },
      {
        seq: 3,
        at: "2026-10-01T00:00:03.000Z",
        kind: "card",
        authorRole: "agent",
        text: null,
        toolName: "show_form",
        cardSnapshot: {
          parts: [{ type: "tool-result", toolCallId: "t1", content: [], structuredContent: { "com.guuey/a2ui": carrier(form("form-1")) }, uiData: CARD_UI }],
        },
      },
    ];
    expect(kinds(planTranscript(historyInputs(stored), on()).items)).toEqual(kinds(live.items));
  });

  it("render off: the reloaded carrier is today's tool row with its JSON preview", () => {
    const reloaded = planTranscript(historyInputs(rows([withCarrier("t1", form("form-1"))])), calmPolicy());
    expect(a2uiOf(reloaded.items)).toEqual([]);
    expect(toolsOf(reloaded.items)[0]?.result?.kind).toBe("data-result");
  });
});

describe("one has-a-mount rule: the planner asks mcp-apps-host's, as the store does (guuey#2366)", () => {
  const RESOURCE: Json = { uri: "ui://x/inline", mimeType: "text/html", text: "<p>card</p>" };
  const marker = { "com.guuey/a2ui": carrier(form("form-1")) };
  const channels: ReadonlyArray<readonly [string, Call]> = [
    ["an inline resource in uiData", { id: "t1", structuredContent: marker, uiData: RESOURCE }],
    ["a ui:// locator in uiData", { id: "t1", structuredContent: marker, uiData: { resourceUri: "ui://x/1" } }],
    ["a ui:// locator in structuredContent", { id: "t1", structuredContent: { ...marker, resourceUri: "ui://x/2" } }],
    ["view data in uiData with no locator", { id: "t1", structuredContent: marker, uiData: { items: [1, 2] } }],
    ["the carrier alone", { id: "t1", structuredContent: marker }],
  ];

  for (const [name, call] of channels) {
    it(`${name}, beside a carrier: the surfaces draw exactly when no mount source exists`, () => {
      const mounts = toolResultMountSource(resultBlock(call)) !== undefined;
      const items = plan(fold(call)).items;
      expect(a2uiOf(items).length > 0).toBe(!mounts);
      expect(items.some((i) => i.kind === "view")).toBe(mounts);
    });
  }

  it("the pins are not vacuous: the channels split between mount and no mount", () => {
    expect(channels.map(([, c]) => toolResultMountSource(resultBlock(c)) !== undefined)).toEqual([true, true, true, false, false]);
  });
});
