/**
 * guuey#2386: the host keeps its own copy of guuey's A2UI catalog id, because
 * a server SDK cannot import `@guuey/agent-client` (a client package). This
 * pins the copy to the source of truth, so the id the client advertises and
 * the id the A2UI section is gated on can never drift apart. Both files live
 * in this repository's oss/ tree, so the read works on the public mirror too.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { A2UI_GUUEY_CATALOG_ID, renderA2uiSection, A2UI_SECTION } from "./preamble.js";

const SOURCE = fileURLToPath(new URL("../../agent-client/src/catalogs.ts", import.meta.url));

describe("the host's A2UI catalog id matches @guuey/agent-client's", () => {
  it("is the value agent-client exports as A2UI_GUUEY_CATALOG_ID", () => {
    const source = readFileSync(SOURCE, "utf8");
    const match = /^export const A2UI_GUUEY_CATALOG_ID = "([^"]+)";$/m.exec(source);
    expect(match, `no A2UI_GUUEY_CATALOG_ID line in ${SOURCE}`).not.toBeNull();
    expect(A2UI_GUUEY_CATALOG_ID).toBe(match?.[1]);
  });

  it("is the id the A2UI section is gated on", () => {
    expect(renderA2uiSection([A2UI_GUUEY_CATALOG_ID], undefined)).toBe(A2UI_SECTION);
  });
});
