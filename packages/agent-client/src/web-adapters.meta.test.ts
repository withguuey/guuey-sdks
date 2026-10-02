/**
 * guuey#1849 leg 2: the request meta negotiation on the card action relay and
 * the read door's advertisement.
 *
 * The door that answers a card's read advertises the request meta keys it
 * admits (`admittedRequestMeta`); the relay sends the card's admitted meta as
 * the action body's `requestMeta`. A door OLDER than a key refuses it by name,
 * and on exactly that refusal the relay resends the same action ONCE without
 * `requestMeta`. The refusals below are the real answers of a live door one
 * release older than the key (`fixtures/ui-action-meta-refusal.provenance.json`),
 * byte for byte, never written from source.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UI_REQUEST_META_UNKNOWN_KEY_REFUSAL } from "@guuey/mcp-apps-host";
import { createUiActionRelay, createUiResourceReader } from "./web-adapters.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);

interface Provenance {
  captures: { [file: string]: { status: number; contentType: string; sha256: string; bytes: number } };
}
const PROVENANCE: Provenance = JSON.parse(readFileSync(new URL("ui-action-meta-refusal.provenance.json", FIXTURES), "utf8"));

/** A captured refusal, checked against its recorded hash before any test uses it. */
function captured(file: string): { status: number; contentType: string; body: Buffer } {
  const meta = PROVENANCE.captures[file];
  if (meta === undefined) throw new Error(`no provenance for ${file}`);
  const body = readFileSync(new URL(file, FIXTURES));
  expect(body.length).toBe(meta.bytes);
  expect(createHash("sha256").update(body).digest("hex")).toBe(meta.sha256);
  return { status: meta.status, contentType: meta.contentType, body };
}
const POD_REFUSAL = captured("ui-action-meta-refusal.pod.body");
const PLATFORM_REFUSAL = captured("ui-action-meta-refusal.platform.body");

const OK_BODY = { content: [{ type: "text", text: "done" }] };
const URI = "ui://ggui/render/sess-1849/hash-a";
const META = { "ai.ggui/view": "view-token.1849" };
const REQUEST = { resourceUri: URI, name: "ggui_runtime_submit_action", arguments: { actionId: "go" } };

type Answer = { status: number; body: string; contentType?: string };
const ok = (): Answer => ({ status: 200, body: JSON.stringify(OK_BODY) });
/** The captured refusal as the response body; its UTF-8 bytes are exactly the capture's. */
const refusal = (c: { status: number; contentType: string; body: Buffer }): Answer => {
  const body = c.body.toString("utf8");
  expect(Buffer.from(body, "utf8").equals(c.body)).toBe(true);
  return { status: c.status, body, contentType: c.contentType };
};

/** A fetch that answers each call from `answers` in order and records every body sent. */
function scripted(answers: Answer[]) {
  const sent: { url: string; body: { [key: string]: unknown } }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as { [key: string]: unknown } });
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected extra request");
    return new Response(next.body, {
      status: next.status,
      headers: { "content-type": next.contentType ?? "application/json" },
    });
  };
  return { fetchImpl, sent };
}

function podRelay(fetchImpl: typeof fetch) {
  return createUiActionRelay({
    apiBaseUrl: "https://api.example/v1",
    threadId: "t1",
    endpointUrl: "https://pod.example/agent/invoke",
    guestSecret: "a".repeat(64),
    fetchImpl,
  });
}

function platformRelay(fetchImpl: typeof fetch) {
  return createUiActionRelay({
    apiBaseUrl: "https://api.example/v1",
    threadId: "t1",
    endpointUrl: null,
    guestSecret: "a".repeat(64),
    fetchImpl,
  });
}

describe("the captured refusals are the door's unknown-key refusal (guuey#1849)", () => {
  it("each carries code BAD_REQUEST and exactly the frozen message, flat at the pod and wrapped at the platform", () => {
    expect(JSON.parse(POD_REFUSAL.body.toString("utf8"))).toEqual({
      code: "BAD_REQUEST",
      message: UI_REQUEST_META_UNKNOWN_KEY_REFUSAL,
    });
    expect(JSON.parse(PLATFORM_REFUSAL.body.toString("utf8"))).toEqual({
      error: { code: "BAD_REQUEST", message: UI_REQUEST_META_UNKNOWN_KEY_REFUSAL },
    });
  });
});

