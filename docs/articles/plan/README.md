# Mailwoman Neural — Implementation Plan

The plan that drove the neural address parser work inside Mailwoman: TypeScript-first, deployed as a new classifier that progressively replaces rule-based classifiers as confidence metrics justify (Ship of Theseus).

**Status (last edited 2026-05-22):** Phases 0 through 3 shipped; Stage 2 label expansion landed in v3.0.0; Phase 4 Resolver subphases through 4.3.x shipped.

- `@mailwoman/neural` published to npm (v2.x runtime).
- `@mailwoman/neural-weights-{en-us,fr-fr}` at **v3.0.0** — Stage 2 vocabulary (21 BIO classes: O + 7 coarse × {B-,I-} + 3 fine × {B-,I-} for `venue` / `street` / `house_number`). Trained on `corpus-v0.3.0` (677M aligned rows; adds US DOT NAD as 57.9M structured 911-grade address points). Includes a linear-chain CRF decoder over a frozen BIO transition mask so orphan-`I-*` sequences (Saint Petersburg → Petersburg) are structurally impossible. Eval against golden v0.1.2 (4,535 entries): macro F1 0.32, `house_number` F1 0.78, `venue` F1 0.39, `street` F1 0.27, `postcode` F1 0.76, `region` F1 0.18, `locality` F1 0.27. Coarse F1 regressed vs v0.2.0's small-slice eval; v0.4.0 follow-up targets it (see PHASE_2_training.md iteration log).
- `mailwoman parse --neural --format json|tuple|xml` works end-to-end against the v3.0.0 weights.
- Decoder + tokenizer + ONNX runtime + per-component policy registry all live; `neural/labels.ts` knows the 21-label vocabulary.
- Phase 4 Resolver: WOF SQLite path shipped through 4.3.x (FTS5 prefix, R\*Tree proximity, population-weighted ranking, multi-shard ATTACH). Browser-side path lives in `@mailwoman/neural-web` + `@mailwoman/resolver-wof-wasm` (the demo at https://mailwoman.sister.software/demo runs both client-side).

What's described below as "next" or "future" should be read as the historical plan; the actual state is whatever this directory's most-recently-committed phase file says, plus `LOG.md` at the repo root for the live cadence.

## Read order

1. This file
2. `reference/CONTEXT.md` — background, prior art, design rationale
3. `reference/ARCHITECTURE.md` — system shape, key abstractions, locale strategy
4. `reference/SCHEMA.md` — canonical component tag union (single source of truth)
5. `reference/INTERFACES.md` — TypeScript contracts at every boundary
6. `reference/OPERATIONS.md` — how to work, how to commit, how to report progress
7. `phases/PHASE_0_foundation.md` — start here once you have read 1–6

Subsequent phases (`phases/PHASE_1_*` through `phases/PHASE_6_*`) are sequential. Do not begin a phase until the previous phase's success criteria are met.

## Hard constraints

- **TypeScript-first.** Inference runtime is `onnxruntime-node`. Training is allowed in Python but is not shipped to npm.
- **Coexistence, not replacement.** The neural classifier is additive. Rule classifiers are not deleted until per-component metrics justify retirement.
- **Locale scope (v1):** US + France. English + French. Japanese is a deliberate Phase 6 stress test of the architecture, not v1.
- **Staged components:** coarse (country/region/locality/postcode) first, street second, venue third. Each stage ships.
- **No new ML in places where rules are already correct.** Postcodes are a regex problem. Don't burn a model on them.
- **Schema-first.** Touching `reference/SCHEMA.md` requires a written rationale in the commit. Downstream code keys off it.

## What good looks like

By end of Phase 3 you will have shipped `@mailwoman/neural@0.1.0` to npm. It loads a quantized ONNX model on demand, emits `ClassificationProposal` objects that flow through Mailwoman's existing solver unchanged, and beats rule-based Mailwoman on the held-out golden set for at least the `country` and `region` components.

By end of Phase 6 the same architecture supports Japanese addresses with schema additions but no core refactor. That is the validation that the design is sound.

## What failure looks like

- Schema churn after Phase 1 — means Phase 0 was rushed.
- Tokenizer drift between Python training and TypeScript inference — silent accuracy loss in prod.
- Training data leakage (same locality in train and eval splits) — model looks great in eval, fails in the wild.
- Coupling the model to a specific Mailwoman internal type, then needing to refactor to ship the model standalone later.

Any of these means stop and re-read `reference/ARCHITECTURE.md`.

## How to ask for help

You will inevitably hit decisions the plan does not anticipate. When that happens:

1. Write the decision and the options to `DECISIONS.md` (create it if absent) under a new heading with date.
2. Pick the option that is most reversible and lowest-blast-radius.
3. Continue. Do not block waiting for input from outside the lab unless the decision is genuinely irreversible (npm package name, public API contract, data license commitment).

## How to report progress

Append to `LOG.md` (create if absent) after every meaningful unit of work. One line per entry: `YYYY-MM-DD HH:MM | <phase> | <what was done> | <next>`. Keep it terse — the radio-console format from the user preferences. This log is the only thing the human will read between check-ins.
