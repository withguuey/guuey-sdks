/**
 * BYO-OIDC sign-in seam (only active when `auth.oidc` is configured in
 * guuey.app.json).
 *
 * Standard authorization-code + PKCE via oidc-client-ts. The ID TOKEN is
 * what the guuey pod verifies in BYO auth mode (audience = your client id),
 * so `getAccessToken` below returns `user.id_token` — forwarding the OAuth
 * access token instead is the classic mistake (wrong audience → 401).
 *
 * Works with any spec-compliant IdP that can host a "Sign in with Google"
 * (Auth0, AWS Cognito, Okta, Keycloak, …). Configure the IdP's allowed
 * callback URL to `<your site origin>/login`.
 */
import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
import { appConfig, type OidcConfig } from "../config";

let manager: UserManager | null = null;

export function oidcConfigured(): boolean {
  return appConfig.auth.oidc !== null;
}

function requireManager(oidc: OidcConfig): UserManager {
  if (manager) return manager;
  manager = new UserManager({
    authority: oidc.issuer,
    client_id: oidc.clientId,
    redirect_uri: `${window.location.origin}/login`,
    response_type: "code",
    scope: "openid profile email",
    userStore: new WebStorageStateStore({ store: window.localStorage }),
  });
  return manager;
}

/** Kick off the redirect sign-in flow. */
export async function signIn(): Promise<void> {
  const oidc = appConfig.auth.oidc;
  if (!oidc) throw new Error("auth.oidc is not configured in guuey.app.json");
  await requireManager(oidc).signinRedirect();
}

/** Complete the flow when the IdP redirected back to /login?code=… */
export async function completeSignIn(): Promise<User> {
  const oidc = appConfig.auth.oidc;
  if (!oidc) throw new Error("auth.oidc is not configured in guuey.app.json");
  return requireManager(oidc).signinCallback() as Promise<User>;
}

export function isSigninCallback(): boolean {
  const q = new URLSearchParams(window.location.search);
  return q.has("code") && q.has("state");
}

export async function currentUser(): Promise<User | null> {
  const oidc = appConfig.auth.oidc;
  if (!oidc) return null;
  const user = await requireManager(oidc).getUser();
  return user && !user.expired ? user : null;
}

/**
 * `getAccessToken` for `<GuueyChat>`: the current stored ID token, or null
 * when signed out / expired (the chat surfaces it as needs-sign-in; they
 * never silently fall back to guest — one identity mode per surface).
 * There is NO silent renew here — when the session expires the user signs
 * in again via /login. Wiring `automaticSilentRenew` (plus a silent
 * redirect page) is the documented upgrade if your IdP supports it.
 */
export async function getBearerToken(): Promise<string | null> {
  const user = await currentUser();
  return user?.id_token ?? null;
}

export async function signOutOidc(): Promise<void> {
  const oidc = appConfig.auth.oidc;
  if (!oidc || !manager) return;
  await manager.removeUser();
}
