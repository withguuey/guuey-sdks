/**
 * Thread resume (guuey#3407 B3): what a stored Claude CLI session holds, measured by the host BEFORE it starts the CLI
 * on a `resume`, and reported in the hello (`HelloStoredMeasures`, wire v1.2). The host measures; the Router decides.
 * Nothing here judges a file: it reports what it found, and the Router compares it with its own record.
 *
 * Read without following links: the session file must be a regular file, and the session directory's tree is listed
 * entry by entry, a link reported as a link and never entered. Every hash is `cli-session-hash.ts`'s.
 *
 * The file's shape is the pinned CLI's (2.1.282, measured by R7h and its compaction read). It is pinned here, beside the
 * parser, and re-measured at every CLI bump:
 * - {@link CLI_SESSION_LINE_TYPES} are the line types the CLI writes; `system` only as a `compact_boundary`;
 * - a compaction re-writes the compacting turn's prompt entry and the attachment after it with the same uuid, adding
 *   only `slug` (a benign duplicate); roots the summary branch at a `compact_boundary` whose `logicalParentUuid` is the
 *   pre-compaction leaf; and writes that turn's `last-prompt` line a second time.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HelloStoredMeasures, HelloWalk, JsonValue } from "@guuey/worker";
import { hashSystemPrompt, hashUserBlocks, hashUserText, parseStoredUserContent } from "./cli-session-hash.js";

/** The line types the pinned CLI writes in a session file. Any other is unclassified. */
export const CLI_SESSION_LINE_TYPES: ReadonlySet<string> = new Set([
  "queue-operation",
  "user",
  "attachment",
  "atis-latch",
  "assistant",
  "last-prompt",
  "cost-state",
  "mode",
  "system",
]);

/** The one `system` subtype the pinned CLI writes: the root of a compaction's summary branch. */
const COMPACT_BOUNDARY = "compact_boundary";

/** The one key a benign duplicate may add (the compaction's re-write). */
const DUPLICATE_ADDED_KEY = "slug";

type Line = { readonly [key: string]: JsonValue };

function isLine(v: JsonValue): v is Line {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The relative paths under `dir`, without following links; a link is listed as `<path>@link` and not entered. */
export function listTreeNoFollow(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        out.push(`${childRel}@link`);
      } else {
        out.push(childRel);
        if (st.isDirectory()) walk(childAbs, childRel);
      }
    }
  };
  walk(dir, "");
  return out;
}

/** What a path is, without following a link. */
function readNoFollowKind(path: string): "dir" | "absent" | "link" | "not-regular" {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return "link";
    return st.isDirectory() ? "dir" : "not-regular";
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return "absent";
    throw err;
  }
}

