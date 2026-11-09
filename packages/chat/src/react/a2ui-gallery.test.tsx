/**
 * guuey#2382 — the A2UI gallery: one page that draws all 12 components with
 * the kit's renderer and its shipped stylesheet, light and dark side by side,
 * for a design read and a screenshot. The package has no stories, so this is
 * a test-only harness: it always checks the page holds every component in
 * both themes, and it writes the page only when asked:
 *
 *     A2UI_GALLERY_OUT=/abs/path/a2ui-gallery.html pnpm vitest run src/react/a2ui-gallery.test.tsx
 *
 * The page is static markup (no script), so its inputs show their values but
 * do not edit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgReduceResult, JsonValue } from "@silverprotocol/core";
import { planTranscript } from "../plan.js";
import { calmPolicy } from "../policy.js";
import { GUUEY_CHAT_THEME } from "../theme.js";
import { themeCssVars } from "./theme-css.js";
import type { TranscriptInputs } from "../types.js";
import { Transcript } from "./transcript.js";
import type { A2uiIconProps } from "./a2ui.js";

const V = "v0.9";
type Json = JsonValue;

/** A 48×24 floor-plan PNG: the gallery's one image that loads (policy A admits data: PNGs). */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAIAAAAzn+mLAAAAPUlEQVR42mOoaJo2qBADEN979okWCGjym0eXSEKjDhp10KiDRh006qBRB406aNRBow4addCog4angwYVAgAwKltaZ7A9AgAAAABJRU5ErkJggg==";

const FORM: Json[] = [
  { version: V, createSurface: { surfaceId: "order", catalogId: "guuey.a2ui.v1", title: "Book a table" } },
  {
    version: V,
    updateComponents: {
      surfaceId: "order",
      components: [
        { id: "root", component: "Column", children: ["intro", "meta", "card", "go-row"], gap: "md" },
        { id: "intro", component: "Text", text: "Pick a time and we'll hold it for **15 minutes**. See [our policy](https://example.com/policy)." },
        { id: "meta", component: "Row", children: ["icon", "where"], gap: "xs", align: "center" },
        { id: "icon", component: "Icon", name: "pin", label: "Location" },
        { id: "where", component: "Text", text: "Lisbon · Rua Augusta 12", variant: "caption" },
        { id: "card", component: "Card", child: "fields" },
        { id: "fields", component: "Column", children: ["name", "notes", "guests", "email", "terms", "seating", "time"], gap: "md" },
        { id: "name", component: "TextField", label: "Name", placeholder: "Your name", value: { path: "/name" }, required: true },
        { id: "notes", component: "TextField", label: "Notes", inputType: "long", placeholder: "Allergies, occasions…", value: { path: "/notes" } },
        { id: "guests", component: "TextField", label: "Guests", inputType: "number", min: 1, max: 12, value: { path: "/guests" } },
        { id: "email", component: "TextField", label: "Email", inputType: "email", value: { path: "/email" } },
        { id: "terms", component: "CheckBox", label: "Text me when the table is ready", checked: { path: "/sms" } },
        {
          id: "seating",
          component: "ChoicePicker",
          label: "Seating",
          options: [
            { label: "Inside", value: "inside" },
            { label: "Terrace", value: "terrace" },
            { label: "Bar", value: "bar" },
          ],
          value: { path: "/seating" },
          required: true,
        },
        {
          id: "time",
          component: "ChoicePicker",
          label: "Time",
          options: ["18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30"].map((t) => ({ label: t, value: t })),
          value: { path: "/time" },
        },
        { id: "go-row", component: "Row", children: ["go", "menu", "later"], gap: "sm" },
        { id: "go", component: "Button", label: "Hold my table", action: { name: "submit" }, variant: "primary" },
        { id: "menu", component: "Button", label: "Menu", href: "https://example.com/menu" },
        { id: "later", component: "Button", label: "Maybe later" },
      ],
    },
  },
  { version: V, updateDataModel: { surfaceId: "order", value: { name: "Ada Lovelace", guests: 4, sms: true, seating: "terrace", time: "19:30" } } },
];

