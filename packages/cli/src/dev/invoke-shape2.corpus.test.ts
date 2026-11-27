/**
 * W6: `guuey dev`'s shape-2 parse holds to the ONE shared body corpus (`@guuey/agent-client`'s
 * `src/fixtures/agjson-corpus`), the same files every runtime is held to. Every body a released client sent, and every
 * body the next client sends (`next.json`), must be read by the local server as the Router reads it: as shape 2, never
 * refused, giving the local turn its text and session id and counting what it does not deliver.
 *
 * The corpus lives inside `oss/`, so it is on the public mirror too: this test FAILS when it is missing, and never skips.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { invokeShapeOf, parseDevShape2 } from "./invoke-shape2.js";

const CORPUS_DIR = fileURLToPath(new URL("../../../agent-client/src/fixtures/agjson-corpus/", import.meta.url));

/** The parts of one corpus body this test reads to compute its own expectation (the body itself is parsed as is). */
interface CorpusBody {
  metadata?: { "guuey/sessionId"?: string };
  run?: { context?: readonly object[] };
  messages?: Array<{ content: Array<{ type: string; text?: string }> }>;
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null && !Array.isArray(value);

/** One corpus file's bodies: a JSON array of objects, or the test fails here naming the file. */
function readBodies(file: string): object[] {
  const parsed: unknown = JSON.parse(readFileSync(`${CORPUS_DIR}${file}`, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every(isObject)) throw new Error(`${file}: not a JSON array of bodies`);
  return parsed;
}

function corpusFiles(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

describe("guuey dev's shape-2 parse holds to the shared body corpus (W6)", () => {
  it("the corpus is there and carries at least next.json with bodies (missing = RED, never a skip)", () => {
    expect(existsSync(CORPUS_DIR)).toBe(true);
    const files = corpusFiles();
    expect(files).toContain("next.json");
    for (const file of files) expect(readBodies(file).length, file).toBeGreaterThan(0);
  });

  it("reads every body in every file as shape 2: never refused, its text and session id given, the rest counted", () => {
    let seen = 0;
    for (const file of corpusFiles()) {
      readBodies(file).forEach((body, index) => {
        const where = `${file}[${String(index)}]`;
        expect(invokeShapeOf(body), where).toBe("shape2");
        const parsed = parseDevShape2(body);
        const shaped = body as CorpusBody;
        const blocks = shaped.messages?.[0]?.content ?? [];
        const texts = blocks.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []));
        expect(parsed.input, where).toBe(texts.join("\n\n"));
        expect(parsed.sessionId, where).toBe(shaped.metadata?.["guuey/sessionId"]);
        expect(parsed.notDelivered, where).toBe(blocks.length - texts.length + (shaped.run?.context?.length ?? 0));
        expect(parsed.resume, where).toBe(false);
        seen += 1;
      });
    }
    expect(seen).toBeGreaterThan(0);
  });
});
