/**
 * The OAuth "authorize this server" helpers (guuey#178 Slice 4) — the pure,
 * platform-blind half: narrowing an ask to the oauth2 arm, building the
 * authorize link (`&mode=` + `&returnTo=` appended by THIS client), and
 * reading/stripping the broker's return params off any location shape a
 * surface sees (web URL, native deep link, bare query).
 */
import { describe, expect, it } from "vitest";
import type { AgPausedAsk } from "@silverprotocol/core";
import {
  authRequiredFromAsks,
  OAUTH_UPFRONT_METADATA,
  oauthAuthorizeAsk,
  oauthAuthorizeHref,
  parseOAuthReturn,
  stripOAuthReturn,
} from "./oauth.js";

const START = "https://mcp.dev.sandbox.guuey.com/oauth/start?state=" + "a".repeat(64);
const ASK: AgPausedAsk = {
  askId: "mcp-oauth:app_1:linear:t1",
  kind: "auth",
  message: "Trip Planner wants to use your Linear account",
  authConfig: { scheme: "oauth2", authorizationUrl: START, scopes: ["read", "write"] },
  grantModes: [
    { id: "always", label: "Always allow" },
    { id: "once", label: "Allow this chat" },
  ],
};

/** The pod's stamp on an ask whose turn it REFUSED (guuey#605). */
const UPFRONT_ASK: AgPausedAsk = {
  ...ASK,
  metadata: { appId: "app_1", serverName: "linear", displayName: "Linear", authMode: "upfront" },
};

describe("oauthAuthorizeAsk", () => {
  it("narrows kind:auth + scheme oauth2 + authorizationUrl; everything else is null", () => {
    expect(oauthAuthorizeAsk(ASK)).toEqual({ authorizationUrl: START, scopes: ["read", "write"], upfront: false });
    expect(oauthAuthorizeAsk({ ...ASK, authConfig: { scheme: "oauth2", authorizationUrl: START } })).toEqual({
      authorizationUrl: START,
      scopes: [],
      upfront: false,
    });
    expect(oauthAuthorizeAsk({ ...ASK, kind: "approval" })).toBeNull();
    expect(oauthAuthorizeAsk({ ...ASK, authConfig: { scheme: "apiKey", authorizationUrl: START } })).toBeNull();
    expect(oauthAuthorizeAsk({ ...ASK, authConfig: { scheme: "oauth2" } })).toBeNull();
    expect(oauthAuthorizeAsk({ askId: "x", kind: "auth" })).toBeNull();
  });
});

describe("oauthAuthorizeHref", () => {
  it("appends mode + returnTo (encoded), joining with & when the URL already has a query", () => {
    expect(oauthAuthorizeHref(ASK, "once", "https://app.example.com/chat?tab=1#x")).toBe(
      `${START}&mode=once&returnTo=${encodeURIComponent("https://app.example.com/chat?tab=1#x")}`,
    );
    expect(oauthAuthorizeHref(ASK, "always", "guuey://oauth/done")).toBe(
      `${START}&mode=always&returnTo=guuey%3A%2F%2Foauth%2Fdone`,
    );
  });
  it("joins with ? when the declared URL has no query; a mode-less ask takes null and carries no mode", () => {
    const bare: AgPausedAsk = { askId: "a", kind: "auth", authConfig: { scheme: "oauth2", authorizationUrl: "https://as.example/start" } };
    expect(oauthAuthorizeHref(bare, null, "https://x.example/")).toBe("https://as.example/start?returnTo=https%3A%2F%2Fx.example%2F");
  });
  it("throws on an undeclared mode, a missing mode when modes are declared, a non-oauth ask, or an empty returnTo", () => {
    expect(() => oauthAuthorizeHref(ASK, "never", "https://x.example/")).toThrow(/not declared/);
    expect(() => oauthAuthorizeHref(ASK, null, "https://x.example/")).toThrow(/mode is required/);
    expect(() => oauthAuthorizeHref({ ...ASK, kind: "approval" }, "always", "https://x.example/")).toThrow(/not an oauth2/);
    expect(() => oauthAuthorizeHref(ASK, "always", "")).toThrow(/returnTo/);
  });
});

