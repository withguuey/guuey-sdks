/**
 * Web rendering of the platform-free code tokens (guuey#2367): one `<span>` per
 * token, its class naming the kind, so the stylesheet maps kind → colour. The
 * token map: keyword and key are ink at weight 600, string and number are link,
 * comment is inkMuted italic, punctuation is inkMuted, plain is ink. Accent is
 * never a text colour in a fence: it fails contrast on light hosts.
 *
 * Text only: every token renders as a React text child, never as markup, so
 * agent-influenced code cannot inject anything (the package's sanitizer rule).
 */
import type { ReactNode } from "react";
import { highlightCode } from "../highlight.js";

export function HighlightedCode({ code, lang }: { code: string; lang: string | undefined }): ReactNode {
  const tokens = highlightCode(code, lang);
  // An unknown language is one plain token: render it bare, exactly as before.
  if (tokens.length === 1 && tokens[0]!.kind === "plain") return code;
  return tokens.map((token, i) =>
    token.kind === "plain" ? (
      token.text
    ) : (
      <span key={i} className={`guuey-chat-tok guuey-chat-tok-${token.kind}`}>
        {token.text}
      </span>
    ),
  );
}
