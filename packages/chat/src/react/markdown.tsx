/**
 * The R1 markdown surface — the ONE place `@guuey/chat` renders
 * agent-influenced content in the embedder's origin, and therefore the
 * package's sanitizer boundary (spec §3.1).
 *
 * The pipeline is `@silverprotocol/richtext`: markdown → a TYPED AST in
 * which raw HTML is structurally unrepresentable (no HTML node type
 * exists; angle brackets can only ever be literal text) → React elements.
 * That is deliberately STRONGER than the spec's letter (markdown → HTML →
 * sanitize): there is no HTML string at any point, so there is nothing to
 * sanitize incorrectly — no `dangerouslySetInnerHTML` anywhere in this
 * package.
 *
 * Safety properties, each pinned by a test:
 *  - raw HTML (`<img onerror=…>`, `<script>`) renders as literal text;
 *  - link `href` is populated upstream ONLY for http/https/mailto —
 *    `javascript:`, `data:`, `vbscript:`, and relative targets parse as
 *    styled text with NO anchor `href` (richtext's `SAFE_HREF` allowlist);
 *  - navigable links carry `rel="noopener noreferrer" target="_blank"`;
 *  - there is NO image syntax in the node vocabulary at all — the spec's
 *    F5 ruling (markdown images off; R7 media blocks are the sanctioned
 *    image path) holds structurally, not by configuration.
 *
 * Streaming-tolerant by upstream design: unclosed emphasis mid-delta
 * renders as formatted-so-far.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  parseInlineRichText,
  parseRichText,
  type RichTextBlock,
  type RichTextInline,
} from "@silverprotocol/richtext";
import { normalizeTableRow, type RichTextTableBlock } from "../richtext-table.js";
import { HighlightedCode } from "./highlighted-code.js";

/**
 * Bare-URL autolink (guuey#515): richtext mints `link` nodes only from
 * explicit `[text](url)` markdown, so a plain "https://…" in agent prose
 * parses as a text node and rendered as untappable static text — on a
 * phone that means retyping a URL out of a chat bubble. Linkify at the
 * render boundary, conservatively:
 *  - the scheme is part of the match (http/https only), so no
 *    `javascript:`/`data:` target can ever qualify — the SAFE_HREF
 *    property holds by construction;
 *  - built as React elements (no HTML string exists to inject into),
 *    same `rel`/`target` contract as explicit links;
 *  - trailing punctuation stays prose ("see https://guuey.com." must not
 *    link the dot), while a balanced closing paren/bracket stays in the
 *    URL (wiki-style paths);
 *  - schemeless "www.foo.com" is deliberately NOT linkified — guessing
 *    schemes is how autolinkers start lying;
 *  - code spans are untouched (they render `node.code`, not this path).
 */
const BARE_URL = /https?:\/\/[^\s<>]+/g;

