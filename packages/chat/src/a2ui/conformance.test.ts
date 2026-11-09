/**
 * guuey#2381 — conformance with `@ggui-ai/preview-a2ui` (spec §5.6, ruling 4; S1 RED (c)).
 *
 * The frozen vector set (`corpus/fixtures/preview-a2ui-0.29.0-vectors.json`,
 * written by `corpus/a2ui-preview-vectors.mjs`) is a list of message sequences
 * preview-a2ui's `parseServerMessage` accepts, its verdict recorded per vector:
 * the package's own deterministic emitter frames, every one of its 12 shapes
 * with required fields only and with every field it defines, every enum
 * value, and edge cases. Each must be accepted by guuey and draw every
 * component as the same kind. The divergence vectors are the ones guuey
 * refuses on purpose (spec §5.6), each with the refusal it must give.
 *
 * Version: the spec names preview-a2ui 0.25.0; the lockfile resolves 0.29.0
 * (the @ggui-ai family pin), so 0.29.0 is the release judged here. S1b swaps
 * the frozen file for the live package once the lock lifts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import type { A2uiCarveOut, A2uiInvalidReason, A2uiNode } from "./schema.js";
import { validateA2uiCarrier } from "./validate.js";

interface VectorBase {
  name: string;
  messages: JsonValue[];
  /** preview-a2ui's own verdict: every message of the vector passed its `parseServerMessage`. */
  preview: "accepted";
}

/** A vector guuey must accept and draw as preview does. */
interface ConformanceVector extends VectorBase {
  origin: "package-example" | "generated" | "edge";
  surfaces: Array<{
    surfaceId: string;
    outcome: "drawn" | "deleted" | "ignored";
    /** Component id → the kind it draws as, for every node in the resolved tree. */
    kinds: { [id: string]: A2uiNode["component"] };
    carveOuts: { [K in A2uiCarveOut]?: number };
  }>;
}

/** A vector guuey refuses on purpose (spec §5.6). */
interface DivergenceVector extends VectorBase {
  origin: "divergence";
  refused: { reason: A2uiInvalidReason; level: "envelope" | "component" };
}

type Vector = ConformanceVector | DivergenceVector;

interface VectorFile {
  source: { package: string; version: string; integrity: string; read: string[]; generator: string };
  scope: string;
  vectors: Vector[];
}

const file: VectorFile = JSON.parse(
  readFileSync(new URL("../corpus/fixtures/preview-a2ui-0.29.0-vectors.json", import.meta.url), "utf8"),
);
const conformance = file.vectors.filter((v): v is ConformanceVector => v.origin !== "divergence");
const divergences = file.vectors.filter((v): v is DivergenceVector => v.origin === "divergence");

function kindsOf(node: A2uiNode | null, into: { [id: string]: A2uiNode["component"] } = {}): { [id: string]: A2uiNode["component"] } {
  if (node === null) return into;
  into[node.id] = node.component;
  switch (node.component) {
    case "Row":
    case "Column":
    case "List":
      for (const child of node.children) kindsOf(child, into);
      break;
    case "Card":
      kindsOf(node.child, into);
      break;
    default:
      break;
  }
  return into;
}

describe("the frozen vector set", () => {
  it("is the family version the lockfile resolves, with its integrity", () => {
    expect(file.source).toMatchObject({ package: "@ggui-ai/preview-a2ui", version: "0.29.0" });
    expect(file.source.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(file.source.generator).toBe("src/corpus/a2ui-preview-vectors.mjs");
  });

  it("carries preview's own verdict on every vector", () => {
    expect(file.vectors.every((v) => v.preview === "accepted")).toBe(true);
  });

  it("covers the package's own examples, all 12 shapes and edge cases", () => {
    const origins = new Set(file.vectors.map((v) => v.origin));
    expect([...origins].sort()).toEqual(["divergence", "edge", "generated", "package-example"]);
    const shapes = new Set(conformance.flatMap((v) => v.surfaces.flatMap((s) => Object.values(s.kinds))));
    expect([...shapes].sort()).toEqual(
      ["Button", "Card", "CheckBox", "ChoicePicker", "Column", "Divider", "Icon", "Image", "List", "Row", "Text", "TextField"],
    );
  });
});

describe("every vector preview-a2ui accepts is accepted here and draws as the same kinds (S1 (c))", () => {
  for (const vector of conformance) {
    it(`${vector.origin}: ${vector.name}`, () => {
      const out = validateA2uiCarrier({ format: "a2ui", version: "v0.9", messages: vector.messages });
      expect(out).toMatchObject({ ok: true });
      if (!out.ok) return;
      const got = out.surfaces.map((s) =>
        s.kind === "drawn"
          ? { surfaceId: s.surface.surfaceId, outcome: "drawn", kinds: kindsOf(s.surface.root), carveOuts: s.surface.degrade }
          : { surfaceId: s.surfaceId, outcome: s.kind, kinds: {}, carveOuts: {} },
      );
      expect(got).toEqual(vector.surfaces);
    });
  }
});

describe("the deliberate divergences: preview accepts, guuey refuses (spec §5.6)", () => {
  it("lists each one the spec names", () => {
    expect(divergences.map((v) => v.name)).toEqual([
      "TextField min without inputType number",
      "TextField min with inputType text",
      "Button action as a bare string",
      "Button action as {event}",
      "TextField maxLength over guuey's bound (1e9)",
      'action.context binding whose path does not read ("nope")',
    ]);
  });

  for (const vector of divergences) {
    it(`divergence: ${vector.name} → ${vector.refused.reason}`, () => {
      const out = validateA2uiCarrier({ format: "a2ui", version: "v0.9", messages: vector.messages });
      expect(out).toMatchObject({ ok: false, reason: vector.refused.reason, level: vector.refused.level });
    });
  }
});
