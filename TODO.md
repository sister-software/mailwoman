# TODOs

Open items not blocking the current ship. Promoted to issues / PRs as scope solidifies.

## v0.5.0 fresh-slate threads

Per [Phase 8 — v0.5.0 fresh-slate](docs/articles/plan/phases/PHASE_8_v0_5_0_fresh_slate.md). Status frozen 2026-05-25.

| Thread  | Scope                                                      | Status                                                               |
| ------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| A0      | Tokenizer harness + A0 baseline on corpus-v0.3.0           | **shipped** PR #129                                                  |
| A1      | Tokenizer retrain on corpus-v0.4.0 (byte-fallback 18.2%)   | **shipped** PR #138                                                  |
| B       | Kryptonite catalogue (4,771 adversarial rows)              | **shipped** PR #130                                                  |
| B2      | Transliteration pairs (73,316 rows × 5 scripts)            | **shipped** PR #136                                                  |
| C-s     | Classifier scaffold (top-k + phrase-prior input layer)     | **shipped** PR #128                                                  |
| C-train | CE-only full classifier train (h256, LR=1.5e-4, 50K steps) | **in-flight** step 6800/50K, val_macro_f1=0.496; ETA Mon evening UTC |
| D-s     | Stage 5 reconcile scaffold (joint decoding)                | **shipped** PR #131                                                  |
| D-wire  | Wire reconcileSpans as default in runPipeline              | **shipped** PR #145 (behind `forceJointReconcile` flag)              |
| E       | Stage 2.7 phrase grouper (rule-based)                      | **shipped** PR #126                                                  |
| F       | Verdict-smoke framework + sidecar audit                    | **shipped** PR #125                                                  |

### Key findings from the C-train campaign

- **CRF NLL is the training destabilizer** — gradient-norm probe showed CRF dominates CE by 8-20× in the conflict regime below loss 0.41. Nine dual-loss runs diverged; CE-only (crf_loss_weight=0) trains stably past 6800 steps with val_macro_f1=0.496 (best ever). See [`dual-loss-curvature-conflict.md`](docs/articles/concepts/dual-loss-curvature-conflict.md).
- **Smokes must match full-run effective batch.** Smoke at eff_batch=8 passed; full at eff_batch=128 diverged. Added to [`VERDICT_SMOKES.md`](docs/articles/plan/reference/VERDICT_SMOKES.md).
- **Reconciler eval against v0.4.0 weights: zero delta** — classifier too weak to put correct tag in top-3. Waiting for CE-only weights to re-eval. Script at `scripts/eval-joint-reconcile.ts`.

## CPU-bound work surfaced 2026-05-23 (parallel to v0.4.0 training window)

Triaged during the v0.4.0 training prep — these can run while the GPU is occupied with
the v0.4.0 training run. Listed in roughly descending leverage order.

### 1. `@mailwoman/locale-gate` — Stage 2 of the runtime pipeline

Last unbuilt runtime stage. Currently the coordinator's `detectLocale` is a caller-trust
stub: it accepts `opts.locale` at confidence 1.0 or falls back to `und` at confidence 0.0.
A real Stage 2 closes the loop on the staged pipeline.

- **v1 (rule-based)**: derive locale from `QueryShape.characterClass` (CJK → ja-JP, Cyrillic
  → ru, Arabic → ar, alpha → en-US default) + known-format hits (us_zip → en-US, fr_postcode
  → fr-FR, uk_postcode → en-GB).
- **v2 (trained)**: small character-level classifier (~100 KB) over the first 200 chars.
  Per-locale corpus rows already carry the `locale` field — supervised training data is free.
- Lives in a new `locale-gate/` workspace, structurally compatible with the coordinator's
  `LocaleHint` shape (no @mailwoman/core dep needed).
- Wire as the default `detectLocale` in `createRuntimePipeline()` factory.

