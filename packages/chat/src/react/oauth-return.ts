/**
 * The web half of the OAuth "authorize this server" arm (guuey#178 Slice 4)
 * — the DOM-touching pieces the pure `../oauth.js` helpers deliberately
 * leave out. Every web surface (the `<GuueyChat>` composite, the widget, the
 * studio agent page) shares these three so the redirect + return behave the
 * same everywhere:
 *
 *   - {@link oauthReturnToHere} — the surface's own location, with a stale
 *     `?connected=`/`?error=` from a PREVIOUS dance stripped, ready to be
 *     the next `returnTo`.
 *   - {@link openOAuthAuthorize} — how the link is opened: a top-level page
 *     navigates in place (the broker 302s straight back to `returnTo`); a
 *     FRAMED page (the widget inside a customer origin) opens a new tab,
 *     because identity providers refuse to render inside a third-party
 *     frame (`X-Frame-Options` / `frame-ancestors`).
 *   - {@link useOAuthReturn} — on mount, read the broker's return params off
 *     the address bar, REPLACE the URL without them (a reload never re-shows
 *     the notice), and hand the surface a one-shot notice to render.
 */
import { useCallback, useEffect, useState } from "react";
import type { AgHitlAnswer, AgPausedAsk } from "@silverprotocol/core";
import type { HitlPromptAction } from "../hitl.js";
import { oauthAuthorizeHref, parseOAuthReturn, stripOAuthReturn, type OAuthReturn } from "../oauth.js";
import type { HitlPromptItem } from "../types.js";

/** The surface's own location as the next `returnTo` (stale return params stripped). */
export function oauthReturnToHere(): string {
  return stripOAuthReturn(window.location.href);
}

/** The slice of `window` the opener touches (injectable — jsdom's `location.assign` cannot be spied). */
export interface OAuthWindow {
  self: object;
  top: object | null;
  open: (url: string, target: string, features: string) => unknown;
  location: { assign: (url: string) => void };
}

/** Whether this document is rendered inside another origin's frame. */
function isFramed(win: OAuthWindow): boolean {
  try {
    return win.top !== win.self;
  } catch {
    // A cross-origin `window.top` read throws in some browsers — that IS framed.
    return true;
  }
}

/**
 * Open the authorize link. In place when top-level (the dance ends back on
 * this page); a new tab when framed (the IdP will not render in a frame —
 * `returnTo` then lands the SAME page top-level in that tab, where
 * {@link useOAuthReturn} shows the notice; the embedded chat picks the
 * connection up on its next turn).
 */
export function openOAuthAuthorize(href: string, win: OAuthWindow = window): void {
  if (isFramed(win)) {
    win.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  win.location.assign(href);
}

export interface UseOAuthReturnResult {
  /** The broker's answer found on the address bar at mount, until dismissed. */
  notice: OAuthReturn | null;
  dismiss: () => void;
}

/**
 * Read `?connected=<serverName>` / `?error=<reason>` off the current
 * location ONCE (on mount), strip them from the address bar via
 * `history.replaceState`, and expose the result as a dismissible notice.
 * SSR-safe: nothing runs until the effect.
 */
export function useOAuthReturn(): UseOAuthReturnResult {
  const [notice, setNotice] = useState<OAuthReturn | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const href = window.location.href;
    const found = parseOAuthReturn(href);
    if (found === null) return;
    const clean = stripOAuthReturn(href);
    if (clean !== href) window.history.replaceState(window.history.state, "", clean);
    setNotice(found);
  }, []);
  const dismiss = useCallback(() => setNotice(null), []);
  return { notice, dismiss };
}

export interface OAuthPromptActionArgs {
  item: HitlPromptItem;
  action: HitlPromptAction;
  /** The kit's ledger (`useTranscriptInputs().answerHitlPrompt`) — records the pick locally; nothing is delivered. */
  answerHitlPrompt: (ask: AgPausedAsk, action: HitlPromptAction) => AgHitlAnswer;
  /** Where the broker should send the user back; defaults to {@link oauthReturnToHere}. */
  returnTo?: string;
  /** How to open the link; defaults to {@link openOAuthAuthorize}. */
  open?: (href: string, ask: AgPausedAsk) => void;
}

/**
 * The OAuth arm of a prompt action, shared by every web surface. Returns
 * `false` (nothing done) when the item is not an OAuth ask, so a host's
 * #207 hitl branch (build the answer, POST it to the pod door) runs as
 * before. For an OAuth ask:
 *
 *   - a mode pick (or a plain accept on a mode-less ask) records the pick in
 *     the ledger — the card shows "Connecting — <mode>" — and OPENS
 *     `authorizationUrl&mode=<id>&returnTo=<here>`; NOTHING is posted to the
 *     pod (there is no answer door — the answer is the redirect);
 *   - "Not now" / decline / dismiss all record `cancelled` (still pending,
 *     re-askable): nothing is written anywhere and the pod asks again next
 *     turn.
 */
export function oauthPromptAction(args: OAuthPromptActionArgs): boolean {
  const { item, action, answerHitlPrompt } = args;
  if (item.oauth === null) return false;
  if (typeof action === "object" || action === "accept") {
    const grantModeId = typeof action === "object" ? action.grantModeId : null;
    answerHitlPrompt(item.ask, action);
    const href = oauthAuthorizeHref(item.ask, grantModeId, args.returnTo ?? oauthReturnToHere());
    if (args.open !== undefined) args.open(href, item.ask);
    else openOAuthAuthorize(href);
    return true;
  }
  answerHitlPrompt(item.ask, "dismiss");
  return true;
}
