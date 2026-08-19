/**
 * Home — the instructions page: live agent status + the three-ways
 * distribution guide, every snippet carrying this app's REAL values (no
 * "replace me" placeholders once linked).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { agentEndpointUrl, appConfig } from "../config";
import { CHAT_PATH } from "../routes";
import { probeAgent, type AgentProbe } from "../lib/status";
import { widgetSnippet } from "../lib/widget";

function chatSnippet(): string {
  const endpoint = appConfig.link?.endpointUrl ?? "http://localhost:6790";
  const api = appConfig.link?.apiBaseUrl ?? "http://localhost:6790";
  const appId = appConfig.link?.appId ?? "local";
  return [
    `import { GuueyChat } from "@guuey/chat/react";`,
    `import "@guuey/chat/styles.css";`,
    ``,
    `<GuueyChat`,
    `  endpointUrl="${endpoint}"`,
    `  appId="${appId}"`,
    `  apiBaseUrl="${api}"`,
    `  getGuestSecret={() => myGuestSecret}`,
    `/>`,
  ].join("\n");
}

export function Home() {
  const [probe, setProbe] = useState<AgentProbe>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;
    void probeAgent().then((result) => {
      if (!cancelled) setProbe(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const link = appConfig.link;

  return (
    <main className="page home">
      <section className="card">
        <h2>Agent status</h2>
        <dl className="facts">
          <dt>Endpoint</dt>
          <dd>
            <code>{agentEndpointUrl()}</code>
          </dd>
          <dt>Reachability</dt>
          <dd>
            {probe.state === "checking" ? "checking…" : null}
            {probe.state === "reachable" ? <span className="ok">reachable</span> : null}
            {probe.state === "unreachable" ? <span className="calm">{probe.hint}</span> : null}
          </dd>
          {link ? (
            <>
              <dt>App</dt>
              <dd>
                <code>{link.appId}</code> ({link.env})
              </dd>
              {link.pageUrl ? (
                <>
                  <dt>Agent's page</dt>
                  <dd>
                    <a href={link.pageUrl} target="_blank" rel="noreferrer">
                      {link.pageUrl}
                    </a>
                  </dd>
                </>
              ) : null}
            </>
          ) : (
            <>
              <dt>Deployment</dt>
              <dd className="calm">
                not linked yet — <code>pnpm bootstrap -- --link</code> binds a deployed guuey app
              </dd>
            </>
          )}
        </dl>
        <p className="hint">
          Full detail lives in the CLI: <code>pnpm status</code> (runs{" "}
          <code>guuey apps get</code> + <code>guuey agent status</code>).
        </p>
      </section>

      <section className="card">
        <h2>Three ways your users reach this agent</h2>

        <h3>1 · The widget, on any site</h3>
        <p>One script tag gives any page the floating launcher.</p>
        {link ? (
          <pre>
            <code>{widgetSnippet()}</code>
          </pre>
        ) : (
          <p className="calm">Snippet appears with real values after linking.</p>
        )}

        <h3>2 · Embedded chat, inside your app</h3>
        <p>
          The <code>@guuey/chat</code> kit, running on the <Link to={CHAT_PATH}>Chat page</Link> of
          this very app:
        </p>
        <pre>
          <code>{chatSnippet()}</code>
        </pre>

        <h3>3 · The guuey portal</h3>
        {link?.slug ? (
          <p>
            Users can find and chat with this agent in the portal:{" "}
            <a href={`${link.portalUrl}/agent/${link.slug}`} target="_blank" rel="noreferrer">
              {link.portalUrl}/agent/{link.slug}
            </a>
          </p>
        ) : link ? (
          <p className="calm">
            Claim a public short name first — <code>guuey slug claim &lt;name&gt;</code> — then the
            portal link (and the agent's own page) light up.
          </p>
        ) : (
          <p className="calm">Available after linking a deployed app.</p>
        )}
      </section>
    </main>
  );
}
