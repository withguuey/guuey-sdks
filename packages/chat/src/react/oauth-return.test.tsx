// @vitest-environment jsdom
/**
 * The web half of the OAuth arm (guuey#178 Slice 4): `oauthPromptAction`
 * (a mode pick records the ledger + OPENS the link — nothing is posted; a
 * "Not now" records `cancelled`), `openOAuthAuthorize` (in place top-level,
 * a new tab when framed), and `useOAuthReturn` (reads + strips the return
 * params once, exposes a dismissible notice).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { AgHitlAnswer, AgPausedAsk } from "@silverprotocol/core";
import { buildHitlAnswer } from "../hitl.js";
import type { HitlPromptItem } from "../types.js";
import { oauthPromptAction, oauthReturnToHere, openOAuthAuthorize, useOAuthReturn, type OAuthWindow } from "./oauth-return.js";

const START = "https://mcp.example/oauth/start?state=abc";
const ASK: AgPausedAsk = {
  askId: "mcp-oauth:app_1:linear:t1",
  kind: "auth",
  message: "Trip Planner wants to use your Linear account",
  authConfig: { scheme: "oauth2", authorizationUrl: START },
  grantModes: [
    { id: "always", label: "Always allow" },
    { id: "once", label: "Allow this chat" },
  ],
};
const item = (ask: AgPausedAsk, oauth: HitlPromptItem["oauth"]): HitlPromptItem => ({
  kind: "prompt",
  key: `p.${ask.askId}`,
  promptId: ask.askId,
  expanded: true,
  promptKind: "hitl",
  ask,
  message: ask.message ?? null,
  askKind: ask.kind,
  grantModes: ask.grantModes ?? [],
  oauth,
  state: "pending",
  chosenModeId: null,
  chosenModeLabel: null,
  raw: null,
});
const OAUTH_ITEM = item(ASK, { authorizationUrl: START, scopes: [] });

function ledger(): { answerHitlPrompt: (ask: AgPausedAsk, action: Parameters<typeof buildHitlAnswer>[1]) => AgHitlAnswer; answers: AgHitlAnswer[] } {
  const answers: AgHitlAnswer[] = [];
  return {
    answers,
    answerHitlPrompt: (ask, action) => {
      const a = buildHitlAnswer(ask, action);
      answers.push(a);
      return a;
    },
  };
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("oauthPromptAction", () => {
  it("is a no-op (false) for a non-oauth item — the host's #207 branch runs", () => {
    const l = ledger();
    const approval = item({ ...ASK, kind: "approval", authConfig: undefined }, null);
    expect(oauthPromptAction({ item: approval, action: { grantModeId: "always" }, answerHitlPrompt: l.answerHitlPrompt })).toBe(false);
    expect(l.answers).toEqual([]);
  });

  it("a mode pick records the ledger and OPENS authorizationUrl&mode=&returnTo= (the caller's returnTo)", () => {
    const l = ledger();
    const open = vi.fn();
    const handled = oauthPromptAction({
      item: OAUTH_ITEM,
      action: { grantModeId: "once" },
      answerHitlPrompt: l.answerHitlPrompt,
      returnTo: "https://app.example.com/chat",
      open,
    });
    expect(handled).toBe(true);
    expect(l.answers).toEqual([{ askId: ASK.askId, status: "resolved", grantModeId: "once" }]);
    expect(open).toHaveBeenCalledWith(`${START}&mode=once&returnTo=${encodeURIComponent("https://app.example.com/chat")}`, ASK);
  });

  it("defaults returnTo to THIS page's location with stale return params stripped", () => {
    window.history.replaceState(null, "", "/chat?tab=1&connected=old");
    const l = ledger();
    const open = vi.fn();
    oauthPromptAction({ item: OAUTH_ITEM, action: { grantModeId: "always" }, answerHitlPrompt: l.answerHitlPrompt, open });
    const here = oauthReturnToHere();
    expect(here).toBe(`${window.location.origin}/chat?tab=1`);
    expect(open).toHaveBeenCalledWith(`${START}&mode=always&returnTo=${encodeURIComponent(here)}`, ASK);
  });

  it("Not now / decline / dismiss all record cancelled (still pending, re-askable) and open nothing", () => {
    for (const action of ["dismiss", "decline"] as const) {
      const l = ledger();
      const open = vi.fn();
      expect(oauthPromptAction({ item: OAUTH_ITEM, action, answerHitlPrompt: l.answerHitlPrompt, open })).toBe(true);
      expect(l.answers).toEqual([{ askId: ASK.askId, status: "cancelled" }]);
      expect(open).not.toHaveBeenCalled();
    }
  });
});

describe("openOAuthAuthorize", () => {
  const fakeWindow = (framed: boolean) => {
    const self = {};
    const open = vi.fn<OAuthWindow["open"]>(() => null);
    const assign = vi.fn<OAuthWindow["location"]["assign"]>();
    const win: OAuthWindow = { open, self, top: framed ? {} : self, location: { assign } };
    return { win, open, assign };
  };
  it("navigates in place when top-level", () => {
    const { win, open, assign } = fakeWindow(false);
    openOAuthAuthorize("https://mcp.example/oauth/start?state=1&mode=always&returnTo=x", win);
    expect(assign).toHaveBeenCalledWith("https://mcp.example/oauth/start?state=1&mode=always&returnTo=x");
    expect(open).not.toHaveBeenCalled();
  });
  it("opens a new tab when framed (an IdP will not render inside a third-party frame)", () => {
    const { win, open, assign } = fakeWindow(true);
    openOAuthAuthorize("https://mcp.example/oauth/start?state=1", win);
    expect(open).toHaveBeenCalledWith("https://mcp.example/oauth/start?state=1", "_blank", "noopener,noreferrer");
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("useOAuthReturn", () => {
  it("reads ?connected= once, strips it from the address bar, and the notice is dismissible", () => {
    window.history.replaceState(null, "", "/chat?tab=1&connected=linear#f");
    const { result } = renderHook(() => useOAuthReturn());
    expect(result.current.notice).toEqual({ kind: "connected", serverName: "linear" });
    expect(window.location.href).toBe(`${window.location.origin}/chat?tab=1#f`);
    act(() => result.current.dismiss());
    expect(result.current.notice).toBeNull();
    // A re-mount on the cleaned URL shows nothing (a reload never re-shows it).
    const again = renderHook(() => useOAuthReturn());
    expect(again.result.current.notice).toBeNull();
  });
  it("reads ?error= the same way; nothing when neither param is present", () => {
    window.history.replaceState(null, "", "/chat?error=access_denied");
    expect(renderHook(() => useOAuthReturn()).result.current.notice).toEqual({ kind: "error", reason: "access_denied" });
    expect(window.location.search).toBe("");
    window.history.replaceState(null, "", "/chat");
    expect(renderHook(() => useOAuthReturn()).result.current.notice).toBeNull();
  });
});