describe("parseOAuthReturn", () => {
  it("reads connected / error off a web URL, a native deep link, or a bare query", () => {
    expect(parseOAuthReturn("https://app.example.com/chat?connected=linear")).toEqual({ kind: "connected", serverName: "linear" });
    expect(parseOAuthReturn("https://app.example.com/chat?tab=1&connected=linear#frag")).toEqual({ kind: "connected", serverName: "linear" });
    expect(parseOAuthReturn("guuey://oauth/done?connected=linear")).toEqual({ kind: "connected", serverName: "linear" });
    expect(parseOAuthReturn("?error=access_denied")).toEqual({ kind: "error", reason: "access_denied" });
    expect(parseOAuthReturn("https://x/?error=state%20expired")).toEqual({ kind: "error", reason: "state expired" });
    expect(parseOAuthReturn("connected=linear")).toEqual({ kind: "connected", serverName: "linear" });
  });
  it("is null with neither param, or with empty values; connected wins over error", () => {
    expect(parseOAuthReturn("https://app.example.com/chat")).toBeNull();
    expect(parseOAuthReturn("https://app.example.com/chat?tab=1")).toBeNull();
    expect(parseOAuthReturn("https://app.example.com/chat?connected=")).toBeNull();
    expect(parseOAuthReturn("guuey://oauth/done")).toBeNull();
    expect(parseOAuthReturn("https://x/?error=e&connected=c")).toEqual({ kind: "connected", serverName: "c" });
  });
  it("tolerates a malformed escape in a foreign param", () => {
    expect(parseOAuthReturn("https://x/?foo=%E0%A4%A&connected=linear")).toEqual({ kind: "connected", serverName: "linear" });
  });
});

describe("stripOAuthReturn", () => {
  it("removes only the broker's params, keeps the rest + the hash, and is idempotent", () => {
    expect(stripOAuthReturn("https://app.example.com/chat?connected=linear")).toBe("https://app.example.com/chat");
    expect(stripOAuthReturn("https://app.example.com/chat?tab=1&connected=linear&x=2#f")).toBe("https://app.example.com/chat?tab=1&x=2#f");
    expect(stripOAuthReturn("https://app.example.com/chat?error=denied#f")).toBe("https://app.example.com/chat#f");
    expect(stripOAuthReturn("https://app.example.com/chat?tab=1")).toBe("https://app.example.com/chat?tab=1");
    expect(stripOAuthReturn("https://app.example.com/chat")).toBe("https://app.example.com/chat");
    const once = stripOAuthReturn("https://x/?connected=a&error=b");
    expect(stripOAuthReturn(once)).toBe(once);
  });
});

// ── guuey#605: the typed refusal ────────────────────────────────────────────
describe("authRequiredFromAsks", () => {
  it("names every upfront server once, labelled by displayName, with the ask to render", () => {
    const notion: AgPausedAsk = {
      ...UPFRONT_ASK,
      askId: "mcp-oauth:app_1:notion:t1",
      metadata: { appId: "app_1", serverName: "notion", authMode: "upfront" },
    };
    const required = authRequiredFromAsks([UPFRONT_ASK, notion]);
    expect(required).toEqual({
      servers: [
        { serverName: "linear", label: "Linear", ask: UPFRONT_ASK },
        // No displayName on the wire → the declared key IS the label.
        { serverName: "notion", label: "notion", ask: notion },
      ],
    });
  });

  it("is null for an ON-DEMAND ask, a non-oauth ask, and an empty turn — only 'upfront' gates anything", () => {
    expect(authRequiredFromAsks([ASK])).toBeNull();
    expect(authRequiredFromAsks([{ ...ASK, metadata: { serverName: "linear" } }])).toBeNull();
    expect(authRequiredFromAsks([{ askId: "a", kind: "approval", metadata: { authMode: "upfront" } }])).toBeNull();
    expect(authRequiredFromAsks([])).toBeNull();
  });

  it("ignores any authMode value that is not the declared one (an unknown schedule gates nothing)", () => {
    expect(
      authRequiredFromAsks([{ ...ASK, metadata: { serverName: "linear", authMode: "lazy" } }]),
    ).toBeNull();
    expect(authRequiredFromAsks([{ ...ASK, metadata: { serverName: "linear", authMode: 7 } }])).toBeNull();
  });

  it("collapses a re-emitted ask for the same server (the card folds; the gate must not double-name it)", () => {
    const required = authRequiredFromAsks([UPFRONT_ASK, { ...UPFRONT_ASK, askId: "mcp-oauth:app_1:linear" }]);
    expect(required?.servers.map((s) => s.serverName)).toEqual(["linear"]);
  });

  it("falls back to the askId when the producer sent no serverName (never an unnamed server)", () => {
    const nameless: AgPausedAsk = { ...ASK, metadata: { authMode: OAUTH_UPFRONT_METADATA.upfront } };
    expect(authRequiredFromAsks([nameless])?.servers[0]).toMatchObject({
      serverName: ASK.askId,
      label: ASK.askId,
    });
  });
});
