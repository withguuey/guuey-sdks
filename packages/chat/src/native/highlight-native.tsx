/**
 * guuey#2368 — the native projection of the platform-free code model
 * (`../highlight.ts`, guuey#2367): each {@link HighlightKind} maps to a
 * palette token and weight/style (the shared syntax map), and a block
 * renders as one mono <Text> holding one nested <Text> run per token. The tokens re-join to the input byte for byte, so
 * the text a reader selects is exactly the code that came in.
 */
import type { ReactNode } from "react";
import { Text } from "react-native";
import { highlightCode, type HighlightKind } from "../highlight.js";
import type { NativeChatTokens } from "./theme-native.js";

/** One token run's text style. */
export interface NativeHighlightStyle {
  color: string;
  fontWeight?: "600";
  fontStyle?: "italic";
}

/**
 * The shared syntax map (guuey#2367), identical on web: keywords and
 * keys are ink at weight 600, strings and numbers are `link` (the one
 * chromatic token every theme guarantees as readable text), comments are
 * inkMuted italic, punctuation inkMuted, plain ink. `accent` and the optional
 * tone channels stay out: on light themes they fail as text (1.05–2.82:1).
 * A mono face without an italic simply renders the comment upright in
 * inkMuted, which is the map's stated fallback.
 */
export function nativeHighlightStyle(kind: HighlightKind, tokens: NativeChatTokens, ink: string): NativeHighlightStyle {
  const p = tokens.palette;
  switch (kind) {
    case "keyword":
    case "key":
      return { color: ink, fontWeight: "600" };
    case "string":
    case "number":
      return { color: p.link ?? ink };
    case "comment":
      return { color: p.inkMuted, fontStyle: "italic" };
    case "punctuation":
      return { color: p.inkMuted };
    case "plain":
      return { color: ink };
  }
}

/** A highlighted code block's text (the caller owns the box around it). */
export function NativeHighlightedCode({
  code,
  lang,
  color,
  fontSize,
  tokens,
}: {
  code: string;
  lang: string | undefined;
  /** The plain-text colour (the surrounding bubble's ink). */
  color: string;
  fontSize: number;
  tokens: NativeChatTokens;
}): ReactNode {
  return (
    <Text selectable style={{ color, fontSize, fontFamily: tokens.monoFontFamily }}>
      {highlightCode(code, lang).map((token, i) =>
        token.kind === "plain" ? (
          token.text
        ) : (
          <Text
            key={i}
            style={nativeHighlightStyle(token.kind, tokens, color)}
          >
            {token.text}
          </Text>
        ),
      )}
    </Text>
  );
}