describe("createUiActionRelay — request meta negotiation (guuey#1849)", () => {
  it("sends the card's admitted meta as requestMeta, and nothing else changes", async () => {
    const { fetchImpl, sent } = scripted([ok()]);
    expect(await podRelay(fetchImpl)({ ...REQUEST, requestMeta: META })).toEqual(OK_BODY);
    expect(sent).toEqual([
      { url: "https://pod.example/agent/ui-action", body: { uri: URI, name: REQUEST.name, arguments: REQUEST.arguments, requestMeta: META } },
    ]);
  });

  it("an older POD door's real refusal → the same action again ONCE without requestMeta, and its answer is the result", async () => {
    const { fetchImpl, sent } = scripted([refusal(POD_REFUSAL), ok()]);
    expect(await podRelay(fetchImpl)({ ...REQUEST, requestMeta: META })).toEqual(OK_BODY);
    expect(sent.map((s) => s.url)).toEqual(["https://pod.example/agent/ui-action", "https://pod.example/agent/ui-action"]);
    expect(sent[1]!.body).toEqual({ uri: URI, name: REQUEST.name, arguments: REQUEST.arguments });
  });

  it("an older PLATFORM door's real (wrapped) refusal → the same, on the platform door", async () => {
    const { fetchImpl, sent } = scripted([refusal(PLATFORM_REFUSAL), ok()]);
    expect(await platformRelay(fetchImpl)({ ...REQUEST, requestMeta: META })).toEqual(OK_BODY);
    expect(sent.map((s) => s.url)).toEqual([
      "https://api.example/v1/threads/t1/ui-action",
      "https://api.example/v1/threads/t1/ui-action",
    ]);
    expect(sent[0]!.body["requestMeta"]).toEqual(META);
    expect(sent[1]!.body).not.toHaveProperty("requestMeta");
  });

  it("resends once, never twice: a resend refused again answers in-band", async () => {
    const { fetchImpl, sent } = scripted([refusal(POD_REFUSAL), refusal(POD_REFUSAL)]);
    const out = await podRelay(fetchImpl)({ ...REQUEST, requestMeta: META });
    expect(out.isError).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("the VALUE refusal never resends: it surfaces in-band", async () => {
    const value = { status: 400, body: JSON.stringify({ code: "BAD_REQUEST", message: "requestMeta value not admitted" }) };
    const { fetchImpl, sent } = scripted([value]);
    const out = await podRelay(fetchImpl)({ ...REQUEST, requestMeta: META });
    expect(out.isError).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("no other 400 resends: a different code, a different message, or a body that is not JSON", async () => {
    for (const body of [
      JSON.stringify({ code: "FORBIDDEN", message: UI_REQUEST_META_UNKNOWN_KEY_REFUSAL }),
      JSON.stringify({ code: "BAD_REQUEST", message: `${UI_REQUEST_META_UNKNOWN_KEY_REFUSAL}.` }),
      "requestMeta carries a key not admitted",
    ]) {
      const { fetchImpl, sent } = scripted([{ status: 400, body }]);
      expect((await podRelay(fetchImpl)({ ...REQUEST, requestMeta: META })).isError).toBe(true);
      expect(sent).toHaveLength(1);
    }
  });

  it("an action without requestMeta never resends, even on the exact refusal", async () => {
    const { fetchImpl, sent } = scripted([refusal(POD_REFUSAL)]);
    expect((await podRelay(fetchImpl)(REQUEST)).isError).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).not.toHaveProperty("requestMeta");
  });

  it("per action, no latch: after a refusal the next action sends requestMeta again", async () => {
    const { fetchImpl, sent } = scripted([refusal(POD_REFUSAL), ok(), ok()]);
    const relay = podRelay(fetchImpl);
    await relay({ ...REQUEST, requestMeta: META });
    await relay({ ...REQUEST, requestMeta: META });
    expect(sent.map((s) => "requestMeta" in s.body)).toEqual([true, false, true]);
  });

  it("a pod miss falls through to the platform door with requestMeta, and negotiates there", async () => {
    const { fetchImpl, sent } = scripted([{ status: 404, body: "{}" }, refusal(PLATFORM_REFUSAL), ok()]);
    expect(await podRelay(fetchImpl)({ ...REQUEST, requestMeta: META })).toEqual(OK_BODY);
    expect(sent.map((s) => [s.url, "requestMeta" in s.body])).toEqual([
      ["https://pod.example/agent/ui-action", true],
      ["https://api.example/v1/threads/t1/ui-action", true],
      ["https://api.example/v1/threads/t1/ui-action", false],
    ]);
  });
});

describe("createUiResourceReader — the read door's advertisement (guuey#1849)", () => {
  const ENTRY = { uri: URI, mimeType: "text/html;profile=mcp-app", text: "<html>card</html>" };
  function readerAnswering(body: object) {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(body), { status: 200 });
    return createUiResourceReader({
      endpointUrl: "https://pod.example/agent/invoke",
      threadId: "t1",
      guestSecret: "a".repeat(64),
      fetchImpl,
    });
  }

  it("the mount carries the keys the door advertised", async () => {
    const mount = await readerAnswering({ ...ENTRY, admittedRequestMeta: ["ai.ggui/view"] })(URI, { origin: "live" });
    expect(mount).toMatchObject({ resource: { uri: URI }, admittedRequestMeta: ["ai.ggui/view"] });
  });

  it("a door that advertises nothing (older, or guuey dev) yields a mount without the field", async () => {
    const mount = await readerAnswering(ENTRY)(URI, { origin: "live" });
    expect(mount).toBeDefined();
    expect(mount).not.toHaveProperty("admittedRequestMeta");
  });

  it("a malformed advertisement is no advertisement; non-string entries are dropped", async () => {
    expect(await readerAnswering({ ...ENTRY, admittedRequestMeta: "ai.ggui/view" })(URI, { origin: "live" })).not.toHaveProperty(
      "admittedRequestMeta",
    );
    expect(await readerAnswering({ ...ENTRY, admittedRequestMeta: [7, "ai.ggui/view"] })(URI, { origin: "live" })).toMatchObject({
      admittedRequestMeta: ["ai.ggui/view"],
    });
  });
});
