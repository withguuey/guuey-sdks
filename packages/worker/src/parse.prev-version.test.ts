/**
 * N−1 across a rolling release: an OLDER worker (its parser frozen in
 * `fixtures/parse-control.prev.ts`) reads a NEWER Router's invoke, and the
 * current parser reads an older Router's invoke. Neither throws, and neither
 * side sees a pause field the other did not send.
 */
import { describe, it, expect } from "vitest";
import { parseControl } from "./parse.js";
import { parseControl as parseControlPrev } from "./fixtures/parse-control.prev.js";

const OLD_INVOKE = {
  type: "invoke",
  input: "Approved: send_email",
  identity: { userId: "u1", authMode: "authenticated" },
  fs: { app: "/app", home: "/home", session: "/session" },
  fsBound: true,
  history: [{ role: "user", text: "send it" }],
  gguiAttached: true,
};
const NEW_INVOKE = {
  ...OLD_INVOKE,
  suspend: { maxEnvelopeBytes: 2 * 1024 * 1024 },
  resume: {
    envelope: '{"state":"opaque"}',
    answers: [{ askId: "approval_call_1", toolCallId: "call_1", status: "resolved" }],
    pausedUserSeq: 3,
  },
};

describe("the previous worker's parseControl (frozen) × a new Router's invoke", () => {
  it("reads the new invoke and drops both new fields: the same turn as without them", () => {
    const fromNew = parseControlPrev(JSON.stringify(NEW_INVOKE));
    const fromOld = parseControlPrev(JSON.stringify(OLD_INVOKE));
    expect(fromNew).toEqual(fromOld);
    expect("suspend" in fromNew).toBe(false);
    expect("resume" in fromNew).toBe(false);
  });

  it("still reads a malformed new field without throwing", () => {
    const odd = { ...OLD_INVOKE, suspend: "yes", resume: { envelope: 1 } };
    expect(parseControlPrev(JSON.stringify(odd))).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
  });
});

describe("the current parseControl × an old Router's invoke", () => {
  it("reads it as the previous parser does, with no pause field", () => {
    const now = parseControl(JSON.stringify(OLD_INVOKE));
    expect(now).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
    expect("suspend" in now).toBe(false);
    expect("resume" in now).toBe(false);
  });

  it("differs from the previous parser on the new invoke ONLY by the two new fields", () => {
    const now = parseControl(JSON.stringify(NEW_INVOKE));
    const prev = parseControlPrev(JSON.stringify(NEW_INVOKE));
    expect(now).toEqual({ ...prev, suspend: NEW_INVOKE.suspend, resume: NEW_INVOKE.resume });
  });
});

/**
 * guuey#2549 — `inputKind` on the invoke and on a history entry. A Router sends it only to a worker
 * whose hello declared the kind, so an older worker never receives it in practice; the frozen
 * parser must still read such an invoke without throwing, and the current parser must read an older
 * Router's invoke exactly as before.
 */
const KIND_INVOKE = {
  ...OLD_INVOKE,
  input: "",
  inputKind: "context-only",
  history: [{ role: "user", text: "", inputKind: "context-only" }, { role: "agent", text: "A nice photo." }],
};

describe("inputKind across a rolling release (guuey#2549)", () => {
  it("the previous parser reads a kind invoke without throwing and sees no kind, on the invoke or in history", () => {
    const prev = parseControlPrev(JSON.stringify(KIND_INVOKE));
    expect("inputKind" in prev).toBe(false);
    expect(prev.type === "invoke" ? prev.history : []).toEqual([
      { role: "user", text: "" },
      { role: "agent", text: "A nice photo." },
    ]);
  });

  it("the current parser reads an older Router's invoke exactly as the previous one does: no kind anywhere", () => {
    const now = parseControl(JSON.stringify(OLD_INVOKE));
    expect(now).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
    expect("inputKind" in now).toBe(false);
  });

  it("the current parser keeps a known kind on the invoke and on the history entry, and only there", () => {
    const now = parseControl(JSON.stringify(KIND_INVOKE));
    const prev = parseControlPrev(JSON.stringify(KIND_INVOKE));
    expect(now).toEqual({
      ...prev,
      inputKind: "context-only",
      history: [{ role: "user", text: "", inputKind: "context-only" }, { role: "agent", text: "A nice photo." }],
    });
  });

  it("an unknown kind reads as none on both, never a throw", () => {
    const odd = { ...KIND_INVOKE, inputKind: "telepathy", history: [{ role: "user", text: "", inputKind: 7 }] };
    const now = parseControl(JSON.stringify(odd));
    expect("inputKind" in now).toBe(false);
    expect(now.type === "invoke" ? now.history : []).toEqual([{ role: "user", text: "" }]);
  });
});
