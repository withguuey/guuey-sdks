/**
 * The face transport (guuey#1195 / guuey#1116 D3): the theme DECLARES web
 * fonts (`typography.faces`); the surface that renders the theme injects the
 * `@font-face` rules into its document and hands the same CSS to every
 * generated card through MCP-Apps `hostContext.styles.css.fonts` (a CSS
 * string the card applies with `applyHostFonts`) — the card never fetches on
 * its own. Until this module nothing read `.faces`: a declared face rendered
 * its fallback everywhere.
 *
 * The rules go into the DOCUMENT (never a shadow root — `@font-face` inside a
 * shadow tree registers no font), preferably as a constructed stylesheet on
 * `document.adoptedStyleSheets` (registers document-wide and needs no
 * `style-src` allowance), else a `<style data-guuey-faces>` in `<head>`. One
 * injection per distinct rule set per document; a second mount with the same
 * faces adds nothing.
 */
import { useEffect } from "react";
import type { GuueyChatFace } from "../theme.js";

/** A face `src` is an https URL with none of the bytes that end a `url("…")` or a declaration (the write gate's rule, re-checked here). */
const FACE_SRC_OK = /^https:\/\/[^\s"'()\\;<>]+$/;
/** Descriptor values are words, numbers, dots and percents (`400`, `italic`, `swap`, `100 900`). */
const DESCRIPTOR_OK = /^[a-z0-9 .%-]+$/i;

/**
 * The `@font-face` block for the theme's declared faces — empty when there
 * are none. A face with an inadmissible `src` or a blank family contributes
 * nothing; a repeated (family, src, weight, style) contributes once.
 */
export function facesCss(faces: readonly GuueyChatFace[] | undefined): string {
  if (faces === undefined || faces.length === 0) return "";
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const face of faces) {
    const family = face.family.trim().replace(/["\\]/g, "");
    if (family === "" || !FACE_SRC_OK.test(face.src)) continue;
    const key = `${family}|${face.src}|${face.weight ?? ""}|${face.style ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = [`font-family:"${family}"`, `src:url("${face.src}")`];
    if (face.weight !== undefined && DESCRIPTOR_OK.test(face.weight)) parts.push(`font-weight:${face.weight}`);
    if (face.style !== undefined && DESCRIPTOR_OK.test(face.style)) parts.push(`font-style:${face.style}`);
    parts.push(`font-display:${face.display !== undefined && DESCRIPTOR_OK.test(face.display) ? face.display : "swap"}`);
    rules.push(`@font-face{${parts.join(";")}}`);
  }
  return rules.join("\n");
}

const injected = new WeakMap<Document, Set<string>>();

function keyOf(css: string): string {
  let h = 5381;
  for (let i = 0; i < css.length; i += 1) h = ((h << 5) + h + css.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Register the faces in `doc`, once per distinct rule set. Constructed sheet
 * where the document supports one, else a marked `<style>` in `<head>`.
 */
export function ensureFacesInDocument(doc: Document, css: string): void {
  if (css === "") return;
  const key = keyOf(css);
  let keys = injected.get(doc);
  if (keys === undefined) {
    keys = new Set<string>();
    injected.set(doc, keys);
  }
  if (keys.has(key)) return;
  const Sheet = doc.defaultView?.CSSStyleSheet;
  if (Sheet !== undefined && typeof Sheet.prototype.replaceSync === "function" && "adoptedStyleSheets" in doc) {
    const sheet = new Sheet();
    sheet.replaceSync(css);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    keys.add(key);
    return;
  }
  if (doc.head.querySelector(`style[data-guuey-faces="${key}"]`) === null) {
    const el = doc.createElement("style");
    el.setAttribute("data-guuey-faces", key);
    el.textContent = css;
    doc.head.appendChild(el);
  }
  keys.add(key);
}

/** Inject the theme's faces into this document whenever the rule set changes. SSR-safe (an effect). */
export function useHostFaces(css: string): void {
  useEffect(() => {
    if (css !== "" && typeof document !== "undefined") ensureFacesInDocument(document, css);
  }, [css]);
}