**Failure classes owned**: Unicode/transliteration script-handling (#6), language-switch
hybrids (#7) per `concepts/addresses-that-break-geocoders.md`.

**Acceptance**: `STAGES.md` Stage 2 "Today" line flips from "caller-trust stub" to
"@mailwoman/locale-gate (rule-based v1)"; the staged pipeline picture's mermaid loses
its `(stub today)` annotation.

### 2. `mailwoman parse --candidates` CLI flag

Surfaces the resolver's `alternatives` field shipped 2026-05-23 (`AddressNode.alternatives`).
Today the field is set on resolved nodes but no CLI path renders it. End-to-end Springfield-
class disambiguation visibility.

- Add `--candidates [int]` to `parse` command (default 5 when bare).
- In the renderer, group output by resolved node + emit runner-ups inline.
- Add a CLI integration test exercising a known-ambiguous locality.
- Optional: surface candidates in the web demo's `ResolvedPlace` panel (the `CandidatePicker`
  React component already exists for the cascade — adapt for resolver alternatives).

**Acceptance**: `mailwoman parse --candidates "Springfield"` shows multiple WOF candidates
(IL, MA, MO) with their place IDs + lat/lon.

### 3. `mailwoman corpus-audit` CLI tool

Reads `MANIFEST.json` + samples shards, reports per-source distribution vs the configured
`source_weights`. Would have caught the "NAD = 411/674 shards (61%) but v0.3.0 source weight
2.0 pushes sampled mix to ~75%" finding during v0.3.0 review.

- Lives in `corpus/scripts/audit.ts` (TypeScript, matches existing corpus-side tooling
  language).
- Inputs: corpus dir + optional config YAML path with source_weights.
- Outputs: per-source shard count + estimated sampled %, plus a warning when any source
  weight × shard_count is > 3× the next-highest source.
- Surface in the corpus-build CLI as a post-build verification step.

**Acceptance**: running against corpus-v0.3.0 emits a table with usgov-nad as a flagged
dominator at 2.0× weight, recovers to OK at 1.0×.

### 4. Runtime-pipeline coordinator test coverage hardening

The `runPipeline` coordinator (shipped 2026-05-23) has 17 unit tests covering happy path +
fast-path + degradation. Edge cases not yet covered:

- AbortSignal propagation through each stage (stage abort → empty tree, not crash).
- Timing-budget assertions (e.g. fast-path adds < 5ms vs no-op pipeline; full pipeline
  with stub stages adds < 20ms).
- Partial-failure modes: classifier returns tree with alternatives, resolver enriches
  some nodes + fails others.
- Concurrent invocations of the same pipeline instance (no shared mutable state).

**Acceptance**: 10-15 new tests in `core/pipeline/runtime-pipeline.test.ts`.

### 5. `mailwoman parse --benchmark` mode

Operator-useful diagnostic. Runs N iterations of `parse(text)` and reports per-stage
timing percentiles (p50, p95, p99). Surfaces which stage is the bottleneck in practice on
the operator's machine.

- New `--benchmark <N>` flag on `parse` (default 100 iterations).
- Output: JSON per-stage timing distribution + total.
- Optional: `--warmup <N>` for JIT/cache warm-up before measurement.

**Acceptance**: `mailwoman parse --benchmark 500 "350 5th Ave NYC"` emits per-stage
percentiles in JSON.

### 6. `concepts/staged-pipeline-contract` public-facing article

The `concepts/the-staged-pipeline.md` article is the narrative. `STAGES.md` is the
implementer's contract. There's no public-facing article translating STAGES.md's per-stage
TypeScript contracts into the ESL-friendly track — readers wanting "what do I implement to
add a new stage" have no entry point.

- ~600-1200 words + 1-2 mermaid diagrams.
- Cover: the structural-typing pattern (avoids dep cycles), the AddressClassifier interface,
  the RuntimePipelineStages record, fast-path conventions, graceful degradation.
- Sibling of `concepts/the-staged-pipeline.md` at sidebar position 14.

**Acceptance**: live at `https://mailwoman.sister.software/docs/concepts/staged-pipeline-contract`.
