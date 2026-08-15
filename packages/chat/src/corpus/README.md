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

## Layers

- `drive.ts` — test-only assembler: events → `TranscriptInputs`, applying
  the hook's documented accumulation rules. The 3b live/history assemblers
  are its production twins.
- `fixtures.ts` — the 17 named fixtures, spec §8 order.
- `corpus.test.ts` — the runner: per-fixture assertions + snapshots, plain
  Node (mirror-CI-safe). The browser render of the SAME corpus is 3b's
  Storybook/screenshot leg.
