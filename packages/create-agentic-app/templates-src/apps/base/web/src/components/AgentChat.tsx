/**
 * The configured `<GuueyChat>` for this app — distribution way #2, the
 * embedded chat SDK. One place wires endpoint, history, identity and theme;
 * every chat surface (the /chat page here, the fullscreen agent canvas in
 * the agentic-app template) renders this.
 *
 * Identity rule: ONE mode per surface. When OIDC is configured AND a
 * session exists, the bearer wins; otherwise the client-minted guest
 * secret. Never both.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { GuueyChat } from "@guuey/chat/react";
import { agentEndpointUrl, appConfig, historyBaseUrl } from "../config";
import { ensureGuestSecret } from "../lib/identity";
import { getBearerToken, currentUser, oidcConfigured } from "../lib/oidc";

export function AgentChat({ className, style }: { className?: string; style?: CSSProperties }) {
  const [identity, setIdentity] = useState<"resolving" | "guest" | "oidc">(
    oidcConfigured() ? "resolving" : "guest",
  );

  useEffect(() => {
    if (!oidcConfigured()) return;
    let cancelled = false;
    void currentUser().then((user) => {
      if (!cancelled) setIdentity(user ? "oidc" : "guest");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (identity === "resolving") return null;

  const shared = {
    endpointUrl: agentEndpointUrl(),
    appId: appConfig.link?.appId ?? "local",
    apiBaseUrl: historyBaseUrl(),
    mode: appConfig.theme.mode,
    className,
    style,
  };

  return identity === "oidc" ? (
    <GuueyChat {...shared} getAccessToken={() => getBearerToken()} />
  ) : (
    <GuueyChat {...shared} getGuestSecret={() => ensureGuestSecret()} />
  );
}