const CARD: Json[] = [
  { version: V, createSurface: { surfaceId: "status", catalogId: "guuey.a2ui.v1", title: "Your reservation" } },
  {
    version: V,
    updateComponents: {
      surfaceId: "status",
      components: [
        { id: "root", component: "Column", children: ["h", "img", "chip", "div", "list", "unk"], gap: "sm" },
        { id: "h", component: "Text", text: "Confirmed", variant: "h2" },
        { id: "img", component: "Image", src: PNG, alt: "Floor plan" },
        { id: "chip", component: "Image", src: "https://photos.example/terrace.jpg", alt: "The terrace" },
        { id: "div", component: "Divider" },
        { id: "list", component: "List", children: ["l1", "l2", "l3"] },
        { id: "l1", component: "Text", text: "Thursday, 19:30" },
        { id: "l2", component: "Text", text: "4 guests, terrace" },
        { id: "l3", component: "Text", text: "Code `RT-4821`" },
        { id: "unk", component: "Carousel" },
      ],
    },
  },
];

function inputs(): TranscriptInputs {
  const carriers = [FORM, CARD];
  const result: AgReduceResult = {
    messages: carriers.flatMap((messages, i) => {
      const id = `t${i + 1}`;
      return [
        { id: `m-${id}`, role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: id, name: i === 0 ? "book_table" : "show_booking", input: {} }] },
        {
          id: `r-${id}`,
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: id,
              content: [],
              structuredContent: { "com.guuey/a2ui": { format: "a2ui", version: V, messages } },
            },
          ],
        },
      ];
    }),
    artifacts: [],
    memory: [],
    turns: [],
  };
  return { result, assistantText: "", status: "ready", statusElapsedMs: 0, activeTool: null, error: null, prompts: [], messages: [{ role: "user", text: "Book me a table for four" }] };
}

/** Relative luminance of a #rrggbb colour (WCAG 2). */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) throw new Error(`not #rrggbb: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h ?? "0", 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** The host's icon component (the kit takes no icon dependency). */
function HostIcon({ name, label }: A2uiIconProps) {
  return (
    <span role="img" aria-label={label ?? name}>
      {name === "pin" ? "⌖" : "•"}
    </span>
  );
}

function page(): string {
  const plan = planTranscript(inputs(), { ...calmPolicy(), a2ui: { render: true } });
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "styles.css"), "utf8");
  const half = (mode: "light" | "dark") =>
    renderToStaticMarkup(
      <Transcript plan={plan} theme={GUUEY_CHAT_THEME} mode={mode} window={false} onToggle={() => {}} resolvedMounts={new Map()} onViewPhase={() => {}} a2uiIcon={HostIcon} />,
    );
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>A2UI gallery</title>",
    `<style>${css}\nbody{margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));}\n.half{height:auto;min-height:100vh}\n.half .guuey-chat{height:auto}</style>`,
    "</head><body>",
    `<section class="half" aria-label="light">${half("light")}</section>`,
    `<section class="half" aria-label="dark">${half("dark")}</section>`,
    "</body></html>",
  ].join("\n");
}

describe("the A2UI gallery (guuey#2382)", () => {
  it("draws all 12 components in both themes", () => {
    const html = page();
    for (const cls of [
      "guuey-chat-a2ui-row",
      "guuey-chat-a2ui-column",
      "guuey-chat-a2ui-card",
      "guuey-chat-a2ui-list",
      "guuey-chat-a2ui-divider",
      "guuey-chat-a2ui-text",
      "guuey-chat-a2ui-image",
      "guuey-chat-a2ui-image-chip",
      "guuey-chat-a2ui-button",
      "guuey-chat-a2ui-input",
      "guuey-chat-a2ui-check",
      "guuey-chat-a2ui-option",
      "guuey-chat-a2ui-picker",
      "guuey-chat-a2ui-unknown",
    ]) {
      expect(html.split(`class="${cls}`).length - 1, cls).toBeGreaterThanOrEqual(2);
    }
    expect(html.split('aria-label="Location"').length - 1).toBe(2);
    // Each half really is its mode: the root's mode stamp, and the theme's own
    // surface token for that mode, dark under dark and light under light.
    for (const mode of ["light", "dark"] as const) {
      const half = html.slice(html.indexOf(`aria-label="${mode}"`));
      expect(half, mode).toContain(`data-guuey-chat-mode="${mode}"`);
      const surface = themeCssVars(GUUEY_CHAT_THEME, mode)["--_guuey-chat-surface"] ?? "";
      expect(half.slice(0, half.indexOf("data-guuey-chat-mode")), mode).toContain(`--_guuey-chat-surface:${surface}`);
      expect(luminance(surface) < 0.2, `${mode} surface ${surface}`).toBe(mode === "dark");
    }
    const out = process.env["A2UI_GALLERY_OUT"];
    if (out !== undefined && out !== "") writeFileSync(out, html);
  });
});
