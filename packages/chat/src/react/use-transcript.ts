/**
 * The renderer-state owner + the LIVE input assembler (spec §7).
 *
 * `planTranscript` is pure — everything stateful about rendering lives
 * here, in renderer-owned React state:
 *
 *  - `useTranscript` owns the user's collapse overrides, the live
 *    `ViewHostPhase` reports, and locator-mount resolution, merges them
 *    into the inputs, and returns the (memoized) plan;
 *  - `useTranscriptInputs` assembles `TranscriptInputs` from
 *    `useAgentInvoke`'s return — the live twin of the root export's
 *    `transcriptInputsFromHistory`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UseAgentInvokeReturn } from "@guuey/agent-client";
import type { AgHitlAnswer, AgPausedAsk } from "@silverprotocol/core";
import {
  resolveViewMount,
  type ResolvedViewMount,
  type UiResourceReader,
  type ViewCspDiagnosis,
  type ViewHostPhase,
} from "@guuey/mcp-apps-host";
import { buildHitlAnswer, hitlPromptsFromFold, type HitlAnswerRecord, type HitlPromptAction } from "../hitl.js";
import { planTranscript } from "../plan.js";
import type { TranscriptPolicy } from "../policy.js";
import type {
  ChatDebugEvent,
  ItemKey,
  ProfilePromptInput,
  TranscriptInputs,
  TranscriptMessage,
  TranscriptOverrides,
  TranscriptPlan,
} from "../types.js";

// ─── useTranscript ─────────────────────────────────────────────────────────

export interface UseTranscriptArgs {
  inputs: TranscriptInputs;
  policy: TranscriptPolicy;
  /**
   * Resolves R6 `locator` mounts (history cards persisted as `ui://`
   * identities) with a fresh authenticated `resources/read`. Without one,
   * locators render the R13 "view expired" state after a failed local
   * resolution — labeled, never blank.
   */
  reader?: UiResourceReader;
  /**
   * The debug sink (spec §5, real API since the #135 refinement wave):
   * receives {@link ChatDebugEvent}s — view-phase transitions, R15
   * unknown-block sightings, the #192 recovered-turn marker. Fires ONLY
   * under the debug policy (`debugDetail`); `calm` ignores it by design.
   */
  onDebugEvent?: (event: ChatDebugEvent) => void;
}

export interface UseTranscriptResult {
  plan: TranscriptPlan;
  /** Flip one item's collapse state (wired to every toggle's onClick). */
  toggle: (key: ItemKey) => void;
  /** The live collapse-override map (renderer-owned, plan input). */
  overrides: TranscriptOverrides;
  /** Wire to `<GuueyView onPhaseChange>` (the default kit already does). */
  onViewPhase: (key: ItemKey, phase: ViewHostPhase) => void;
  /**
   * Wire to `<GuueyView onCspDiagnosis>` (the default kit already does):
   * the host's CSP tripwire caught the embedding page blocking this view
   * (guuey#235). Feeds `viewDiagnoses` so the R6 label names the cause.
   */
  onViewDiagnosis: (key: ItemKey, diagnosis: ViewCspDiagnosis) => void;
  /** Locator resolutions: mount material, or `"expired"` for a miss. */
  resolvedMounts: ReadonlyMap<ItemKey, ResolvedViewMount | "expired">;
}

