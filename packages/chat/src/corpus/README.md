# The fixture corpus

This directory is the executable definition of "comfortably readable" — the
acceptance bar for `@guuey/chat`'s default UI (wave-3a design §8, guuey#135).
Every fixture is a recorded `InvokeTurnEvent[]` sequence driven through the
real `@silverprotocol/core` `Reducer` (`drive.ts`), planned by
`planTranscript`, and pinned by both named assertions and a full plan
snapshot.

## The standing rule

**A new weird transcript found in production becomes a fixture BEFORE its
fix lands. The corpus only grows.** Fixtures are never deleted and never
weakened to make a change pass — a change that breaks a fixture is arguing
with the product definition, and that argument happens in review, not in the
fixture file.

Fixture 17 (`stalled-then-adopted`) is this rule's first production entry:
the guuey#192 widget stall, recorded the day it was diagnosed.

Family 18 (`production-capture-ggui-render`, `capture.ts` +
`capture.test.ts`) is the rule's structural upgrade, from 3b's dogfood
finding 1: the hand-driven corpus was green while the PRODUCTION fold
shape (tool results in `role: "tool"` messages) rendered blank cards. At
least one family is therefore derived from a real redacted production
capture, replayed through the REAL `invokeTurn` with adversarial
chunking — hand-driven sequences can no longer be the corpus's only
witness.

## Layers

- `drive.ts` — test-only assembler: events → `TranscriptInputs`, applying
  the hook's documented accumulation rules. The 3b live/history assemblers
  are its production twins.
- `fixtures.ts` — the named fixtures, spec §8 order: the original 17 plus
  family 19 (`persisted-plus-live` — the turn-scoped fold composition:
  a persisted prefix the session's Reducer never saw + a fold covering
  the trailing turns, with the overlapping-card dedupe case), family 20
  (`hitl-grant-modes` — spec draft.2: the persisted `AgPausedAsk`
  declaration renders asker-labeled mode actions; answers echo and are
  validated by core's `validateHitlAnswer` before anything dispatches;
  dismissal = `cancelled` = re-askable per the silverprotocol#16 ruling),
  and family 21 (`notice-rows` — draft.2's `role:"notice"`: both arrival
  paths, labeled and never agent-voiced, provenance under debug only),
  and family 22 (`promoted-view` — guuey#204 "promote and reference": the
  one mount a host stage shows chips via `promotedViewKey`, every other
  mount stays full, no/stale key is byte-identical to today).
- `capture.ts` / `captures/` — family 18: production-capture replay
  through the real `invokeTurn` (provenance in the module header).
- `corpus.test.ts` — the runner: per-fixture assertions + snapshots, plain
  Node (mirror-CI-safe). The browser render of the SAME corpus is 3b's
  Storybook/screenshot leg.
