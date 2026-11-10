/**
 * guuey#2293 (F2): the turn's images as each model provider's content parts:
 * ONE converter that the no-code host and every code-mode worker share, so a
 * builder's own worker hands images to its model with one call. Pure and
 * dependency-free: the parts are written structurally, so each SDK's own type
 * accepts them without this package importing any SDK.
 *
 * Every converter keeps the order the person sent the images in and puts the
 * turn's text last: `text` when given (a worker that folds history into the
 * text passes its own), else the turn's model text (`modelInputOf`). Without
 * images each returns exactly the text-only shape the turn always sent.
 */
import { modelInputOf } from "./model-text.js";
import type { Invoke, InvokeImageMimeType } from "./protocol.js";

/** The fields of an invoke a converter reads. */
export type ImageTurn = Pick<Invoke, "input" | "inputKind" | "attachments">;

/** One Anthropic Messages content block of a user turn: an image, or the text. */
export type AnthropicUserBlock =
  | { type: "image"; source: { type: "base64"; media_type: InvokeImageMimeType; data: string } }
  | { type: "text"; text: string };

/** Claude (Anthropic Messages, the Claude Agent SDK): an image block per image, then the text block. */
export function anthropicUserContent(turn: ImageTurn, text: string = modelInputOf(turn)): AnthropicUserBlock[] {
  return [
    ...(turn.attachments ?? []).map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mimeType, data: image.data },
    })),
    { type: "text" as const, text },
  ];
}

/** One OpenAI Responses user-message content part: an image (a base64 `data:` URL), or the text. */
export type OpenAiUserPart = { type: "input_image"; image: string } | { type: "input_text"; text: string };

/**
 * OpenAI (the Agents SDK's `run` input): the model text when the turn carries
 * no images, as it always was; otherwise one user message whose content is an
 * `input_image` per image, then the text.
 */
export function openaiTurnInput(
  turn: ImageTurn,
  text: string = modelInputOf(turn),
): string | Array<{ role: "user"; content: OpenAiUserPart[] }> {
  const images = turn.attachments ?? [];
  if (images.length === 0) return text;
  return [
    {
      role: "user",
      content: [
        ...images.map((image) => ({ type: "input_image" as const, image: `data:${image.mimeType};base64,${image.data}` })),
        { type: "input_text" as const, text },
      ],
    },
  ];
}

/** One Gemini part (`@google/genai` `Part`): text, or inline image data. */
export type GeminiPart = { text: string } | { inlineData: { mimeType: InvokeImageMimeType; data: string } };

/** Gemini (Google ADK, `@google/genai`): an `inlineData` part per image, then the text part. */
export function geminiUserParts(turn: ImageTurn, text: string = modelInputOf(turn)): GeminiPart[] {
  return [
    ...(turn.attachments ?? []).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
    { text },
  ];
}
