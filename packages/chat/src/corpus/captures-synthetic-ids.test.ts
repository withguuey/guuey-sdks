/**
 * Corpus guard: every capture under `captures/` carries synthetic ids, like
 * issue2627. Four id classes are checked, plus one opaque value:
 *
 *   - uuid: every uuid anywhere — a JSON key or value at any depth, a JSON
 *     document serialized inside a string (a tool result's `text`) at any
 *     escape depth, a bare SSE line — must be in the issue2627 zero-id shape
 *
 *       00000000-0000-4000-8000-C0000000NNNN
 *
 *     every group zero apart from the version (4) and variant (8) nibbles,
 *     one class digit C (1–9) and a four-digit decimal counter NNNN.
 *     issue2627 numbers its classes 1 (session, thread, handshake and other
 *     plain ids), 2 (turns), 3 (renders) and 4 (blueprints); user ids take
 *     class 5;
 *   - message id and tool call id: `msg_…` and `toolu_…` (24 characters
 *     after the prefix) must be a zero-padded counter, `msg_0…0NNNN`;
 *   - userId: a `userId` / `user_id` value (any case, a JSON key or a
 *     serialized pair) must be a synthetic uuid or the issue2627 guest id
 *     shape `g_0…0NNNN`;
 *   - signature: a `reasoning.opaque` event's `value` must be the dummy
 *     `AAAA…` (base64 padding allowed) — the replay never reads it.
 *
 * The walk reads each capture the way its readers do: a `.json` file as one
 * JSON document, a `.sse.txt` file event by event (each `data:` payload
 * parsed as JSON — a payload that does not parse fails the test — and every
 * other non-empty line as plain text), and any other file as plain text.
 * Streamed `*.delta` frames are also joined per stream before the scan,
 * because a stream can split one id across several frames; a match that
 * sits whole inside one frame is reported at that frame only. Every
 * offender is reported with its file and JSON path.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const ID_KINDS = ["uuid", "message id", "tool call id", "userId", "signature"] as const;
type IdKind = (typeof ID_KINDS)[number];

interface Offender {
  file: string;
  path: string;
  kind: IdKind;
  value: string;
}

interface ScanResult {
  offenders: Offender[];
  /** Every id of each class the walk saw, synthetic or not — the non-vacuity count. */
  seen: Record<IdKind, number>;
}

const CAPTURES = join(import.meta.dirname, "captures");

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const SYNTHETIC_UUID = /^00000000-0000-4000-8000-[1-9]0{7}[0-9]{4}$/;
/** A provider message / tool call id: the prefix and 24 id characters. */
const PROVIDER_ID = /(msg|toolu)_([0-9A-Za-z]{24})(?![0-9A-Za-z])/g;
const SYNTHETIC_PROVIDER_ID_BODY = /^0{20}[0-9]{4}$/;
const SYNTHETIC_GUEST_ID = /^g_0+[0-9]{1,4}$/;
const DUMMY_SIGNATURE = /^A+=*$/;
const USER_ID_KEY = /^user_?id$/i;

const emptySeen = (): Record<IdKind, number> => ({
  uuid: 0,
  "message id": 0,
  "tool call id": 0,
  userId: 0,
  signature: 0,
});

/** The issue2627 zero-id shape — see the header. */
function isSyntheticUuid(value: string): boolean {
  return SYNTHETIC_UUID.test(value);
}