function trimTrailingPunctuation(url: string): string {
  for (;;) {
    const last = url[url.length - 1];
    if (last === undefined) return url;
    if (last === ")" || last === "]") {
      const open = last === ")" ? "(" : "[";
      const opens = url.split(open).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
      return url;
    }
    if (".,;:!?'\"»›".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/**
 * The link rule of the inline-only mode ({@link InlineRichText}): a URL's
 * navigable form and the host shown beside it, or `null` when the URL may not
 * be a link (it then draws as inert text).
 */
export type InlineLinkGate = (url: string) => { url: string; host: string } | null;

/**
 * The kit's one gated link (guuey#2382, A2UI): opens in a new tab, sends no
 * referrer, and shows its host beside its words (spec §7.3). Agent text
 * cannot reorder that chrome (§7.1): the words are one isolate, so an
 * unterminated override stops there, and the host is a left-to-right
 * isolate of its own. Text's links, a link Button and an image's Open link
 * all draw through it; `className` is the only thing that differs.
 */
export function GatedLink({
  target,
  className,
  children,
}: {
  target: { url: string; host: string };
  className: string;
  children: ReactNode;
}): ReactNode {
  return (
    <a className={className} href={target.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
      <bdi className="guuey-chat-a2ui-words">{children}</bdi>
      <bdi className="guuey-chat-a2ui-host" dir="ltr">
        {" · "}
        {target.host}
      </bdi>
    </a>
  );
}

/** Text's links (the inline-only mode): the anchor is a bidi isolate too (the sheet). */
const TEXT_LINK_CLASS = "guuey-chat-a2ui-link";

/**
 * Bare URLs as links. With a `gate` (the inline-only mode) a URL links only
 * when the gate admits it, as a {@link GatedLink}; without one, every match
 * is the markdown surface's plain link.
 */
function linkify(text: string, gate?: InlineLinkGate): ReactNode {
  if (!text.includes("http")) return text;
  const out: ReactNode[] = [];
  let consumed = 0;
  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index;
    if (start === undefined) continue;
    const url = trimTrailingPunctuation(match[0]);
    if (url.length === 0) continue;
    const target = gate === undefined ? undefined : gate(url);
    if (target === null) continue;
    if (start > consumed) out.push(text.slice(consumed, start));
    out.push(
      target === undefined ? (
        <a key={`url-${start}`} href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>
      ) : (
        <GatedLink key={`url-${start}`} target={target} className={TEXT_LINK_CLASS}>
          {url}
        </GatedLink>
      ),
    );
    consumed = start + url.length;
  }
  if (out.length === 0) return text;
  if (consumed < text.length) out.push(text.slice(consumed));
  return out;
}

function Inline({ nodes, link }: { nodes: RichTextInline[]; link?: InlineLinkGate }): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <span key={i}>{linkify(node.text, link)}</span>;
      case "break":
        return <br key={i} />;
      case "strong":
        return (
          <strong key={i}>
            <Inline nodes={node.children} {...(link !== undefined ? { link } : {})} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <Inline nodes={node.children} {...(link !== undefined ? { link } : {})} />
          </em>
        );
      case "code":
        return (
          <code key={i} className="guuey-chat-inline-code">
            {node.code}
          </code>
        );
      case "link": {
        if (link !== undefined) {
          // The inline-only mode: the gate decides, on the parser's own safe href only.
          const target = node.href !== undefined ? link(node.href) : null;
          return target !== null ? (
            <GatedLink key={i} target={target} className={TEXT_LINK_CLASS}>
              <Inline nodes={node.children} link={link} />
            </GatedLink>
          ) : (
            <span key={i}>
              <Inline nodes={node.children} link={link} />
            </span>
          );
        }
        return node.href ? (
          <a key={i} href={node.href} target="_blank" rel="noopener noreferrer">
            <Inline nodes={node.children} />
          </a>
        ) : (
          // Unsafe or unresolvable target: the styled text, no anchor.
          <span key={i} className="guuey-chat-dead-link">
            <Inline nodes={node.children} />
          </span>
        );
      }
    }
  });
}

/** An opening code-fence line (CommonMark: up to 3 spaces, then 3 or more backticks). */
const FENCE_OPEN = /^ {0,3}(`{3,})/;

/**
 * Split text into runs the inline parser may read and code-fence runs it may
 * not: the inline parser reads a fence's backticks as code spans, so a fence
 * is carved out first and stays its literal source.
 */
function fenceRuns(text: string): Array<{ literal: boolean; text: string }> {
  const runs: Array<{ literal: boolean; lines: string[] }> = [];
  const push = (literal: boolean, line: string): void => {
    const last = runs.at(-1);
    if (last !== undefined && last.literal === literal) last.lines.push(line);
    else runs.push({ literal, lines: [line] });
  };
  let fence: number | null = null;
  for (const line of text.split("\n")) {
    if (fence === null) {
      const open = FENCE_OPEN.exec(line);
      if (open?.[1] !== undefined) fence = open[1].length;
      push(fence !== null, line);
      continue;
    }
    push(true, line);
    const close = /^ {0,3}(`{3,})\s*$/.exec(line);
    if (close?.[1] !== undefined && close[1].length >= fence) fence = null;
  }
  return runs.map((run) => ({ literal: run.literal, text: run.lines.join("\n") }));
}

/**
 * The inline-only mode (guuey#2382, A2UI `Text`): bold, italic, inline code
 * and links draw as structure; a heading, list, table, code fence or raw HTML
 * draws as its literal source text, line breaks kept. Links follow `link`
 * alone: the parser's own safe href, then the gate, else inert text; a bare
 * URL links only when the gate admits it. Every string is a text node.
 */
