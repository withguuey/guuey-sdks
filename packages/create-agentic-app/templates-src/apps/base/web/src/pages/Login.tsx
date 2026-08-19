/**
 * Login — two doors, one identity rule (never both at once):
 *
 * - "Continue as guest": one click, no account. A per-browser secret is
 *   minted locally; the agent remembers this browser across visits.
 * - "Sign in": the BYO-OIDC seam. Active only when `auth.oidc` is
 *   configured in guuey.app.json (any spec-compliant IdP — this is where a
 *   "Sign in with Google" plugs in). The bound guuey app must be in BYO
 *   auth mode for the same issuer.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { appConfig } from "../config";
import { continueAsGuest, setIdentityMode } from "../lib/identity";
import { completeSignIn, isSigninCallback, oidcConfigured, signIn } from "../lib/oidc";

export function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(isSigninCallback());

  // Finish the redirect flow when the IdP sent us back here.
  useEffect(() => {
    if (!isSigninCallback()) return;
    completeSignIn()
      .then(() => {
        setIdentityMode("oidc");
        navigate("/chat", { replace: true });
      })
      .catch((err: unknown) => {
        setCompleting(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [navigate]);

  function guest() {
    continueAsGuest();
    navigate("/chat");
  }

  if (completing) {
    return (
      <main className="page login">
        <div className="login-card">
          <p>Completing sign-in…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="page login">
      <div className="login-card">
        <h1>Welcome to {appConfig.brand.name}</h1>
        {oidcConfigured() ? (
          <button type="button" className="btn btn-accent btn-wide" onClick={() => void signIn()}>
            Sign in
          </button>
        ) : (
          <button type="button" className="btn btn-wide" disabled title="Configure auth.oidc in guuey.app.json (or via bootstrap) to enable sign-in">
            Sign in — not configured yet
          </button>
        )}
        <button type="button" className="btn btn-wide" onClick={guest}>
          Continue as guest
        </button>
        <p className="hint">{appConfig.copy.login.guestHint}</p>
        {error ? <p className="error">Sign-in failed: {error}</p> : null}
      </div>
    </main>
  );
}
