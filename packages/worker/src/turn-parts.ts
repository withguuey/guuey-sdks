/**
 * The turn's message parts other than text and images (`Invoke.parts`: every block kind the protocol admits but those
 * two), and the ONE delivery rule for them. Nothing is refused by kind and nothing is dropped in silence:
 *
 * - a media part (audio, file, document) with inline bytes goes to the model as the framework's own block where the
 *   model API takes that type, and is otherwise stored as a file;
 * - a media part whose source is still a link or an upload the platform has not resolved yet has no bytes here: the
 *   note says so (a link the person sent, or an uploaded file that cannot be opened here yet), and nothing is fetched;
 * - `resource`, `data` and `search-result` are stored as a JSON file of the block; `code` as a text file of its code;
 * - `resource-link` is a note line naming the link, never fetched;
 * - the agent-only kinds (`tool-call`, `tool-result`, `code-result`, `reasoning`, `compaction`, `provider-raw`) are NOT
 *   user content: each is stored as a JSON file the note labels CLIENT-SUPPLIED, and NEVER passed as the framework's own
 *   block, whatever a hello declares.
 *
 * Every stored file lives in the turn's session storage under the same rules as turn images (turn-images-store.ts), and
 * the user turn carries ONE framed `<message_files>` note with one line per non-native part. Each part's outcome rides
 * the hello's `parts`: `native`, `file` (stored, of a type the model can open with its file tool this turn) or
 * `file-unreadable` (stored or linked, the note telling the model it cannot open it, so it tells the person).
 *
 * Pure: the planner and the note never touch the disk, and a stored file's name comes only from its bytes and its kind
 * (`attachments/<sha256>.<ext>`), so the store and the note always name the same file.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isStandardBase64 } from "./images.js";
import type {
  InlineMediaPart,
  Invoke,
  InvokePart,
  InvokePartType,
  JsonValue,
  MediaPart,
  MediaPartType,
  PartState,
} from "./protocol.js";
import {
  AGENT_ONLY_PART_TYPES,
  INVOKE_PART_TYPES,
  MEDIA_PART_TYPES,
  PARTS_CAPABILITY,
  TURN_PART_MAX_BYTES,
  TURN_PARTS_MAX,
  partCapability,
} from "./protocol.js";
import { MESSAGE_FILES_TAG, escapeContextData } from "./turn-context.js";
import { TURN_IMAGES_DIR, TurnImagesError, writeTurnFile, type TurnImagesProblem } from "./turn-images-store.js";

/**
 * The model APIs a content helper builds for, each with its own native set (by source at the pinned SDKs):
 * - `claude`: none beyond images. The Anthropic API has no audio block, and a document block is not something the
 *   worker's stored-session measure reads (cli-session-hash.ts accepts text and image only), so a native document
 *   would break a resume; documents go as files, which Claude's Read tool opens.
 * - `openai-responses` (the Agents SDK's default API): file and document as `input_file`.
 * - `openai-chat-completions` (a builder's opt-in model): file and document as `input_file`, plus audio as
 *   `input_audio` for wav and mp3 only.
 * - `gemini` (Google ADK): audio, and PDF or text documents and files, as `inlineData`.
 */
export type PartsTarget = "claude" | "openai-responses" | "openai-chat-completions" | "gemini";

const OPENAI_AUDIO: readonly string[] = ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"];
const isPdfOrText = (base: string): boolean => base === "application/pdf" || base.startsWith("text/");

/**
 * A media type the worker accepts: `type/subtype`, optionally `; key=value` parameters, each part an RFC 6838 token,
 * at most {@link MEDIA_TYPE_MAX} characters. Nothing else (no space but after `;`, no newline, no quote), so a media type
 * can never forge a line of the files note or break out of a `data:` URL.
 */
