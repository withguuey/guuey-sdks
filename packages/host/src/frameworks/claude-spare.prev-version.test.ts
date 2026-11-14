/**
 * N−1 across a rolling release for the parked spare's credential (guuey#3456), on the host's real boot path: the
 * envelope line, `parseLaunchEnvelope`, `buildHostContext`, then {@link spareAuthTokenOf}.
 *
 * - The OLDER Router's line (a per-turn model token, pinned in `@guuey/worker`'s
 *   `fixtures/launch-envelope.pre-thread-token.prev.ts`) keeps the spare on the placeholder under this host: a credential
 *   that names one turn never reaches a parked CLI, whose credential outlives the turn.
 * - The NEW line (the platform's thread token) parks the spare with that token.
 * The other direction (an older host reading the new line) is pinned in `@guuey/worker`'s
 * `launch-envelope.thread-token.prev-version.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { parseLaunchEnvelope } from "@guuey/worker";
import { buildHostContext } from "../boot-context.js";
import { CLAUDE_SPARE_PLACEHOLDER_TOKEN, spareAuthTokenOf } from "./claude-spare.js";

// The 0.35.0 release's line, byte for byte as the worker fixture pins it (a host test cannot import a worker fixture).
const PREV_RELEASE_ENVELOPE_LINE = `${JSON.stringify({ v: 1, model: { wire: "anthropic", token: "turn-scoped-test" } })}\n`;
const THREAD_TOKEN_LINE = `${JSON.stringify({ v: 1, model: { wire: "anthropic", token: "guuey_thr_test" } })}\n`;
const ENV = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9911" };

function spareCredentialFor(line: string): string {
  return spareAuthTokenOf(buildHostContext(ENV, parseLaunchEnvelope(line)).anthropicAuthToken);
}

describe("the spare's credential across a rolling release (guuey#3456)", () => {
  it("an OLDER Router's per-turn token keeps the spare on the placeholder", () => {
    expect(spareCredentialFor(PREV_RELEASE_ENVELOPE_LINE)).toBe(CLAUDE_SPARE_PLACEHOLDER_TOKEN);
  });

  it("the NEW line's thread token parks the spare with that token", () => {
    expect(spareCredentialFor(THREAD_TOKEN_LINE)).toBe("guuey_thr_test");
  });

  it("an envelope with no model capability keeps the placeholder", () => {
    expect(spareCredentialFor(`${JSON.stringify({ v: 1 })}\n`)).toBe(CLAUDE_SPARE_PLACEHOLDER_TOKEN);
  });
});
