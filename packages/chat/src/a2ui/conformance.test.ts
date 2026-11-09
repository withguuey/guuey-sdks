/**
 * guuey#2381 — conformance with `@ggui-ai/preview-a2ui` (spec §5.6, ruling 4; S1 RED (c)).
 *
 * The frozen vector set (`__fixtures__/preview-a2ui-0.29.0-vectors.json`) is a
 * list of message sequences preview-a2ui's `parseServerMessage` accepts: the
 * package's own deterministic emitter frames, every one of its 12 shapes with
 * required fields only and with every field it defines, every enum value, and
 * edge cases. Each must be accepted by guuey and draw every component as the
 * same kind. S1b swaps the frozen file for the live package once the lock lifts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import type { A2uiCarveOut, A2uiNode } from "./schema.js";
import { validateA2uiCarrier } from "./validate.js";

interface Vector {
  name: string;
  origin: "package-example" | "generated" | "edge";
  messages: JsonValue[];
  surfaces: Array<{
    surfaceId: string;
    outcome: "drawn" | "deleted" | "ignored";
    /** Component id → the kind it draws as, for every node in the resolved tree. */
    kinds: { [id: string]: A2uiNode["component"] };
    carveOuts: { [K in A2uiCarveOut]?: number };
  }>;
}

interface VectorFile {
  source: { package: string; version: string; integrity: string; read: string[] };
  scope: string;
  vectors: Vector[];
}

const file: VectorFile = JSON.parse(readFileSync(new URL("./__fixtures__/preview-a2ui-0.29.0-vectors.json", import.meta.url), "utf8"));

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
  });

  it("covers the package's own examples, all 12 shapes and edge cases", () => {
    const origins = new Set(file.vectors.map((v) => v.origin));
    expect([...origins].sort()).toEqual(["edge", "generated", "package-example"]);
    const shapes = new Set(file.vectors.flatMap((v) => v.surfaces.flatMap((s) => Object.values(s.kinds))));
    expect([...shapes].sort()).toEqual(
      ["Button", "Card", "CheckBox", "ChoicePicker", "Column", "Divider", "Icon", "Image", "List", "Row", "Text", "TextField"],
    );
  });
});

describe("every vector preview-a2ui accepts is accepted here and draws as the same kinds (S1 (c))", () => {
  for (const vector of file.vectors) {
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