const TOKEN = "[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}";
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(?:; ?${TOKEN}=${TOKEN})*$`);
export const MEDIA_TYPE_MAX = 255;
/** Whether `mediaType` is one the worker accepts ({@link MEDIA_TYPE}). */
export function isMediaType(mediaType: string): boolean {
  return mediaType.length <= MEDIA_TYPE_MAX && MEDIA_TYPE.test(mediaType);
}
/** The `type/subtype` of a media type, lowercased, without its parameters. */
export function baseMediaType(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

const isMediaKind = (part: InvokePart): part is MediaPart => (MEDIA_PART_TYPES as readonly string[]).includes(part.type);
const isInlineMedia = (part: InvokePart): part is InlineMediaPart => isMediaKind(part) && part.source.type === "base64";
/** Whether `part` is one of the agent-only kinds: never user content, never native. */
export function isAgentOnlyPart(part: InvokePart): boolean {
  return (AGENT_ONLY_PART_TYPES as readonly string[]).includes(part.type);
}

/**
 * Whether `target` takes `part` as its own block: an inline media part of a type that model API takes. Every other
 * part (any link or upload, any structured or agent-only kind) is never native.
 */
export function isNativePart(part: InvokePart, target: PartsTarget): part is InlineMediaPart {
  if (!isInlineMedia(part)) return false;
  const base = baseMediaType(part.source.mediaType);
  switch (target) {
    case "claude":
      return false;
    case "openai-responses":
      // `input_file` takes PDF and text; other file types are delivered as files.
      return part.type !== "audio" && isPdfOrText(base);
    case "openai-chat-completions":
      return part.type === "audio" ? OPENAI_AUDIO.includes(base) : isPdfOrText(base);
    case "gemini":
      return part.type === "audio" ? base.startsWith("audio/") : isPdfOrText(base);
  }
}

/**
 * The types a model can open as a stored FILE with a file tool: what the pinned Claude CLI's Read tool reads (PDF and
 * text; it refuses audio and other binary files: "This tool cannot read binary files", pinned by
 * claude-cli.integration.test.ts). The one reader measured; a worker without file tools opens none.
 */
const isReadableAsFile = (base: string): boolean =>
  base === "application/pdf" || base.startsWith("text/") || base === "application/json";

/**
 * The fixed extension map: a stored media file's extension comes from its media type alone, and anything not listed is
 * `bin`. A person's filename never reaches the path.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/json": "json",
};
/** The extension of a stored media part: from the fixed map (own entries only), else `bin`. */
export function partExtension(mediaType: string): string {
  const base = baseMediaType(mediaType);
  return Object.hasOwn(EXTENSIONS, base) ? (EXTENSIONS[base] ?? "bin") : "bin";
}

/** A `code` block's language as the note names it: a short token, else `unknown` (a language can never forge a line). */
const LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9+#._-]{0,31}$/;
const languageOf = (language: string): string => (LANGUAGE.test(language) ? language.toLowerCase() : "unknown");
/** The fixed extension map for a `code` block, by its language; anything not listed is `txt`. */
const CODE_EXTENSIONS: Readonly<Record<string, string>> = {
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  jsx: "jsx",
  python: "py",
  py: "py",
  json: "json",
  html: "html",
  css: "css",
  markdown: "md",
  md: "md",
  shell: "sh",
  bash: "sh",
  sh: "sh",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  go: "go",
  rust: "rs",
  java: "java",
  ruby: "rb",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
};
/** The extension of a stored `code` block: from the fixed map by language (own entries only), else `txt`. */
export function codeExtension(language: string): string {
  const lang = languageOf(language);
  return Object.hasOwn(CODE_EXTENSIONS, lang) ? (CODE_EXTENSIONS[lang] ?? "txt") : "txt";
}

/** Text from the wire made safe for ONE note line: every control character (newlines included) percent-encoded. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- the control range IS what is being neutralised
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}
/** A media type from the wire for the note: the media type when well formed, else that it was not given. */
const noteType = (mediaType: string | undefined): string =>
  mediaType !== undefined && isMediaType(mediaType) ? mediaType : "type not given";

/** What the note says after a stored file the model cannot open this turn. Never varies. */
export const MESSAGE_FILE_UNREADABLE = "attached, but you cannot open this type of file here; tell the person";
/** What the note says after a link the person sent: it is never fetched. Never varies. */
export const MESSAGE_LINK_NOT_OPENED = "a link the person sent; it is not opened here, so tell the person you cannot open it";
/** What the note says for an upload the platform has not resolved yet: it has no bytes here. Never varies. */
export const MESSAGE_UPLOAD_NOT_YET = "attached, but it cannot be opened here yet; tell the person";
/** The label of an agent-only part: content the person's client sent in a kind that is not user content. */
export const CLIENT_SUPPLIED_LABEL = "CLIENT-SUPPLIED";

/** A part's bytes and the name they are stored under, relative to the session storage. */
export interface StoredPart {
  name: string;
  bytes: Buffer;
}

/** How one non-native part is delivered: its note line, and the file it is stored as (none for a link or an upload). */
interface PartDelivery {
  state: Exclude<PartState, "native">;
  line: string;
  stored: StoredPart | undefined;
}

const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const storedAs = (bytes: Buffer, ext: string): StoredPart => ({ name: `${TURN_IMAGES_DIR}/${sha256Hex(bytes)}.${ext}`, bytes });

/** The bytes of a non-native part, if it has any here: inline media, a code block's code, or a block's JSON. */
export function storedPartOf(part: InvokePart): StoredPart | undefined {
  if (isMediaKind(part)) {
    return part.source.type === "base64"
      ? storedAs(Buffer.from(part.source.data, "base64"), partExtension(part.source.mediaType))
      : undefined;
  }
  if (part.type === "resource-link") return undefined;
  if (part.type === "code") return storedAs(Buffer.from(part.code, "utf8"), codeExtension(part.language));
  return storedAs(Buffer.from(JSON.stringify(part, null, 2), "utf8"), "json");
}

/**
 * The delivery of one part that is not native for this turn: its note line, its state and its stored file. The stored
 * file is always {@link storedPartOf}'s (none for a link or an upload), the same one `saveTurnParts` writes.
 */
function deliveryOf(part: InvokePart, session: string, fileTools: boolean): PartDelivery {
  const stored = storedPartOf(part);
  const fileLine = (described: string, readable: boolean): PartDelivery => {
    const path = stored === undefined ? "" : join(session, stored.name);
    const size = stored === undefined ? 0 : stored.bytes.length;
    return {
      state: readable ? "file" : "file-unreadable",
      line: `- ${path} (${described}, ${String(size)} bytes)${readable ? "" : `: ${MESSAGE_FILE_UNREADABLE}`}`,
      stored,
    };
  };
  if (isMediaKind(part)) {
    if (part.source.type === "url") {
      return { state: "file-unreadable", line: `- ${oneLine(part.source.url)} (${noteType(part.source.mediaType)}): ${MESSAGE_LINK_NOT_OPENED}`, stored };
    }
    if (part.source.type === "file") {
      return {
        state: "file-unreadable",
        line: `- an uploaded ${part.type} (${noteType(part.source.mediaType)}): ${MESSAGE_UPLOAD_NOT_YET}`,
        stored,
      };
    }
    return fileLine(part.source.mediaType, fileTools && isReadableAsFile(baseMediaType(part.source.mediaType)));
  }
  if (part.type === "resource-link") {
    return { state: "file-unreadable", line: `- ${oneLine(part.uri)}: ${MESSAGE_LINK_NOT_OPENED}`, stored };
  }
  if (part.type === "code") return fileLine(`code, ${languageOf(part.language)}`, fileTools);
  if (isAgentOnlyPart(part)) {
    const delivered = fileLine(`${CLIENT_SUPPLIED_LABEL} ${part.type}, application/json`, fileTools);
    return { ...delivered, line: delivered.line.replace(/^- /, `- ${CLIENT_SUPPLIED_LABEL} ${part.type}: `) };
  }
  return fileLine(`${part.type}, application/json`, fileTools);
}

/**
 * A turn's parts split by the one rule: the parts its framework takes natively, the note lines and stored files the
 * rest become, and each part's {@link PartState} in the order sent (the hello's `parts`).
 */
export interface TurnPartsDelivery {
  native: InlineMediaPart[];
  lines: string[];
  stored: StoredPart[];
  states: PartState[];
}

/** The turn's parts split for `target`, in the order sent. Pure: it names the files {@link storeTurnParts} writes. */
export function turnPartsDelivery(
  turn: Pick<Invoke, "parts" | "fs">,
  target: PartsTarget,
  fileTools: boolean,
): TurnPartsDelivery {
  const native: InlineMediaPart[] = [];
  const lines: string[] = [];
  const stored: StoredPart[] = [];
  const states: PartState[] = [];
  for (const part of turn.parts ?? []) {
    if (isNativePart(part, target)) {
      native.push(part);
      states.push("native");
      continue;
    }
    const delivery = deliveryOf(part, turn.fs.session, fileTools);
    states.push(delivery.state);
    lines.push(delivery.line);
    if (delivery.stored !== undefined) stored.push(delivery.stored);
  }
  return { native, lines, stored, states };
}

/** How a part reaches the model for `target` ({@link PartState}), as {@link turnPartsDelivery} decides it. */
export function partStateOf(part: InvokePart, target: PartsTarget, fileTools: boolean): PartState {
  return isNativePart(part, target) ? "native" : deliveryOf(part, "", fileTools).state;
}

/** The constant first line inside every `<message_files>` note. Never varies. */
export const MESSAGE_FILES_LEAD =
  "Files the person attached to this message, saved for this conversation. Open them with your file tools.";

/** The ONE `<message_files>` note for the turn's non-native parts, or `undefined` when there are none. */
export function frameTurnFiles(lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  // Escaped as ONE string after the join, so no tag can be split across two lines.
  const body = escapeContextData(lines.join("\n"));
  return `<${MESSAGE_FILES_TAG}>\n${MESSAGE_FILES_LEAD}\n${body}\n</${MESSAGE_FILES_TAG}>`;
}

/**
 * The hello capabilities of a worker that delivers this invoke's parts for `target`: {@link PARTS_CAPABILITY} and one
 * `invoke.<kind>.v1` per media kind it took natively. Nothing on an invoke without parts, so such a hello is unchanged.
 * The per-part truth rides the hello's `parts` ({@link turnPartsDelivery}'s `states`).
 */
export function invokePartsCapabilities(turn: Pick<Invoke, "parts" | "fs">, target: PartsTarget): string[] {
  if ((turn.parts ?? []).length === 0) return [];
  const kinds = new Set<MediaPartType>((turn.parts ?? []).filter((p) => isNativePart(p, target)).map((p) => p.type));
  return [PARTS_CAPABILITY, ...MEDIA_PART_TYPES.filter((t) => kinds.has(t)).map(partCapability)];
}

/** The hello's per-part states for this invoke ({@link TurnPartsDelivery.states}), or `undefined` without parts. */
export function invokePartStates(
  turn: Pick<Invoke, "parts" | "fs">,
  target: PartsTarget,
  fileTools: boolean,
): PartState[] | undefined {
  return (turn.parts ?? []).length === 0 ? undefined : turnPartsDelivery(turn, target, fileTools).states;
}

type JsonObject = { [key: string]: JsonValue };
const isObject = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: JsonValue | undefined): v is string => typeof v === "string";
const isNonEmptyText = (v: JsonValue | undefined): v is string => typeof v === "string" && v.length > 0;
const isPartType = (t: JsonValue | undefined): t is InvokePartType =>
  typeof t === "string" && (INVOKE_PART_TYPES as readonly string[]).includes(t);

/** A media part's source as the wire carries it, or `undefined` when it is not one this worker can deliver. */
function mediaSourceOf(v: JsonValue | undefined): MediaPart["source"] | undefined {
  if (!isObject(v)) return undefined;
  const mediaType = v.mediaType;
  if (mediaType !== undefined && (!isText(mediaType) || !isMediaType(mediaType))) return undefined;
  if (v.type === "base64") {
    if (!isText(mediaType) || !isText(v.data) || !isStandardBase64(v.data)) return undefined;
    if ((v.data.length / 4) * 3 > TURN_PART_MAX_BYTES + 2) return undefined;
    return { type: "base64", mediaType, data: v.data };
  }
  if (v.type === "url" && isNonEmptyText(v.url)) return { type: "url", url: v.url, ...(isText(mediaType) ? { mediaType } : {}) };
  if (v.type === "file" && isNonEmptyText(v.fileId)) return { type: "file", fileId: v.fileId, ...(isText(mediaType) ? { mediaType } : {}) };
  return undefined;
}

/**
 * Whether `entry` carries, well typed, the fields this worker reads of its kind. The Router sends only blocks
 * silverprotocol's own `checkAgInput` admitted (it parses, this worker delivers), so the worker checks the fields it
 * uses and carries the block as received: nothing of it is dropped on the way to the stored file.
 */
function isDeliverableBlock(entry: JsonObject, type: Exclude<InvokePartType, MediaPartType>): entry is JsonObject & InvokePart {
  switch (type) {
    case "code":
      return isText(entry.language) && isText(entry.code);
    case "resource-link":
      return isNonEmptyText(entry.uri);
    case "resource":
      return isObject(entry.resource);
    case "data":
    case "tool-call":
      return isText(entry.name);
    case "tool-result":
      return Array.isArray(entry.content);
    case "code-result":
      return isText(entry.output);
    case "provider-raw":
      return isText(entry.vendor);
    case "search-result":
    case "reasoning":
    case "compaction":
      return true;
  }
}

/**
 * The turn's parts as the wire carries them: all well formed, or none (the `attachments` rule; a Router sends only
 * parts it judged). At most {@link TURN_PARTS_MAX} parts. A media part keeps `filename?` (file) or `title?` (document)
 * and its source (inline bytes at most {@link TURN_PART_MAX_BYTES} decoded, a URL, or an upload's file id); every other
 * kind is carried as received.
 */
export function parseInvokeParts(v: JsonValue | undefined): InvokePart[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > TURN_PARTS_MAX) return undefined;
  const out: InvokePart[] = [];
  for (const entry of v) {
    if (!isObject(entry) || !isPartType(entry.type)) return undefined;
    const type = entry.type;
    if (type === "audio" || type === "file" || type === "document") {
      const source = mediaSourceOf(entry.source);
      if (source === undefined) return undefined;
      if (type === "file") out.push({ type, source, ...(isText(entry.filename) ? { filename: entry.filename } : {}) });
      else if (type === "document") out.push({ type, source, ...(isText(entry.title) ? { title: entry.title } : {}) });
      else out.push({ type, source });
      continue;
    }
    if (!isDeliverableBlock(entry, type)) return undefined;
    out.push(entry);
  }
  return out;
}

/** What the person sees when a part cannot be stored, per {@link TurnImagesProblem}. */
export const TURN_PARTS_FACES: Readonly<Record<TurnImagesProblem, string>> = {
  too_many: "This message has more attachments than this agent accepts at once. Send fewer and try again.",
  too_large: "This attachment is larger than this agent accepts. Send a smaller one.",
  not_a_directory: "This attachment could not be stored for this conversation.",
  no_space: "There is no room left to store this attachment in this conversation.",
  write_failed: "This attachment could not be stored for this conversation.",
};

/**
 * Store, in the turn's session storage, every part `target` does not take natively and that has bytes here, under the
 * names {@link turnPartsDelivery} gives them. Throws {@link TurnImagesError} on a refusal.
 */
export function saveTurnParts(turn: Pick<Invoke, "parts" | "fs">, target: PartsTarget): void {
  const parts = turn.parts ?? [];
  if (parts.length > TURN_PARTS_MAX) {
    throw new TurnImagesError("too_many", `${String(parts.length)} parts, at most ${String(TURN_PARTS_MAX)}`);
  }
  // Every non-native part with bytes is written, readable or not: one delivery path, erased with the thread's folder.
  const stored = parts.filter((part) => !isNativePart(part, target)).flatMap((part) => storedPartOf(part) ?? []);
  for (const { bytes } of stored) {
    if (bytes.length > TURN_PART_MAX_BYTES) {
      throw new TurnImagesError("too_large", `${String(bytes.length)} bytes, at most ${String(TURN_PART_MAX_BYTES)}`);
    }
  }
  for (const { bytes, name } of stored) writeTurnFile(turn.fs.session, name, bytes);
}

/**
 * {@link saveTurnParts} for a turn runner: `undefined` when every non-native part with bytes is stored (or there is
 * none), else the face the person sees; the runner ends the turn with that face instead of running it.
 */
export function storeTurnParts(turn: Pick<Invoke, "parts" | "fs">, target: PartsTarget): string | undefined {
  try {
    saveTurnParts(turn, target);
    return undefined;
  } catch (err) {
    if (err instanceof TurnImagesError) {
      process.stderr.write(`[guuey] turn parts not stored: ${err.problem} (${err.message})\n`);
      return TURN_PARTS_FACES[err.problem];
    }
    throw err;
  }
}
