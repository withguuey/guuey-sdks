/**
 * guuey#2031 — a mounted card's OWN props, read off the ggui shell document the
 * host already holds: the base a tap on a card painted before a reload resolves
 * its label against.
 *
 * The shells here are SYNTHETIC, written by ggui's own shell writer
 * (`gguiShellHtml`) over an invented render slice: a captured live shell carries
 * a minted live-channel token and tenant code, and has no place in a public
 * package.
 */
import { describe, expect, it } from "vitest";
import { gguiShellHtml } from "@ggui-ai/protocol/integrations/mcp-apps";
import { mountedCardProps } from "./mounted-card-props.js";
import type { ResolvedViewMount } from "./card-mount.js";
import { GREETING_PROPS, SYNTHETIC_APP, SYNTHETIC_LOCATOR, SYNTHETIC_SESSION } from "./fixtures/card-tap.synthetic.js";

function shell(slice: { [key: string]: unknown }): string {
  return gguiShellHtml({ runtimeUrl: "https://runtime.example/ggui-runtime.js", slice });
}

function mountOf(text: string, channel: ResolvedViewMount["channel"] = "ggui"): ResolvedViewMount {
  return { channel, resource: { uri: SYNTHETIC_LOCATOR, mimeType: "text/html;profile=mcp-app", text } };
}

const SLICE = {
  sessionId: SYNTHETIC_SESSION,
  appId: SYNTHETIC_APP,
  runtimeUrl: "https://runtime.example/ggui-runtime.js",
  kind: "component",
  propsJson: JSON.stringify(GREETING_PROPS),
};

describe("mountedCardProps — the props a mounted ggui shell paints from", () => {
  it("reads the render session and its props off the shell's render slice", () => {
    expect(mountedCardProps(mountOf(shell(SLICE)))).toEqual({ sessionId: SYNTHETIC_SESSION, props: GREETING_PROPS });
  });

  it("reads a base64 (`blob`) document the same way", () => {
    const html = shell(SLICE);
    const blob = btoa(String.fromCharCode(...new TextEncoder().encode(html)));
    expect(mountedCardProps({ channel: "ggui", resource: { uri: SYNTHETIC_LOCATOR, blob } })).toEqual({
      sessionId: SYNTHETIC_SESSION,
      props: GREETING_PROPS,
    });
  });

  it("is narrow on purpose: it needs only the session and the props, and tolerates the rest being absent", () => {
    // No runtime mode discriminator at all — the full slice parser would refuse this; the two fields are here.
    const minimal = { sessionId: SYNTHETIC_SESSION, propsJson: JSON.stringify({ quickReplies: [] }) };
    expect(mountedCardProps(mountOf(shell(minimal)))).toEqual({ sessionId: SYNTHETIC_SESSION, props: { quickReplies: [] } });
  });

  it("is undefined when either field is missing or malformed — never wrong words", () => {
    expect(mountedCardProps(mountOf(shell({ ...SLICE, propsJson: undefined })))).toBeUndefined();
    expect(mountedCardProps(mountOf(shell({ ...SLICE, sessionId: "" })))).toBeUndefined();
    expect(mountedCardProps(mountOf(shell({ ...SLICE, sessionId: 7 })))).toBeUndefined();
    expect(mountedCardProps(mountOf(shell({ ...SLICE, propsJson: "{not json" })))).toBeUndefined();
    expect(mountedCardProps(mountOf(shell({ ...SLICE, propsJson: "[1,2]" })))).toBeUndefined();
    expect(mountedCardProps(mountOf(shell({ ...SLICE, propsJson: { already: "an object" } })))).toBeUndefined();
  });

  it("is undefined for a document that is not a ggui shell, or a mount with no document", () => {
    expect(mountedCardProps(mountOf("<!doctype html><p>tenant card</p>", "inline"))).toBeUndefined();
    expect(mountedCardProps({ channel: "inline", resource: { uri: "ui://x" } })).toBeUndefined();
  });
});