/** A userId holds either a synthetic uuid or a synthetic guest id. */
function isSyntheticUserId(value: string): boolean {
  return isSyntheticUuid(value) || SYNTHETIC_GUEST_ID.test(value);
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** A half-open character span inside a scanned string. */
interface Span {
  start: number;
  end: number;
}

class Scan {
  readonly offenders: Offender[] = [];
  readonly seen: Record<IdKind, number> = emptySeen();

  constructor(private readonly file: string) {}

  private check(path: string, kind: IdKind, value: string, synthetic: boolean): void {
    this.seen[kind] += 1;
    if (!synthetic) this.offenders.push({ file: this.file, path, kind, value });
  }

  /**
   * Scan a string for uuids, provider ids and serialized `userId` pairs.
   * `skip` lists spans already reported elsewhere (the single frames of a
   * joined stream).
   */
  text(value: string, path: string, skip: Span[] = []): void {
    const inside = (start: number, end: number): boolean =>
      skip.some((s) => s.start <= start && end <= s.end);
    for (const m of value.matchAll(new RegExp(UUID, "g"))) {
      if (inside(m.index, m.index + m[0].length)) continue;
      this.check(path, "uuid", m[0], isSyntheticUuid(m[0]));
    }
    for (const m of value.matchAll(PROVIDER_ID)) {
      if (inside(m.index, m.index + m[0].length)) continue;
      const kind: IdKind = m[1] === "msg" ? "message id" : "tool call id";
      this.check(path, kind, m[0], SYNTHETIC_PROVIDER_ID_BODY.test(m[2] ?? ""));
    }
    // `"userId":"…"` in serialized JSON, at any escape depth (`\"userId\":\"…\"`).
    const pair = /\\*"(user_?id)\\*"\s*:\s*\\*"([^"\\]*)/gi;
    for (const m of value.matchAll(pair)) {
      if (inside(m.index, m.index + m[0].length)) continue;
      const id = m[2] ?? "";
      this.check(`${path} (text: ${m[1]})`, "userId", id, isSyntheticUserId(id));
    }
  }

  json(value: JsonValue, path: string): void {
    if (typeof value === "string") {
      this.text(value, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => this.json(item, `${path}[${i}]`));
      return;
    }
    if (!isObject(value)) return;
    if (value.type === "reasoning.opaque" && typeof value.value === "string") {
      this.check(keyPath(path, "value"), "signature", value.value, DUMMY_SIGNATURE.test(value.value));
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = keyPath(path, key);
      this.text(key, `${childPath} (key)`);
      if (USER_ID_KEY.test(key) && typeof child === "string") {
        this.check(childPath, "userId", child, isSyntheticUserId(child));
      }
      this.json(child, childPath);
    }
  }

  /** An SSE capture: every event's `data:` payload and other line, then every joined `*.delta` stream. */
  sse(source: string): void {
    const streams = new Map<string, { frames: number[]; parts: string[] }>();
    let frame = 0;
    let event = "message";
    let data: string[] = [];
    const dispatch = (): void => {
      if (data.length === 0) return;
      const payload: JsonValue = JSON.parse(data.join("\n"));
      const at = `frames[${frame}](${event})`;
      this.json(payload, at);
      const type = isObject(payload) ? payload.type : undefined;
      const delta = isObject(payload) ? payload.delta : undefined;
      if (isObject(payload) && typeof type === "string" && type.endsWith(".delta") && typeof delta === "string") {
        const owner = payload.toolCallId ?? payload.id ?? payload.messageId;
        const key = `${type}:${typeof owner === "string" ? owner : "?"}`;
        const stream = streams.get(key) ?? { frames: [], parts: [] };
        stream.frames.push(frame);
        stream.parts.push(delta);
        streams.set(key, stream);
      }
      frame += 1;
      event = "message";
      data = [];
    };
    source.split(/\r?\n/).forEach((line, i) => {
      if (line === "") dispatch();
      else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      else {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        this.text(line, `line ${i + 1}`);
      }
    });
    dispatch();
    for (const [key, { frames, parts }] of streams) {
      const spans: Span[] = [];
      let at = 0;
      for (const part of parts) {
        spans.push({ start: at, end: at + part.length });
        at += part.length;
      }
      this.text(parts.join(""), `deltas[${JSON.stringify(key)}](frames ${frames[0]}..${frames[frames.length - 1]})`, spans);
    }
  }
}

/** Scan one capture's text; `name` picks the reader (`.json`, `.sse.txt`, else plain text). */
function scanCapture(name: string, source: string): ScanResult {
  const scan = new Scan(name);
  if (name.endsWith(".json")) scan.json(JSON.parse(source), "$");
  else if (name.endsWith(".sse.txt")) scan.sse(source);
  else scan.text(source, "<text>");
  return { offenders: scan.offenders, seen: scan.seen };
}

function captureFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

const scanFile = (name: string): ScanResult => scanCapture(name, readFileSync(join(CAPTURES, name), "utf8"));

const describeOffender = (o: Offender): string => `${o.file} ${o.path} (${o.kind}) ${o.value}`;

