// @vitest-environment jsdom
/**
 * guuey#2604 — `<GuueyChat>` at the agent's concurrent-turn ceiling. The
 * default adapters retry a `POD_SATURATED` refusal; while they wait, the
 * status line says the agent is busy and which retry it is on (never the
 * connecting ladder's "Still getting ready…"). When the retries run out the
 * refused send is ONE state: its failed bubble reads the plain busy line with
 * Retry, never the pod's envelope with its turn cap, and no separate error box
 * is drawn. Builder overrides (`strings`, `policy.error.copyByCode`,
 * `components`) still win.
 */
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AGENT_ERROR_CODES } from "@guuey/agent-client";
import { GuueyChat, type GuueyChatProps } from "./guuey-chat.js";
import type { TranscriptComponents } from "./components.js";
import { defaultChatStrings } from "../strings.js";
import type { StatusLineItem } from "../types.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ENDPOINT = "https://pod.example/agent/invoke";
const POD_SENTENCE = "this conversation's agent is at capacity (2 concurrent turns); retry in 15s";
const BUSY_LINE = "High demand right now. Please try again in a moment.";

/** The governor's refusal; `Retry-After: 0` keeps the test's waits at zero. */
function saturated(retryAfterSeconds = 0): Response {
  return new Response(JSON.stringify({ code: AGENT_ERROR_CODES.POD_SATURATED, message: POD_SENTENCE }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) },
  });
}

function streamed(): Response {
  return new Response(
    'event: session\ndata: {"threadId":"t-1"}\n\nevent: done\ndata: {"stopReason":"end"}\n\n',
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/**
 * Invoke calls answer from `script` in order; the first `"hold"` parks that
 * call until `release()` answers it with a streamed reply.
 */
function stubInvoke(script: readonly ("saturated" | "saturated-12s" | "hold")[]) {
  let calls = 0;
  let release: () => void = () => {
    throw new Error("no held call yet");
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (): Promise<Response> => {
      const step = script[calls] ?? "saturated";
      calls += 1;
      if (step === "saturated") return saturated();
      if (step === "saturated-12s") return saturated(12);
      return new Promise<Response>((resolve) => {
        release = () => resolve(streamed());
      });
    }),
  );
  return { calls: () => calls, release: () => release() };
}

/** The failed bubble's state line (R0), the one place a refused send speaks. */
function failedLine(): string | null {
  return document.querySelector(".guuey-chat-send-failed")?.textContent ?? null;
}

function send(props: Partial<GuueyChatProps> = {}): void {
  render(<GuueyChat endpointUrl={ENDPOINT} {...props} />);
  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: "hello" } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("the busy notice while the saturation retry waits", () => {
  it("shows 'Busy right now. Retrying (n/4)…' during the retries and clears when the turn gets through", async () => {
    const invoke = stubInvoke(["saturated", "saturated", "hold"]);
    send();

    await waitFor(() => expect(invoke.calls()).toBe(3));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Busy right now. Retrying (2/4)…"));
    expect(screen.getByRole("status").className).toContain("guuey-chat-status-busy");
    expect(screen.queryByText(/Still getting ready|at capacity/)).toBeNull();

    invoke.release();
    await waitFor(() => expect(screen.queryByText(/Busy right now/)).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the first refusal reads (1/4): attempt n of the default budget of four sends", async () => {
    const invoke = stubInvoke(["saturated", "hold"]);
    send();
    await waitFor(() => expect(invoke.calls()).toBe(2));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Busy right now. Retrying (1/4)…"));
    invoke.release();
    await waitFor(() => expect(screen.queryByText(/Busy right now/)).toBeNull());
  });

  it("counts down to the next try from the pod's Retry-After (guuey#2608)", async () => {
    const invoke = stubInvoke(["saturated-12s"]);
    send();
    await waitFor(() => expect(invoke.calls()).toBe(1));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/^Busy right now\. Retrying in 1[12]s \(1\/4\)…$/),
    );
  });

  it("a builder's strings.saturationRetrying wins", async () => {
    const invoke = stubInvoke(["saturated", "hold"]);
    send({ strings: { saturationRetrying: (n, total) => `Occupé (${n}/${total})` } });
    await waitFor(() => expect(invoke.calls()).toBe(2));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Occupé (1/4)"));
    invoke.release();
    await waitFor(() => expect(screen.queryByText(/Occupé/)).toBeNull());
  });

  it("a builder's status component wins and receives the busy item", async () => {
    const invoke = stubInvoke(["saturated", "hold"]);
    const seen: StatusLineItem[] = [];
    function MyStatus({ item }: ComponentProps<TranscriptComponents["status"]>): ReactNode {
      seen.push(item);
      return <p data-testid="my-status">{item.state}</p>;
    }
    send({ components: { status: MyStatus } });
    await waitFor(() => expect(invoke.calls()).toBe(2));
    await waitFor(() => expect(screen.getByTestId("my-status").textContent).toBe("busy"));
    expect(seen.some((i) => i.state === "busy" && i.copy === "Busy right now. Retrying (1/4)…")).toBe(true);
    invoke.release();
    await waitFor(() => expect(screen.queryByTestId("my-status")).toBeNull());
  });
});

