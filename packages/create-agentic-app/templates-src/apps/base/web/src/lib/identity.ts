/**
 * End-user identity for this app's chat surfaces.
 *
 * ONE mode per surface — never both resolvers at once (a bearer + a guest
 * secret on the same request is a silent-downgrade hazard the platform
 * refuses to guess about):
 *
 * - **Guest** (always available): a client-minted 64-hex secret stored at
 *   `localStorage["guuey:guest-secret:<appId>"]` and sent as the
 *   `x-guuey-guest` header. Per-browser and persistent, so the agent
 *   remembers the visitor across reloads. This is the same mechanic the
 *   guuey widget uses. "Log out" deletes the secret — a fresh one next
 *   visit is a fresh person as far as the agent is concerned.
 * - **Signed in** (when `auth.oidc` is configured in guuey.app.json): an
 *   OIDC ID token from your IdP (see ./oidc.ts), sent as a Bearer. The
 *   bound guuey app must be in BYO auth mode for the same issuer
 *   (`guuey apps update <appId> --auth-mode byo --issuer-url … --audience <clientId>`).
 */
import { appConfig } from "../config";

export type IdentityMode = "guest" | "oidc";

const scope = appConfig.link?.appId ?? "local";
const GUEST_KEY = `guuey:guest-secret:${scope}`;
const MODE_KEY = `guuey:identity-mode:${scope}`;

function mintSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The stored guest secret, minting one on first use. */
export function ensureGuestSecret(): string {
  const existing = localStorage.getItem(GUEST_KEY);
  if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
  const fresh = mintSecret();
  localStorage.setItem(GUEST_KEY, fresh);
  return fresh;
}

export function getStoredGuestSecret(): string | null {
  const v = localStorage.getItem(GUEST_KEY);
  return v && /^[0-9a-f]{64}$/.test(v) ? v : null;
}

export function currentIdentityMode(): IdentityMode | null {
  const v = localStorage.getItem(MODE_KEY);
  return v === "guest" || v === "oidc" ? v : null;
}

export function setIdentityMode(mode: IdentityMode | null): void {
  if (mode === null) localStorage.removeItem(MODE_KEY);
  else localStorage.setItem(MODE_KEY, mode);
}

/** "Continue as guest": ensure a secret exists and select guest mode. */
export function continueAsGuest(): void {
  ensureGuestSecret();
  setIdentityMode("guest");
}

/** Log out of whichever mode is active. Guest logout forgets the secret. */
export function logOut(): void {
  if (currentIdentityMode() === "guest") localStorage.removeItem(GUEST_KEY);
  setIdentityMode(null);
}
