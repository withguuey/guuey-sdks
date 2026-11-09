/**
 * One "has a mount" rule across packages (guuey#2366). The transcript planner
 * (`@guuey/chat`) decides that a result is a card by asking
 * `@guuey/mcp-apps-host`'s `toolResultMountSource`; the store decides it by
 * `toolResultCarriesUi`, which reads that same function over the block AS
 * STORED (without `_meta`) and adds one input only the store meets: the
 * elided-value marker its own bounded writer leaves in `uiData` when the
 * turn's card row carries the resource whole.
 *
 * These pins hold the two to one answer over every channel a mount arrives
 * on, with an A2UI carrier beside each and without one: a carrier never makes
 * a card and never stops one, in either package.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { A2UI_CARRIER_KEY, toolResultMountSource } from "@guuey/mcp-apps-host/narrowing";
import { ELIDED_VALUE_KEY, toolResultCarriesUi, type StoredToolResultBlock } from "./fold-rows.js";

const CARRIER: JsonValue = { version: "v0.9", messages: [] };
const RESOURCE: JsonValue = { uri: "ui://x/inline", mimeType: "text/html", text: "<p>card</p>" };

type Input = Omit<StoredToolResultBlock, "type" | "toolCallId">;

const CHANNELS: ReadonlyArray<readonly [string, Input]> = [
  ["an inline resource in uiData", { content: [], uiData: RESOURCE }],
  ["a wrapped inline resource in uiData", { content: [], uiData: { resource: RESOURCE } }],
  ["a ui:// locator in uiData", { content: [], uiData: { resourceUri: "ui://x/1" } }],
  ["a ui:// locator in structuredContent", { content: [], structuredContent: { resourceUri: "ui://x/2" } }],
  [
    "a ui:// resource degraded into provider-raw",
    { content: [{ type: "provider-raw", vendor: "anthropic", raw: { type: "resource", resource: RESOURCE } }] },
  ],
  ["a locator on _meta alone (never stored)", { content: [], _meta: { ui: { resourceUri: "ui://x/3" } } }],
  ["view data in uiData with no locator", { content: [], uiData: { items: [1, 2] } }],
  ["a plain structured result", { content: [], structuredContent: { card: "inbox" } }],
  ["text alone", { content: [{ type: "text", text: "done" }] }],
];

/** The same input with an A2UI carrier beside whatever it already carries. */
function withCarrier(input: Input): Input {
  const sc = input.structuredContent;
  const base = sc !== undefined && sc !== null && typeof sc === "object" && !Array.isArray(sc) ? sc : {};
  return { ...input, structuredContent: { ...base, [A2UI_CARRIER_KEY]: CARRIER } };
}

function block(input: Input, id: string): StoredToolResultBlock {
  return { type: "tool-result", toolCallId: id, ...input };
}

function stored(b: StoredToolResultBlock): StoredToolResultBlock {
  if (b._meta === undefined) return b;
  const { _meta: _dropped, ...rest } = b;
  return rest;
}

describe("one has-a-mount rule: the store reads mcp-apps-host's (guuey#2366)", () => {
  for (const [name, input] of CHANNELS) {
    for (const [arm, shaped] of [
      ["alone", input],
      ["beside an A2UI carrier", withCarrier(input)],
    ] as const) {
      it(`${name}, ${arm}: the store's card answer is the shared mount answer on the stored block`, () => {
        const b = block(shaped, "t");
        expect(toolResultCarriesUi(b)).toBe(toolResultMountSource(stored(b)) !== undefined);
      });
    }
  }

  it("the mixed case, carrier plus mount: a card on both sides", () => {
    const b = block(withCarrier({ content: [], uiData: RESOURCE }), "mixed");
    expect(toolResultMountSource(b)?.channel).toBe("inline");
    expect(toolResultCarriesUi(b)).toBe(true);
  });

  it("the other direction, carrier with no mount: a card on neither side", () => {
    const b = block(withCarrier({ content: [], structuredContent: { card: "inbox" } }), "carrier-only");
    expect(toolResultMountSource(b)).toBeUndefined();
    expect(toolResultCarriesUi(b)).toBe(false);
  });

  it("the elided marker is the store's alone: a card in the store, no mount source for the planner", () => {
    const b = block({ content: [], uiData: { [ELIDED_VALUE_KEY]: { bytes: 250_000 } } }, "elided");
    expect(toolResultCarriesUi(b)).toBe(true);
    expect(toolResultMountSource(b)).toBeUndefined();
  });

  it("the pins are not vacuous: the channels split between mount and no mount", () => {
    const answers = CHANNELS.map(([, input]) => toolResultMountSource(stored(block(input, "t"))) !== undefined);
    expect(answers).toEqual([true, true, true, true, true, false, false, false, false]);
  });
});
