/**
 * Host-page loader for the guuey widget (distribution way #1).
 *
 * The queue shim + single-init + idempotent script tag pattern — safe under
 * React strict-mode double effects and route remounts. The widget only
 * works against a DEPLOYED app (it loads from the environment's widget
 * origin and frames the app's hosted chat), so callers gate on
 * `appConfig.link`.
 */
import { appConfig } from "../config";

interface GuueyGlobal {
  (...args: unknown[]): void;
  q?: unknown[][];
  loaded?: boolean;
}

declare global {
  interface Window {
    guuey?: GuueyGlobal;
  }
}

const SCRIPT_ID = "guuey-widget-v1";
let initDispatched = false;

function ensureGlobal(): GuueyGlobal {
  if (!window.guuey) {
    const shim: GuueyGlobal = function (...args: unknown[]) {
      (shim.q = shim.q ?? []).push(args);
    };
    window.guuey = shim;
  }
  return window.guuey;
}

export type WidgetOutcome = "live" | "offline";

/**
 * Mount the widget launcher once: dispatches `guuey("init", …)` on first
 * call and injects `<widget origin>/v1.js` if it is not already on the
 * page. Subsequent calls are no-ops. Returns false when the app is not
 * linked yet (nothing to embed).
 */
export function mountWidget(onOutcome?: (o: WidgetOutcome) => void): boolean {
  const link = appConfig.link;
  if (!link) return false;

  const guuey = ensureGlobal();
  if (!initDispatched) {
    initDispatched = true;
    guuey("init", {
      app: link.appId,
      launcher: `Ask ${appConfig.brand.name}`,
      color: appConfig.theme.accent,
      theme: appConfig.theme.mode,
    });
  }

  if (!document.getElementById(SCRIPT_ID)) {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = `${link.widgetOrigin}/v1.js`;
    script.async = true;
    script.addEventListener("load", () => onOutcome?.("live"));
    script.addEventListener("error", () => onOutcome?.("offline"));
    document.head.appendChild(script);
  } else {
    onOutcome?.("live");
  }
  return true;
}

/** The copy-paste embed snippet with this app's real values, for the Home guide. */
export function widgetSnippet(): string | null {
  const link = appConfig.link;
  if (!link) return null;
  return [
    "<!-- guuey widget. Add this site to the app's allowed domains or the embed is refused. -->",
    "<script>",
    "  window.guuey = window.guuey || function(){(guuey.q=guuey.q||[]).push(arguments)};",
    `  guuey("init", { app: "${link.appId}", launcher: "Ask ${appConfig.brand.name}" });`,
    "</script>",
    `<script src="${link.widgetOrigin}/v1.js" async></script>`,
  ].join("\n");
}
