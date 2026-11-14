/**
 * N−1 across a rolling release for the launch envelope's model token, guuey#3456 (the parked Claude spare takes the
 * platform's thread token, `guuey_thr_…`), both directions:
 *
 * - An OLDER host (the 0.35.0 parser, frozen in `fixtures/launch-envelope.pre-thread-token.prev.ts`) given the new
 *   binding form boots: the line parses, so the host never fails closed at its envelope read. The version floor (TD-F)
 *   keeps the platform from sending it to such a host; this pins that it is harmless if it does.
 * - The CURRENT parser reads the older Router's line (a per-turn token) exactly as the frozen one does. What the
 *   current host does with each token is pinned in the host's `claude-spare.prev-version.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { parseLaunchEnvelope } from "./launch-envelope.js";
import {
  PREV_RELEASE_ENVELOPE_LINE,
  parseLaunchEnvelope as parseLaunchEnvelopePrev,
} from "./fixtures/launch-envelope.pre-thread-token.prev.js";

const THREAD_TOKEN_LINE = `${JSON.stringify({ v: 1, model: { wire: "anthropic", token: "guuey_thr_test" } })}\n`;

describe("an OLDER host reads the NEW binding form (guuey#3456)", () => {
  it("the 0.35.0 parser accepts a guuey_thr_ token, unchanged", () => {
    expect(parseLaunchEnvelopePrev(THREAD_TOKEN_LINE)).toEqual({ v: 1, model: { wire: "anthropic", token: "guuey_thr_test" } });
  });

  it("the frozen parser is still the strict one (a control: an unknown member is refused, so the line above is not passing a lax copy)", () => {
    expect(() => parseLaunchEnvelopePrev(`${JSON.stringify({ v: 1, model: { wire: "anthropic", token: "guuey_thr_test", endpoint: "x" } })}\n`)).toThrow(
      "model has an unknown member",
    );
  });
});

describe("the CURRENT parser reads the OLDER Router's line (guuey#3456)", () => {
  it("a per-turn token parses exactly as under the 0.35.0 parser", () => {
    expect(parseLaunchEnvelope(PREV_RELEASE_ENVELOPE_LINE)).toEqual(parseLaunchEnvelopePrev(PREV_RELEASE_ENVELOPE_LINE));
    expect(parseLaunchEnvelope(PREV_RELEASE_ENVELOPE_LINE)).toEqual({ v: 1, model: { wire: "anthropic", token: "turn-scoped-test" } });
  });

  it("the new binding form parses the same under both", () => {
    expect(parseLaunchEnvelope(THREAD_TOKEN_LINE)).toEqual(parseLaunchEnvelopePrev(THREAD_TOKEN_LINE));
  });
});