/** Read a file's text without following a link; `readError` says why when it is not a regular file. */
function readNoFollow(path: string): { text: string } | { readError: "missing" | "not-regular" | "link" } {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return { readError: "missing" };
    throw err;
  }
  if (st.isSymbolicLink()) return { readError: "link" };
  if (!st.isFile()) return { readError: "not-regular" };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) return { readError: "not-regular" };
    return { text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

/** Whether a user entry carries a tool result (the CLI's own; never a prompt). */
function isToolResult(line: Line): boolean {
  const message = line.message;
  return isLine(message) && Array.isArray(message.content) && message.content.some((b) => isLine(b) && b.type === "tool_result");
}

/** A user entry's `message.content` hash, or `null` when its blocks are not hashable. */
function userContentHash(line: Line): string | null {
  const message = line.message;
  if (!isLine(message)) return null;
  const blocks = parseStoredUserContent(message.content);
  return blocks === null ? null : hashUserBlocks(blocks);
}

/**
 * Whether a repeated entry is the CLI's own re-write of its first occurrence: every key equal except an added `slug`,
 * the `message` compared by content hash (so the CLI's re-serialization is not a difference) and every other key as
 * JSON.
 */
function isBenignDuplicate(first: Line, again: Line): boolean {
  const keys = new Set([...Object.keys(first), ...Object.keys(again)]);
  keys.delete(DUPLICATE_ADDED_KEY);
  if (DUPLICATE_ADDED_KEY in first && JSON.stringify(first[DUPLICATE_ADDED_KEY]) !== JSON.stringify(again[DUPLICATE_ADDED_KEY])) return false;
  for (const key of keys) {
    if (!(key in first) || !(key in again)) return false;
    if (key === "message" && isLine(first.message) && isLine(again.message)) {
      const a = first.message;
      const b = again.message;
      const hash = userContentHash(first);
      const sameContent = hash !== null ? hash === userContentHash(again) : JSON.stringify(a.content) === JSON.stringify(b.content);
      if (!sameContent) return false;
      const rest = new Set([...Object.keys(a), ...Object.keys(b)]);
      rest.delete("content");
      for (const k of rest) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
      continue;
    }
    if (JSON.stringify(first[key]) !== JSON.stringify(again[key])) return false;
  }
  return true;
}

type Kind = "prompt" | "tool_result" | "compact-summary" | "other";

/**
 * Measure the stored session `<sessionDir>/<id>.jsonl` and the tree of `sessionDir` (the bound thread directory).
 * Throws only on an I/O failure other than the file being absent, a link or not regular.
 */
export function measureStoredSession(sessionDir: string, id: string): HelloStoredMeasures {
  const unreadable = (readError: "missing" | "not-regular" | "link", entries: string[]): HelloStoredMeasures => ({
    readError,
    systemPromptShas: [],
    walks: [],
    lastPromptShas: [],
    entries,
    unclassified: 0,
    corrupt: 0,
    benignDuplicates: 0,
    filePromptEntries: 0,
    fileCompactSummaries: 0,
  });
  // The session directory itself first: absent (nothing was ever bound or written), a link, or not a directory reads
  // as the file's own state, with no tree listed.
  const dir = readNoFollowKind(sessionDir);
  if (dir !== "dir") return unreadable(dir === "absent" ? "missing" : dir, []);
  const entries = listTreeNoFollow(sessionDir);
  const read = readNoFollow(join(sessionDir, `${id}.jsonl`));
  if ("readError" in read) return unreadable(read.readError, entries);

  // `unclassified`: well-formed content the host cannot vouch for (an edit). `corrupt`: damage — a line that does not
  // parse, a parent that names no entry, a loop (wire v1.3). Both reset; the Router names the event's class from them.
  let unclassified = 0;
  let corrupt = 0;
  let benignDuplicates = 0;
  const systemPromptShas: string[] = [];
  const lastPromptShas: string[] = [];
  let lastPromptLeaf: string | null = null;
  const byUuid = new Map<string, { line: Line; kind: Kind; sha: string | null }>();
  const boundaries: string[] = [];

  for (const raw of read.text.split("\n")) {
    if (raw === "") continue;
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(raw) as JsonValue;
    } catch {
      corrupt += 1;
      continue;
    }
    if (!isLine(parsed) || typeof parsed.type !== "string" || !CLI_SESSION_LINE_TYPES.has(parsed.type)) {
      unclassified += 1;
      continue;
    }
    const line = parsed;
    if (line.type === "system" && line.subtype !== COMPACT_BOUNDARY) {
      unclassified += 1;
      continue;
    }
    const uuid = typeof line.uuid === "string" ? line.uuid : null;
    if (uuid !== null) {
      const first = byUuid.get(uuid);
      if (first !== undefined) {
        if (isBenignDuplicate(first.line, line)) benignDuplicates += 1;
        else unclassified += 1;
        continue;
      }
    }

    let kind: Kind = "other";
    let sha: string | null = null;
    if (line.type === "user") {
      if (isToolResult(line)) kind = "tool_result";
      else if (line.isCompactSummary === true) kind = "compact-summary";
      else {
        sha = userContentHash(line);
        if (sha === null) unclassified += 1;
        else kind = "prompt";
      }
    } else if (line.type === "attachment" && isLine(line.attachment) && line.attachment.systemPrompt !== undefined) {
      const prompts = line.attachment.systemPrompt;
      if (Array.isArray(prompts) && prompts.length === 1 && typeof prompts[0] === "string") {
        systemPromptShas.push(hashSystemPrompt(prompts[0]));
      } else {
        unclassified += 1;
      }
    } else if (line.type === "last-prompt") {
      if (typeof line.lastPrompt === "string") {
        lastPromptShas.push(hashUserText(line.lastPrompt));
        lastPromptLeaf = typeof line.leafUuid === "string" ? line.leafUuid : null;
      } else {
        unclassified += 1;
      }
    } else if (line.type === "system" && uuid !== null) {
      boundaries.push(uuid);
    }
    if (uuid !== null) byUuid.set(uuid, { line, kind, sha });
  }

  // The graph: every entry with a uuid; a parent that names no entry is a broken chain.
  const parents = new Set<string>();
  for (const { line } of byUuid.values()) if (typeof line.parentUuid === "string") parents.add(line.parentUuid);
  const leaves = [...byUuid.keys()].filter((u) => !parents.has(u));
  const walks: HelloWalk[] = [];
  const roots = new Set<string>();
  const paths: { leaf: string; path: string[] }[] = [];
  for (const leaf of leaves) {
    const path: string[] = [];
    const seen = new Set<string>();
    let at: string | null = leaf;
    let broken = false;
    while (at !== null) {
      if (seen.has(at)) {
        broken = true;
        break;
      }
      seen.add(at);
      const node = byUuid.get(at);
      if (node === undefined) {
        broken = true;
        break;
      }
      path.unshift(at);
      at = typeof node.line.parentUuid === "string" ? node.line.parentUuid : null;
    }
    if (broken) corrupt += 1;
    roots.add(path[0]);
    paths.push({ leaf, path });
  }
  for (const { leaf, path } of paths) {
    const root = byUuid.get(path[0]);
    let boundary: HelloWalk["boundary"] = "none";
    if (root !== undefined && root.line.type === "system") {
      const target = root.line.logicalParentUuid;
      boundary = typeof target === "string" && target !== leaf && leaves.includes(target) ? "links-other-leaf" : "dangling";
    }
    const nodes = path.map((u) => byUuid.get(u));
    walks.push({
      fromLastPromptLeaf: leaf === lastPromptLeaf,
      promptShas: nodes.flatMap((n) => (n !== undefined && n.kind === "prompt" && n.sha !== null ? [n.sha] : [])),
      compactSummaries: nodes.filter((n) => n !== undefined && n.kind === "compact-summary").length,
      boundary,
    });
  }
  // A compaction boundary only ever roots a walk, and there is at most one.
  for (const b of boundaries) if (!roots.has(b)) unclassified += 1;
  if (boundaries.length > 1) unclassified += boundaries.length - 1;
  // Every entry lies on some walk. One that no walk reaches sits on a loop (A→B→A, or its own parent: no entry of
  // the loop is a leaf, so no walk starts there) or hangs off one; the walks above stop at a revisited uuid, so a
  // forged loop can neither hang nor grow them (runtime's C-1 on wire v1.2).
  const onWalks = new Set(paths.flatMap((p) => p.path));
  if ([...byUuid.keys()].some((u) => !onWalks.has(u))) corrupt += 1;

  const kinds = [...byUuid.values()];
  return {
    systemPromptShas,
    walks,
    lastPromptShas,
    entries,
    unclassified,
    corrupt,
    benignDuplicates,
    filePromptEntries: kinds.filter((n) => n.kind === "prompt").length,
    fileCompactSummaries: kinds.filter((n) => n.kind === "compact-summary").length,
  };
}
