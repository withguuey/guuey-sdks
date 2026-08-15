/**
 * The R1 markdown surface, React Native projection.
 *
 * Same sanitizer boundary as the web kit (`react/markdown.tsx`), same
 * pipeline: `@silverprotocol/richtext` parses markdown into a TYPED AST in
 * which raw HTML is structurally unrepresentable — `<script>` in model
 * output can only ever be literal text, there is no image node type (the
 * spec's F5 ruling holds structurally), and link `href` is populated
 * upstream only for http/https/mailto (`SAFE_HREF`). This module is pure
 * presentation: AST node → themed RN elements. Navigable links open
 * through `Linking` — the href is already allowlist-gated upstream, so no
 * second gate is re-derived here.
 *
 * Streaming-tolerant by upstream design: an unclosed `**bol` renders as
 * bold-so-far and completes in place as deltas arrive.
 *
 * Prior art: portal's `MarkdownText` (guuey#95) — this is its published,
 * token-driven descendant (colors/fonts come from the kit's resolved
 * `NativeChatTokens`, not an app theme context).
 */
import type { ReactNode } from "react";
import { Linking, Text, View } from "react-native";
import {
  parseRichText,
  type RichTextBlock,
  type RichTextInline,
} from "@silverprotocol/richtext";
import type { NativeChatTokens } from "./theme-native.js";

function InlineRuns({
  nodes,
  color,
  tokens,
  bold,
  italic,
}: {
  nodes: RichTextInline[];
  color: string;
  tokens: NativeChatTokens;
  bold?: boolean;
  italic?: boolean;
}): ReactNode {
  return nodes.map((node, i) => {
    const baseStyle = {
      color,
      fontSize: tokens.fontSize,
      fontFamily: tokens.fontFamily,
      fontWeight: bold ? ("700" as const) : ("400" as const),
      fontStyle: italic ? ("italic" as const) : ("normal" as const),
    };
    switch (node.type) {
      case "text":
        return (
          <Text key={i} style={baseStyle}>
            {node.text}
          </Text>
        );
      case "break":
        return <Text key={i}>{"\n"}</Text>;
      case "strong":
        return (
          <InlineRuns key={i} nodes={node.children} color={color} tokens={tokens} bold italic={italic} />
        );
      case "em":
        return (
          <InlineRuns key={i} nodes={node.children} color={color} tokens={tokens} bold={bold} italic />
        );
      case "code":
        return (
          <Text
            key={i}
            style={{
              color,
              fontSize: tokens.fontSize - 1,
              fontFamily: tokens.monoFontFamily,
              backgroundColor: tokens.palette.canvasMuted,
            }}
          >
            {node.code}
          </Text>
        );
      case "link": {
        const href = node.href;
        if (href === undefined) {
          // Unsafe or unresolvable target: the styled text, no press target.
          return (
            <Text key={i} style={{ ...baseStyle, textDecorationLine: "underline" }}>
              <InlineRuns nodes={node.children} color={color} tokens={tokens} bold={bold} italic={italic} />
            </Text>
          );
        }
        return (
          <Text
            key={i}
            accessibilityRole="link"
            style={{ ...baseStyle, color: tokens.palette.accent, textDecorationLine: "underline" }}
            onPress={() => {
              void Linking.openURL(href).catch(() => {
                // An unopenable-but-safe URL is a platform condition, not an error surface.
              });
            }}
          >
            <InlineRuns nodes={node.children} color={color} tokens={tokens} bold={bold} italic={italic} />
          </Text>
        );
      }
    }
  });
}

function BlockView({
  block,
  color,
  tokens,
  trailing,
}: {
  block: RichTextBlock;
  color: string;
  tokens: NativeChatTokens;
  trailing?: ReactNode;
}): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <Text style={{ fontSize: tokens.fontSize, lineHeight: Math.round(tokens.fontSize * 1.45) }}>
          <InlineRuns nodes={block.children} color={color} tokens={tokens} />
          {trailing}
        </Text>
      );
    case "heading":
      return (
        <Text
          style={{
            color,
            fontSize: tokens.fontSize + (block.level <= 3 ? 2 : 0),
            fontFamily: tokens.fontFamily,
            fontWeight: "700",
          }}
        >
          <InlineRuns nodes={block.children} color={color} tokens={tokens} bold />
          {trailing}
        </Text>
      );
    case "code-fence":
      return (
        <View
          style={{
            backgroundColor: tokens.palette.canvasMuted,
            borderRadius: tokens.radius,
            padding: tokens.pad,
          }}
        >
          <Text style={{ color, fontSize: tokens.fontSize - 2, fontFamily: tokens.monoFontFamily }}>
            {block.code}
          </Text>
          {trailing}
        </View>
      );
    case "list":
      return (
        <View style={{ gap: 2 }}>
          {block.items.map((item, j) => (
            <View key={j} style={{ flexDirection: "row" }}>
              <Text style={{ color, fontSize: tokens.fontSize, fontFamily: tokens.fontFamily }}>
                {block.ordered ? `${(block.start ?? 1) + j}. ` : "•  "}
              </Text>
              <Text style={{ flexShrink: 1, fontSize: tokens.fontSize, lineHeight: Math.round(tokens.fontSize * 1.45) }}>
                <InlineRuns nodes={item.children} color={color} tokens={tokens} />
                {j === block.items.length - 1 ? trailing : null}
              </Text>
            </View>
          ))}
        </View>
      );
  }
}

/** Sanitized markdown → themed RN elements (see the module docblock). */
export function NativeMarkdown({
  text,
  color,
  tokens,
  trailing,
}: {
  text: string;
  color: string;
  tokens: NativeChatTokens;
  /** Appended inside the LAST block so a streaming caret hugs the text. */
  trailing?: ReactNode;
}): ReactNode {
  const blocks = parseRichText(text);
  return (
    <View style={{ gap: 6 }}>
      {blocks.map((block, i) => (
        <BlockView
          key={i}
          block={block}
          color={color}
          tokens={tokens}
          trailing={i === blocks.length - 1 ? trailing : undefined}
        />
      ))}
    </View>
  );
}
