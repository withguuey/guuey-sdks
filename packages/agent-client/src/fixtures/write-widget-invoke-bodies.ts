/**
 * Regenerates `widget-invoke-bodies.json` from the builder (guuey#1213). Run
 * from the package: `npx tsx src/fixtures/write-widget-invoke-bodies.ts` (tsx is not one of its dependencies).
 * `invoke-body.test.ts` fails when the file and the builder disagree.
 */
import { writeFileSync } from "node:fs";
import { buildInvokeBody } from "../invoke-body.js";
import { WIDGET_INVOKE_BODY_CASES } from "./widget-invoke-body-cases.js";

const out = {
  $schema: "guuey/widget-invoke-bodies@1",
  generatedBy: "oss/packages/agent-client/src/fixtures/widget-invoke-body-cases.ts WIDGET_INVOKE_BODY_CASES",
  cases: WIDGET_INVOKE_BODY_CASES.map((c) => ({ name: c.name, why: c.why, body: buildInvokeBody(c.input) })),
};
const target = new URL("./widget-invoke-bodies.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, "utf8");
console.log(`wrote ${target.pathname} (${out.cases.length} cases)`);