describe("the busy error once the retries run out", () => {
  it("the failed bubble reads the plain busy line with Retry, never the pod's envelope; no error box, no notice", async () => {
    const invoke = stubInvoke([]);
    send();
    await waitFor(() => expect(failedLine()).toContain(BUSY_LINE));
    expect(invoke.calls()).toBe(4);
    expect(defaultChatStrings.errorPodSaturated).toBe(BUSY_LINE);
    expect(screen.getByRole("button", { name: defaultChatStrings.userRetry })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(defaultChatStrings.userCouldntSend)).toBeNull();
    expect(screen.queryByText(/at capacity|concurrent turns/)).toBeNull();
    expect(screen.queryByText(/Busy right now/)).toBeNull();
  });

  it("a wait left over from the spent retries never shows on the next turn", async () => {
    const invoke = stubInvoke(["saturated", "saturated", "saturated", "saturated", "hold"]);
    send();
    await waitFor(() => expect(failedLine()).toContain(BUSY_LINE));
    expect(invoke.calls()).toBe(4);

    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "again" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(invoke.calls()).toBe(5));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByText(/Busy right now/)).toBeNull();

    invoke.release();
    await waitFor(() => expect(screen.queryByText(/Busy right now/)).toBeNull());
  });

  it("a builder's policy.error.copyByCode wins", async () => {
    stubInvoke([]);
    send({ policy: { error: { copyByCode: { POD_SATURATED: "Our helper is busy." } } } });
    await waitFor(() => expect(failedLine()).toContain("Our helper is busy."));
    expect(screen.queryByText(BUSY_LINE)).toBeNull();
  });

  it("a builder's strings.errorPodSaturated wins", async () => {
    stubInvoke([]);
    send({ strings: { errorPodSaturated: "Too busy, try soon." } });
    await waitFor(() => expect(failedLine()).toContain("Too busy, try soon."));
  });
});

/**
 * guuey#2608 — Retry on the refused send's bubble re-sends in its place: the
 * turn is drawn once, never beside its old failed bubble (the inline
 * transcript layout of the widget mounts this component).
 */
describe("Retry on a refused send", () => {
  function userBubbles(): number {
    return document.querySelectorAll(".guuey-chat-user").length;
  }

  it("a retry that gets through leaves one bubble and no failed line", async () => {
    const invoke = stubInvoke(["saturated", "saturated", "saturated", "saturated", "hold"]);
    send();
    await waitFor(() => expect(failedLine()).toContain(BUSY_LINE));
    expect(userBubbles()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: defaultChatStrings.userRetry }));
    await waitFor(() => expect(invoke.calls()).toBe(5));
    await waitFor(() => expect(failedLine()).toBeNull());
    expect(userBubbles()).toBe(1);
    expect(screen.getAllByText("hello")).toHaveLength(1);

    invoke.release();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(userBubbles()).toBe(1);
    expect(failedLine()).toBeNull();
  });

  it("a retry refused again leaves one failed bubble with one Retry", async () => {
    const invoke = stubInvoke([]);
    send();
    await waitFor(() => expect(failedLine()).toContain(BUSY_LINE));

    fireEvent.click(screen.getByRole("button", { name: defaultChatStrings.userRetry }));
    await waitFor(() => expect(invoke.calls()).toBe(8));
    await waitFor(() => expect(failedLine()).toContain(BUSY_LINE));
    expect(userBubbles()).toBe(1);
    expect(document.querySelectorAll(".guuey-chat-send-failed")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: defaultChatStrings.userRetry })).toHaveLength(1);
  });
});
