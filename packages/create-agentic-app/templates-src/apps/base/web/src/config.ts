/**
 * Typed access to `guuey.app.json` — the ONE file `pnpm bootstrap` writes.
 *
 * The JSON is validated structurally here (not just cast) so a hand-edited
 * config fails with a named path instead of an undefined-deep-in-React
 * crash. The schema is documented in `../guuey.app.schema.json`.
 */
import rawConfig from "../../guuey.app.json";

export interface OidcConfig {
  /** OIDC issuer URL (https). Discovery via /.well-known/openid-configuration. */
  issuer: string;
  clientId: string;
}

export interface AppLink {
  appId: string;
  env: "dev" | "staging" | "release";
  /** Public API base ending in /v1 — history + persisted-card reads. */
  apiBaseUrl: string;
  /** The agent pod's public origin — live chat + health probe. */
  endpointUrl: string;
  /** Widget host origin serving /v1.js for this environment. */
  widgetOrigin: string;
  /** Portal web origin (the "talk on mobile" target). */
  portalUrl: string;
  slug: string | null;
  /** The agent's own hosted page (https://<slug>.agents...), when slugged. */
  pageUrl: string | null;
}

export interface AppConfig {
  schema: number;
  bootstrapped: boolean;
  brand: { name: string; tagline: string; logoText: string };
  theme: { accent: string; mode: "light" | "dark" };
  copy: {
    landing: { headline: string; sub: string };
    login: { guestHint: string };
  };
  auth: { oidc: OidcConfig | null };
  link: AppLink | null;
  demoMode: boolean;
}

class ConfigError extends Error {
  constructor(path: string, expected: string) {
    super(`guuey.app.json: ${path} — expected ${expected}. Re-run \`pnpm bootstrap\` or fix the file by hand (schema: guuey.app.schema.json).`);
  }
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) throw new ConfigError(path, "a non-empty string");
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new ConfigError(path, "a boolean");
  return v;
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(path, "an object");
  return v as Record<string, unknown>;
}

function validate(raw: unknown): AppConfig {
  const root = obj(raw, "$");
  if (root.schema !== 1) throw new ConfigError("schema", "the literal 1");

  const brand = obj(root.brand, "brand");
  const theme = obj(root.theme, "theme");
  const mode = theme.mode;
  if (mode !== "light" && mode !== "dark") throw new ConfigError("theme.mode", '"light" | "dark"');
  const copy = obj(root.copy, "copy");
  const landing = obj(copy.landing, "copy.landing");
  const login = obj(copy.login, "copy.login");
  const auth = obj(root.auth, "auth");

  let oidc: OidcConfig | null = null;
  if (auth.oidc !== null && auth.oidc !== undefined) {
    const o = obj(auth.oidc, "auth.oidc");
    oidc = { issuer: str(o.issuer, "auth.oidc.issuer"), clientId: str(o.clientId, "auth.oidc.clientId") };
  }

  let link: AppLink | null = null;
  if (root.link !== null && root.link !== undefined) {
    const l = obj(root.link, "link");
    const env = l.env;
    if (env !== "dev" && env !== "staging" && env !== "release") {
      throw new ConfigError("link.env", '"dev" | "staging" | "release"');
    }
    link = {
      appId: str(l.appId, "link.appId"),
      env,
      apiBaseUrl: str(l.apiBaseUrl, "link.apiBaseUrl"),
      // Normalize to the ORIGIN whatever shape was stored: the platform's
      // deployment records carry the full `…/agent/invoke` URL, while this
      // contract (and the probe) wants the base. The chat kit accepts
      // either, so normalizing here makes both consumers correct.
      endpointUrl: str(l.endpointUrl, "link.endpointUrl").replace(/\/agent\/invoke\/?$/, ""),
      widgetOrigin: str(l.widgetOrigin, "link.widgetOrigin"),
      portalUrl: str(l.portalUrl, "link.portalUrl"),
      slug: typeof l.slug === "string" ? l.slug : null,
      pageUrl: typeof l.pageUrl === "string" ? l.pageUrl : null,
    };
  }

  return {
    schema: 1,
    bootstrapped: bool(root.bootstrapped, "bootstrapped"),
    brand: {
      name: str(brand.name, "brand.name"),
      tagline: str(brand.tagline, "brand.tagline"),
      logoText: str(brand.logoText, "brand.logoText"),
    },
    theme: { accent: str(theme.accent, "theme.accent"), mode },
    copy: {
      landing: { headline: str(landing.headline, "copy.landing.headline"), sub: str(landing.sub, "copy.landing.sub") },
      login: { guestHint: str(login.guestHint, "copy.login.guestHint") },
    },
    auth: { oidc },
    link,
    demoMode: bool(root.demoMode ?? false, "demoMode"),
  };
}

export const appConfig: AppConfig = validate(rawConfig);

/** The local `guuey dev --serve` router (scripts/dev.mjs boots it). */
export const DEV_AGENT_URL = "http://localhost:6790";

export const isLinked: boolean = appConfig.link !== null;

/** Live-chat base: the bound pod when linked, the local dev router otherwise. */
export function agentEndpointUrl(): string {
  return appConfig.link?.endpointUrl ?? DEV_AGENT_URL;
}

/**
 * History/read-plane base. When linked this is the public API (`…/v1`);
 * in local dev, `guuey dev --serve` exposes the same read-plane route
 * shape (`/threads/:id/messages`) on its own origin, so history and
 * rehydration work locally too.
 */
export function historyBaseUrl(): string {
  return appConfig.link?.apiBaseUrl ?? DEV_AGENT_URL;
}