describe("corpus captures carry synthetic ids, like issue2627", () => {
  it("the synthetic predicates accept the issue2627 shapes and nothing else", () => {
    for (const id of [
      "00000000-0000-4000-8000-100000000001",
      "00000000-0000-4000-8000-200000000001",
      "00000000-0000-4000-8000-300000000001",
      "00000000-0000-4000-8000-400000000001",
      "00000000-0000-4000-8000-500000000002",
    ]) {
      expect(isSyntheticUuid(id), id).toBe(true);
    }
    for (const id of [
      "12345678-1234-4123-8123-123456789abc", // an ordinary v4 uuid
      "00000001-0000-4000-8000-300000000001", // non-zero first group
      "00000000-0000-4000-8000-310000000001", // non-zero inside the zero band
      "00000000-0000-4000-8000-3000000a0001", // hex in the counter
      "00000000-0000-4000-8000-000000000001", // no class digit
      "00000000-0000-0000-0000-000000000001", // no version / variant nibbles
      "00000000-0000-4000-8000-30000000001", //  eleven digits in the last group
    ]) {
      expect(isSyntheticUuid(id), id).toBe(false);
    }
    expect(isSyntheticUserId("g_000000000000000000000000000001")).toBe(true);
    expect(isSyntheticUserId("00000000-0000-4000-8000-500000000001")).toBe(true);
    expect(isSyntheticUserId("g_4f1c0a9e2b7d4c55a1e3f0b9c8d7e6a5")).toBe(false);
    expect(isSyntheticUserId("someone")).toBe(false);
  });

  it("RED control: every non-synthetic id class is reported with file and path, split frames and escaped text included", () => {
    const uuid = "12345678-1234-4123-8123-123456789abc";
    const user = "abcdef01-2345-4678-9abc-def012345678";
    const synthetic = "render_00000000-0000-4000-8000-300000000009";
    const msg = "msg_01AbCdEfGhIjKlMnOpQrStUv";
    const toolu = "toolu_01AbCdEfGhIjKlMnOpQrStUv";
    const sse = [
      "event: session",
      `data: {"sessionId":"s","userId":"${user}","authMode":"authenticated"}`,
      "",
      "event: message",
      `data: {"type":"message.start","id":"${msg}","turnId":"turn_00000000-0000-4000-8000-200000000001"}`,
      "",
      "event: message",
      `data: {"type":"reasoning.opaque","messageId":"msg_000000000000000000000001","kind":"signature","value":"EsICCqgB+/9="}`,
      "",
      "event: message",
      `data: {"type":"tool.done","toolCallId":"${toolu}","content":[{"type":"text","text":"{\\"sessionId\\":\\"render_${uuid}\\",\\"userId\\":\\"g_4f1c0a9e\\"}"}]}`,
      "",
      // One uuid split over three frames, next to a synthetic id that must stay quiet.
      "event: message",
      'data: {"type":"tool.args.delta","toolCallId":"toolu_000000000000000000000001","delta":"{\\"sessionId\\": \\"rend"}',
      "",
      "event: message",
      'data: {"type":"tool.args.delta","toolCallId":"toolu_000000000000000000000001","delta":"er_12345678-1234-41"}',
      "",
      "event: message",
      `data: {"type":"tool.args.delta","toolCallId":"toolu_000000000000000000000001","delta":"23-8123-123456789abc\\", \\"next\\": \\"${synthetic}\\"}"}`,
      "",
      `: keepalive ${uuid}`,
      "",
    ].join("\n");
    const sseScan = scanCapture("control.sse.txt", sse);
    expect(sseScan.offenders.map(describeOffender)).toEqual([
      `control.sse.txt frames[0](session).userId (userId) ${user}`,
      `control.sse.txt frames[0](session).userId (uuid) ${user}`,
      `control.sse.txt frames[1](message).id (message id) ${msg}`,
      "control.sse.txt frames[2](message).value (signature) EsICCqgB+/9=",
      `control.sse.txt frames[3](message).toolCallId (tool call id) ${toolu}`,
      `control.sse.txt frames[3](message).content[0].text (uuid) ${uuid}`,
      "control.sse.txt frames[3](message).content[0].text (text: userId) (userId) g_4f1c0a9e",
      `control.sse.txt line 22 (uuid) ${uuid}`,
      `control.sse.txt deltas["tool.args.delta:toolu_000000000000000000000001"](frames 4..6) (uuid) ${uuid}`,
    ]);
    // The synthetic ids were seen and passed: the turn and the render in the last frame.
    expect(sseScan.seen.uuid).toBe(6);

    const doc = JSON.stringify({
      rows: [
        { user_id: user, text: `see render_${uuid}` },
        { userId: "g_000000000000000000000000000001", [uuid]: true },
      ],
    });
    expect(scanCapture("control.json", doc).offenders.map(describeOffender)).toEqual([
      `control.json $.rows[0].user_id (userId) ${user}`,
      `control.json $.rows[0].user_id (uuid) ${user}`,
      `control.json $.rows[0].text (uuid) ${uuid}`,
      `control.json $.rows[1]["${uuid}"] (key) (uuid) ${uuid}`,
    ]);
  });

  const files = captureFiles(CAPTURES);

  it("there are captures to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s carries only synthetic ids", (name) => {
    expect(scanFile(name).offenders.map(describeOffender)).toEqual([]);
  });

  it("non-vacuity: the walk found ids of every class to check", () => {
    const seen = emptySeen();
    for (const name of files) {
      const result = scanFile(name);
      for (const kind of ID_KINDS) seen[kind] += result.seen[kind];
    }
    for (const kind of ID_KINDS) expect(seen[kind], kind).toBeGreaterThan(0);
  });
});
