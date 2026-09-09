/**
 * Opt-in analytics for a scaffolded app (guuey#1062 — platform's ruling on
 * the row, 2026-09-09):
 *
 *   1. The DEFAULT scaffold carries ZERO analytics bytes — no loader, no
 *      import, no key placeholder. A customer's app never reports to Guuey's
 *      PostHog by accident; `check-templates.mjs` asserts the template tree
 *      itself is clean (the guuey#930-class guard: template bytes, not
 *      emitted copies, are the truth).
 *   2. Opt-in ONLY by the explicit scaffold-time flag `--analytics posthog`
 *      (non-interactive-safe; the guuey-owned demo recipe passes it).
 *   3. With the flag, `web/index.html` gains the SAME cookieless loader
 *      guuey.com runs (landing guuey#626 / demos guuey#1059) — but the
 *      project key is never a literal in these bytes: the loader reads
 *      `%VITE_POSTHOG_KEY%` (+ optional `%VITE_POSTHOG_HOST%`), which Vite
 *      substitutes in `index.html` at build time from the app's env, and it
 *      renders nothing when the key is absent (Vite leaves an undefined
 *      `%VITE_*%` token in place — the guard treats that as "no key").
 *   4. Tracker semantics (cookieless_mode 'always', pageview/pageleave/
 *      autocapture, `register({ surface })`, the AEO bot register) mirror
 *      growth's snippet; growth owns them — when growth's bytes move, this
 *      block follows.
 */

export type AnalyticsProvider = 'posthog';

const PROVIDERS: readonly AnalyticsProvider[] = ['posthog'];

export type AnalyticsFlagResult =
  | { kind: 'none' }
  | { kind: 'provider'; provider: AnalyticsProvider }
  | { kind: 'invalid'; given: string; message: string };

/** Reads `--analytics <provider>` off the parsed flags. Absent = none (the default). */
export function parseAnalyticsFlag(flags: Record<string, string | true>): AnalyticsFlagResult {
  const raw = flags.analytics;
  if (raw === undefined) return { kind: 'none' };
  if (raw === true) {
    return { kind: 'invalid', given: '', message: `--analytics needs a provider: --analytics ${PROVIDERS.join('|')}` };
  }
  if ((PROVIDERS as readonly string[]).includes(raw)) return { kind: 'provider', provider: raw as AnalyticsProvider };
  return { kind: 'invalid', given: raw, message: `--analytics "${raw}" is not supported — use --analytics ${PROVIDERS.join('|')}` };
}

/**
 * The loader block for `web/index.html`'s `<head>`. Classic inline script:
 * Vite leaves it untouched in the built index.html apart from the
 * `%VITE_*%` substitutions. No key literal lives here — see the header.
 */
export const POSTHOG_LOADER_HTML = `    <!-- Cookieless PostHog (guuey#1062, opt-in via --analytics posthog) — the same
         snippet guuey.com runs (landing guuey#626 / demos guuey#1059): array.js loader,
         cookieless_mode 'always' (no cookies, nothing persisted on the visitor's device),
         pageview/pageleave/autocapture, surface register + the AEO bot register.
         The project key comes from the app's env at build time (VITE_POSTHOG_KEY);
         with no key configured this block renders nothing. -->
    <script>
(function () {
  var key = "%VITE_POSTHOG_KEY%";
  var host = "%VITE_POSTHOG_HOST%";
  if (!key || key.charAt(0) === "%") return; // no key configured (Vite leaves an undefined %VITE_*% token in place)
  if (!host || host.charAt(0) === "%") host = "https://us.i.posthog.com";
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  posthog.init(key, {
    api_host: host,
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
    cookieless_mode: 'always'
  });
  posthog.register({ surface: 'demo' });
  var ua = (navigator.userAgent || '').toLowerCase();
  var bots = [
    {m:'claude-bot',n:'claude'},{m:'claude-user',n:'claude'},{m:'claude-web',n:'claude'},
    {m:'anthropic-ai',n:'anthropic'},{m:'gptbot',n:'openai'},{m:'chatgpt-user',n:'openai'},
    {m:'oai-searchbot',n:'openai'},{m:'perplexitybot',n:'perplexity'},{m:'cohere-ai',n:'cohere'},
    {m:'google-extended',n:'google'},{m:'cursor',n:'cursor'},{m:'cline',n:'cline'},
    {m:'continue',n:'continue'},{m:'codeium',n:'codeium'}
  ];
  var hit = null;
  for (var i = 0; i < bots.length; i++) { if (ua.indexOf(bots[i].m) !== -1) { hit = bots[i]; break; } }
  posthog.register({ is_bot: hit !== null, bot_name: hit ? hit.n : null });
})();
    </script>
`;

/** Inserts the provider's loader block right before `</head>`. Returns the html unchanged for `undefined`. */
export function injectAnalytics(indexHtml: string, provider: AnalyticsProvider | undefined): string {
  if (provider === undefined) return indexHtml;
  const marker = '</head>';
  const at = indexHtml.indexOf(marker);
  if (at === -1) throw new Error('web/index.html has no </head> to receive the analytics loader');
  return indexHtml.slice(0, at) + POSTHOG_LOADER_HTML + indexHtml.slice(at);
}