export function useTranscript({
  inputs,
  policy,
  reader,
  onDebugEvent,
}: UseTranscriptArgs): UseTranscriptResult {
  const [overrides, setOverrides] = useState<TranscriptOverrides>({});
  const [phases, setPhases] = useState<Readonly<Record<string, ViewHostPhase>>>({});
  const [diagnoses, setDiagnoses] = useState<Readonly<Record<string, ViewCspDiagnosis>>>({});
  const [resolvedMounts, setResolvedMounts] = useState<
    ReadonlyMap<ItemKey, ResolvedViewMount | "expired">
  >(new Map());

  // The debug sink (gated on the debug policy — calm ignores it, spec §5).
  const debugSink = useRef<((event: ChatDebugEvent) => void) | null>(null);
  debugSink.current = policy.debugDetail && onDebugEvent !== undefined ? onDebugEvent : null;

  const merged = useMemo<TranscriptInputs>(
    () => ({
      ...inputs,
      viewPhases: { ...inputs.viewPhases, ...phases },
      viewDiagnoses: { ...inputs.viewDiagnoses, ...diagnoses },
    }),
    [inputs, phases, diagnoses],
  );
  const plan = useMemo(() => planTranscript(merged, policy, overrides), [merged, policy, overrides]);

  // Toggle flips the item's CURRENT resolved state (policy default or a
  // previous override) — read from the plan so the first toggle of a
  // default-expanded item collapses it.
  const planRef = useRef(plan);
  planRef.current = plan;
  const toggle = useCallback((key: ItemKey) => {
    const findExpanded = (): boolean => {
      for (const item of planRef.current.items) {
        if (item.key === key) return item.expanded;
        if (item.kind === "tool-group") {
          for (const tool of item.tools) {
            if (tool.key === key) return tool.expanded;
            if (tool.result?.key === key) return tool.result.expanded;
          }
        }
        if (item.kind === "tool" && item.result?.key === key) return item.result.expanded;
      }
      return false;
    };
    const current = findExpanded();
    setOverrides((prev) => ({ ...prev, [key]: { expanded: !current } }));
  }, []);

  // Mirror of `phases` for the change check OUTSIDE the state updater — a
  // sink call inside an updater would double-fire under StrictMode.
  const phasesRef = useRef<Readonly<Record<string, ViewHostPhase>>>({});
  const diagnosesRef = useRef<Readonly<Record<string, ViewCspDiagnosis>>>({});
  const onViewPhase = useCallback((key: ItemKey, phase: ViewHostPhase) => {
    if (phasesRef.current[key] !== phase) {
      phasesRef.current = { ...phasesRef.current, [key]: phase };
      const diagnosis = diagnosesRef.current[key];
      debugSink.current?.({
        type: "view-phase",
        key,
        phase,
        ...(diagnosis !== undefined ? { diagnosis } : {}),
      });
    }
    setPhases((prev) => (prev[key] === phase ? prev : { ...prev, [key]: phase }));
  }, []);
  // The tripwire fires BEFORE the negotiation window lapses (a blocked
  // runtime never negotiates), so the diagnosis is usually known by the
  // time `no-handshake` arrives — the phase event above carries it. If it
  // lands after, re-emit the current phase with the verdict so a debug
  // sink still sees the pairing.
  const onViewDiagnosis = useCallback((key: ItemKey, diagnosis: ViewCspDiagnosis) => {
    if (diagnosesRef.current[key] === diagnosis) return;
    diagnosesRef.current = { ...diagnosesRef.current, [key]: diagnosis };
    const phase = phasesRef.current[key];
    if (phase !== undefined) debugSink.current?.({ type: "view-phase", key, phase, diagnosis });
    setDiagnoses((prev) => (prev[key] === diagnosis ? prev : { ...prev, [key]: diagnosis }));
  }, []);

  // Plan-derived debug events, emitted once per sighting (post-render — the
  // plan itself stays pure data).
  const emittedUnknowns = useRef(new Set<ItemKey>());
  const recoveryEmitted = useRef(false);
  useEffect(() => {
    const sink = debugSink.current;
    if (sink === null) return;
    for (const item of plan.items) {
      if (item.kind !== "unknown" || emittedUnknowns.current.has(item.key)) continue;
      emittedUnknowns.current.add(item.key);
      sink({ type: "unknown-block", key: item.key, typeName: item.typeName, byteSize: item.byteSize });
    }
    if (plan.recovery !== null && !recoveryEmitted.current) {
      recoveryEmitted.current = true;
      sink({ type: "turn-recovered", marker: plan.recovery });
    } else if (plan.recovery === null) {
      recoveryEmitted.current = false;
    }
  }, [plan]);

  // Locator resolution — one read per locator key, misses become "expired".
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const inFlight = useRef(new Set<ItemKey>());
  useEffect(() => {
    for (const item of plan.items) {
      if (item.kind !== "view") continue;
      if (item.mount === null || item.mount.channel !== "locator") continue;
      if (resolvedMounts.has(item.key) || inFlight.current.has(item.key)) continue;
      const read = readerRef.current;
      const locator = item.mount;
      inFlight.current.add(item.key);
      const settle = (value: ResolvedViewMount | "expired"): void => {
        inFlight.current.delete(item.key);
        // The R13 expired verdict is a phase transition too (debug sink).
        if (value === "expired") {
          debugSink.current?.({ type: "view-phase", key: item.key, phase: "expired" });
        }
        setResolvedMounts((prev) => {
          const next = new Map(prev);
          next.set(item.key, value);
          return next;
        });
      };
      if (read === undefined) {
        settle("expired");
        continue;
      }
      void resolveViewMount(locator, read).then(
        (resolved) => settle(resolved ?? "expired"),
        () => settle("expired"),
      );
    }
  }, [plan, resolvedMounts]);

  return { plan, toggle, overrides, onViewPhase, onViewDiagnosis, resolvedMounts };
}

