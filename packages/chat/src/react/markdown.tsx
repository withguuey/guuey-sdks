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
import type { ReactNode } from "react";
import {
  parseRichText,
  type RichTextBlock,
  type RichTextInline,
} from "@silverprotocol/richtext";
import { normalizeTableRow, type RichTextTableBlock } from "../richtext-table.js";

function Inline({ nodes }: { nodes: RichTextInline[] }): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <span key={i}>{node.text}</span>;
      case "break":
        return <br key={i} />;
      case "strong":
        return (
          <strong key={i}>
            <Inline nodes={node.children} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <Inline nodes={node.children} />
          </em>
        );
      case "code":
        return (
          <code key={i} className="guuey-chat-inline-code">
            {node.code}
          </code>
        );
      case "link":
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
  });
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
      return <pre className="guuey-chat-code-fence">{block.code}</pre>;
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