export function InlineRichText({ text, link }: { text: string; link: InlineLinkGate }): ReactNode {
  return fenceRuns(text).map((run, i) => (
    <Fragment key={i}>
      {i > 0 ? <br /> : null}
      {run.literal ? (
        // One text node, its line breaks and runs of spaces kept by the sheet (pre-wrap).
        <span className="guuey-chat-a2ui-literal">{run.text}</span>
      ) : (
        <Inline nodes={parseInlineRichText(run.text)} link={link} />
      )}
    </Fragment>
  ));
}

/**
 * The table arm (guuey#370 — sdk#23's node). Cells render through the
 * SAME `<Inline>` sanitizer path as every other run. Exported for tests;
 * not part of the package surface.
 */
export function TableBlock({ block }: { block: RichTextTableBlock }): ReactNode {
  const columnCount = block.header.cells.length;
  return (
    <div className="guuey-chat-table-wrap">
      <table className="guuey-chat-table">
        <thead>
          <tr>
            {normalizeTableRow(block.header, columnCount).map((cell, i) => (
              <th key={i} {...(block.align[i] !== undefined ? { style: { textAlign: block.align[i] } } : {})}>
                <Inline nodes={cell.children} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {normalizeTableRow(row, columnCount).map((cell, i) => (
                <td key={i} {...(block.align[i] !== undefined ? { style: { textAlign: block.align[i] } } : {})}>
                  <Inline nodes={cell.children} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ block }: { block: RichTextBlock }): ReactNode {
  switch (block.type) {
    case "table":
      return <TableBlock block={block} />;
    case "paragraph":
      return (
        <p>
          <Inline nodes={block.children} />
        </p>
      );
    case "heading":
      return (
        <p className={`guuey-chat-heading${block.level <= 3 ? " guuey-chat-heading-major" : ""}`}>
          <Inline nodes={block.children} />
        </p>
      );
    case "code-fence":
      return <CodeFence code={block.code} lang={block.lang} />;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag {...(block.ordered && block.start !== undefined ? { start: block.start } : {})}>
          {block.items.map((item, j) => (
            <li key={j}>
              <Inline nodes={item.children} />
            </li>
          ))}
        </Tag>
      );
    }
  }
}

/**
 * A fenced code block with its copy affordance (guuey#529 — the
 * seamless-default family: every embedder's visitors get it with zero
 * setup). The button lives in a wrapper DIV so the `<pre>` holds ONLY the
 * code (select-all inside the fence never picks up UI text); the
 * transcript's sibling-margin rules name the wrapper class alongside
 * `pre`. Copy failure is shown truthfully: the label simply stays "Copy"
 * (clipboard access needs a secure context + the iframe's
 * clipboard-write grant — manual selection always still works).
 */
/** How long the copy button reads "Copied" before it returns to "Copy". */
const COPIED_RESET_MS = 1600;

function CodeFence({ code, lang }: { code: string; lang: string | undefined }): ReactNode {
  const [copied, setCopied] = useState(false);
  // The pending "Copied" reset, cleared on unmount (parity with the native fence): a fence that
  // leaves the transcript never sets state afterwards, and a second copy restarts one timer.
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      if (reset.current !== null) clearTimeout(reset.current);
    },
    [],
  );
  return (
    <div className="guuey-chat-code-wrap">
      <pre className="guuey-chat-code-fence">
        <HighlightedCode code={code} lang={lang} />
      </pre>
      <button
        type="button"
        className="guuey-chat-code-copy"
        aria-label={copied ? "Copied" : "Copy code"}
        onClick={() => {
          const clipboard = navigator.clipboard;
          if (clipboard === undefined) return;
          // The write runs inside the click: a browser clipboard may need the gesture's own call stack.
          clipboard.writeText(code).then(
            () => {
              if (!mounted.current) return;
              setCopied(true);
              if (reset.current !== null) clearTimeout(reset.current);
              reset.current = setTimeout(() => {
                reset.current = null;
                if (mounted.current) setCopied(false);
              }, COPIED_RESET_MS);
            },
            () => {
              if (mounted.current) setCopied(false);
            },
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Sanitized markdown → React elements (see the module docblock). */
export function Markdown({ text }: { text: string }): ReactNode {
  return (
    <>
      {parseRichText(text).map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </>
  );
}