// ─── useTranscriptInputs (the live assembler) ──────────────────────────────

export interface UseTranscriptInputsResult {
  inputs: TranscriptInputs;
  /**
   * Record the user's action on an R10 prompt (the host performs the
   * actual grant/decline through its own channel; this moves the
   * transcript record). A pending prompt whose hook-side request vanishes
   * without a recorded action reads as `dismissed`.
   */
  resolvePrompt: (id: string, state: "answered" | "declined" | "dismissed") => void;
  /**
   * Answer an AgJSON HITL ask (spec draft.2): constructs the wire answer,
   * VALIDATES it against the ask's persisted record (`validateHitlAnswer`
   * — required-iff-declared, echo-must-be-declared, requestState byte-echo)
   * BEFORE anything dispatches, records it in the ledger, and returns it
   * for the HOST to deliver — the kit renders and validates; the answer
   * transport is the host's (no client→pod hitl-answer channel exists on
   * the guuey wire today; see the #16 producer flag).
   */
  answerHitlPrompt: (ask: AgPausedAsk, action: HitlPromptAction) => AgHitlAnswer;
}

/** How often the escalation clock ticks while a status needs one. */
const ELAPSED_TICK_MS = 500;

export function useTranscriptInputs(invoke: UseAgentInvokeReturn): UseTranscriptInputsResult {
  // §4: the elapsed clock is a view-model INPUT — this is the renderer-side
  // timer that feeds it. Reset on every status change; ticking only while a
  // status line is showing (R12 escalation + debug detail).
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    setElapsedMs(0);
    if (invoke.status === "ready" || invoke.status === "responding") return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [invoke.status]);

  // R10 ledger: the hook exposes only the LATEST pending ask; the
  // transcript keeps the record of every ask and its resolution.
  const [prompts, setPrompts] = useState<ProfilePromptInput[]>([]);
  const promptSeq = useRef(0);
  useEffect(() => {
    const request = invoke.profileConsentRequest;
    if (request === null) {
      setPrompts((prev) =>
        prev.some((p) => p.kind === "consent" && p.state === "pending")
          ? prev.map((p) =>
              p.kind === "consent" && p.state === "pending" ? { ...p, state: "dismissed" } : p,
            )
          : prev,
      );
      return;
    }
    setPrompts((prev) => {
      if (prev.some((p) => p.kind === "consent" && p.state === "pending")) return prev;
      return [
        ...prev,
        {
          id: `consent.${promptSeq.current++}`,
          kind: "consent",
          appId: request.appId,
          requested: request.requested,
          state: "pending",
        },
      ];
    });
  }, [invoke.profileConsentRequest]);
  useEffect(() => {
    const request = invoke.profileLinkRequest;
    if (request === null) {
      setPrompts((prev) =>
        prev.some((p) => p.kind === "link" && p.state === "pending")
          ? prev.map((p) =>
              p.kind === "link" && p.state === "pending" ? { ...p, state: "dismissed" } : p,
            )
          : prev,
      );
      return;
    }
    setPrompts((prev) => {
      if (prev.some((p) => p.kind === "link" && p.state === "pending")) return prev;
      return [
        ...prev,
        {
          id: `link.${promptSeq.current++}`,
          kind: "link",
          appId: request.appId,
          requested: request.requested,
          state: "pending",
        },
      ];
    });
  }, [invoke.profileLinkRequest]);

  const resolvePrompt = useCallback(
    (id: string, state: "answered" | "declined" | "dismissed") => {
      setPrompts((prev) => prev.map((p) => (p.id === id ? { ...p, state } : p)));
      // Clearing the hook's pending request AFTER the ledger moved keeps the
      // dismissal effect above from double-transitioning it.
      const pending = prompts.find((p) => p.id === id);
      if (pending?.kind === "consent") invoke.clearProfileConsentRequest();
      if (pending?.kind === "link") invoke.clearProfileLinkRequest();
    },
    [invoke, prompts],
  );

  // HITL ledger (spec draft.2): asks come from the FOLD's persisted
  // records; this ledger holds only the host-side answers, keyed by askId.
  // A `cancelled` record keeps the card re-askable (guuey's #16 ruling) —
  // a later action on the same ask simply overwrites it.
  const [hitlAnswers, setHitlAnswers] = useState<Readonly<Record<string, HitlAnswerRecord>>>({});
  const answerHitlPrompt = useCallback((ask: AgPausedAsk, action: HitlPromptAction): AgHitlAnswer => {
    const answer = buildHitlAnswer(ask, action);
    setHitlAnswers((prev) => ({
      ...prev,
      [ask.askId]: {
        status: answer.status,
        ...(answer.grantModeId !== undefined ? { grantModeId: answer.grantModeId } : {}),
      },
    }));
    return answer;
  }, []);

  const inputs = useMemo<TranscriptInputs>(() => {
    // Source-ownership split (plan.ts's rules): the trailing assistant
    // entry is the IN-FLIGHT fold (or the abort-kept partial) — it moves to
    // `assistantText` so the plan can mark it streaming/stopped; settled
    // turns stay in `messages`.
    const inFlight = invoke.status !== "ready";
    let messages: TranscriptMessage[] = invoke.messages;
    let assistantText = "";
    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === "assistant" && (inFlight || invoke.aborted)) {
      assistantText = last.text;
      messages = messages.slice(0, -1);
    }
    return {
      result: invoke.reduceResult,
      assistantText,
      status: invoke.status,
      statusElapsedMs: elapsedMs,
      activeTool: invoke.activeTool,
      error: invoke.error !== null ? { message: invoke.error, code: invoke.errorCode } : null,
      prompts: [...prompts, ...hitlPromptsFromFold(invoke.reduceResult, hitlAnswers)],
      messages,
      ...(invoke.historyCards.length > 0 ? { historyCards: invoke.historyCards } : {}),
      sendStates: invoke.sendStates,
      aborted: invoke.aborted,
      adopted: invoke.adopted,
    };
  }, [
    invoke.messages,
    invoke.status,
    invoke.activeTool,
    invoke.error,
    invoke.errorCode,
    invoke.reduceResult,
    invoke.historyCards,
    invoke.sendStates,
    invoke.aborted,
    invoke.adopted,
    elapsedMs,
    prompts,
    hitlAnswers,
  ]);

  return { inputs, resolvePrompt, answerHitlPrompt };
}
