# Curatorial synthesis & action plan — 2026-05-25

**A consolidation of five reviews** (Codex 2026-05-24, DeepSeek 2026-05-24, Claude×DeepSeek follow-up 2026-05-24, Docs/Audience 2026-05-25, Project Direction 2026-05-25, Codex Curatorial 2026-05-25) into a single prioritized execution plan.

---

## Where all five reviews agree

Every review — from three different models across two dates — converges on the same assessment. The convergence is unusually tight for independent reviews:

| Theme              | Verdict                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Architecture**   | The Knowledge Ladder / staged pipeline is correct. Parse/resolve split, Ship of Theseus coexistence, and small-encoder classifier are the right design.                                                              |
| **Current risk**   | Architecture is ahead of integration. The reconcile path and top-K pipeline exist in code but aren't wired as the default, so the architectural thesis is unproven end-to-end.                                       |
| **Training**       | Divergence is the active blocker. CE-only training is the right current experiment. v0.5.0 repeated the scope-bundling mistake v0.4.0's retrospective warned about.                                                  |
| **Docs structure** | Missing a canonical status page, getting-started guide, and API reference. Terminology drift (Stage/Tier/Phase/Thread) needs reconciliation. Operator docs and user docs are interleaved without audience signposts. |
| **Blog posts**     | Unusually strong and honest, but serial-narrative assumptions and missing search-engine preambles make them hostile to inbound readers.                                                                              |
| **Synthetic data** | LLM-generated corpus rows need curriculum controls — alignment validation alone is insufficient.                                                                                                                     |
| **Next moves**     | Narrow the next cycle: status clarity, reconcile integration, product-level evals, one-variable training discipline, then spend.                                                                                     |

---

## Prioritized execution plan

### Phase A — Curatorial cleanup (this week, zero GPU, zero code changes)

These are docs-only changes that reduce status confusion immediately. They unlock every subsequent phase by ensuring contributors and reviewers share a single picture of what's shipped.

**Owner: human (docs track). Issues filed separately as needed.**

#### A1. Create `/docs/status`

**Single page. Sidebar position: first after "Start here."** Contents:

| Section             | Content                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packages & versions | `mailwoman` (CLI), `@mailwoman/core`, `@mailwoman/classifiers`, `@mailwoman/neural`, `@mailwoman/neural-weights-en-us` (v0.4.0), `@mailwoman/neural-weights-fr-fr` (v0.4.0), `@mailwoman/phrase-grouper`, `@mailwoman/normalize`, `@mailwoman/query-shape`, `@mailwoman/kind-classifier`, `@mailwoman/resolver-wof-wasm`, `@mailwoman/neural-web`, `@mailwoman/cartographer` |
| Model weights       | v0.4.0 shipped. 21 BIO labels (7 coarse + 3 fine). Per-component F1 limits. Known regressions: postcode (0.69), coarse labels still rule-carried.                                                                                                                                                                                                                            |
| Corpus              | corpus-v0.3.0 (677M rows). corpus-v0.4.0 (v0.3.0 + 4,771 kryptonite + ~73K transliteration pairs) exists but no stable classifier trained on it yet.                                                                                                                                                                                                                         |
| Tokenizer           | v0.1.0 (16K vocab) — used by v0.4.0 weights. A1 (48K vocab, trained on corpus-v0.4.0) — trained, not yet used in stable classifier.                                                                                                                                                                                                                                          |
| Runtime stages      | Table: each of the 6 stages, status (✅ default / 🚩 opt-in / 🧪 scaffold / ❌ not built), and what model weights it works with.                                                                                                                                                                                                                                             |
| Browser demo        | Runs v0.4.0 weights + WOF SQLite in-browser. ~60MB cold load. Joint decode is NOT active in the demo.                                                                                                                                                                                                                                                                        |
| Training state      | CE-only smoke passed (val_macro_f1=0.444, no divergence past step 2000). Full 50K CE-only run in progress. Target: first v0.5.0 weights that train stably.                                                                                                                                                                                                                   |
| Known regressions   | Postcode F1 0.69 (down from 0.76 in v0.3.0). Coarse labels (country 0.21, region 0.19) remain rule-carried. Full-parse exact match ~0.08.                                                                                                                                                                                                                                    |
| Not supported       | Rooftop/address-point geocoding. Multi-locale ensemble. Japanese addresses. PO boxes. Unit/apartment parsing.                                                                                                                                                                                                                                                                |

**Update rule**: this page is updated on every release. Blog posts link here for current status, not to each other.

#### A2. Create `/docs/getting-started`

**Second docs page after Status.** Contents:

- `npm install mailwoman` + locale weights
- 5-line Node.js example (parse → inspect components → resolve → get coordinates)
- 5-line browser example (dynamic import, same API surface)
- CLI example (`mailwoman parse "350 5th Ave, New York, NY 10118" --neural --format json`)
- Honest caveats: model quality, resolver precision (admin/postcode-level, not rooftop), browser load time
- Link to demo, status page, API reference

#### A3. Create `/docs/api`

**Third docs page.** Contents:

- `NeuralAddressClassifier` — constructor, `parseWithLogits`, output shape
- `createRuntimePipeline` — factory, configuration, `forceJointReconcile`
- CLI — `mailwoman parse --neural --format json|tuple|sexp --candidates`
- Output types — `AddressTree`, `AddressNode.alternatives`, `ClassificationProposal`, confidence semantics
- Configuration — locale selection, policy registry, fast-path routing (postcode_only, locality_only)
- Link to `STAGES.md` for per-stage contracts

#### A4. Reconcile terminology

- Add **Stage**, **Tier**, **Phase**, **Thread** to glossary with explicit definitions and a "don't confuse these" note
- Rename eval filenames: `stage1-coarse-*` → `tier1-coarse-*`, `stage2-*` → `tier2-*` (or add frontmatter with `pagination_label` that preserves the URL but displays the new name)
- Add a "Historical naming" note to `plan/README.md`
- Update `STAGES.md` header to remove the stale "1/2/2.5/candidate-list are unbuilt" status line

#### A5. Fix high-visibility status contradictions

The five contradictions the Codex review identified as "now a docs bug class":

1. **CRF runtime status**: `crf-decoder.md` says JS-side Viterbi is "not yet" — update to "shipped 2026-05-23"
2. **Locale gate default**: `how-it-works-now.md` says "factory default falls back to caller-trust" — `STAGES.md` says "wired as default" — reconcile to "workspace shipped, not yet wired as factory default"
3. **Candidate-list status**: `STAGES.md` says "scaffold-only/designed" then later says `AddressNode.alternatives` shipped — the alternatives field shipped, the top-K resolver API behind `--candidates` is in progress
4. **ARCHITECTURE.md layout/label count**: add a dated block at the top: "⚠️ Written for Phase 2 planning (2026-05-18). Current shipped vocabulary: 21 BIO labels. See `/docs/status` for current state."
5. **v0.5.0 B2 status**: `v0-5-0-shipped.md` still says B2 is "still cooking" — update to "landed; included in corpus-v0.4.0"

#### A6. Add audience headers

Add `:::info Who this is for` blocks to:

- `plan/README.md` — "Contributors and operators running training experiments"
- `ARCHITECTURE.md` — "ML engineers evaluating the design; historical planning doc. See `/docs/status` for current shipped state."
- `OPERATIONS.md` — "Operators running corpus builds, training runs, and releases"
- `TRAINING_ENV.md` — "Operators provisioning GPU training environments"
- `VERDICT_SMOKES.md` — "Operators designing training experiments"
- `STAGES.md` — "Implementers working on pipeline stage contracts"

#### A7. Blog post preambles

Add 2-3 sentence "If you found this via search" preambles to:

- `two-voices-arguing.mdx` — define Mailwoman, say this is conceptual/beginner-friendly, link to demo
- `taming-wof.mdx` — define Mailwoman, say this is a practical reference, link to concept article counterpart
- `v0-4-0-ablation-campaign.mdx` — define Mailwoman, say this is a historical retrospective, link to status page for current state
- `v0-5-0-c-train-bisect.mdx` — define Mailwoman, say this is a training log entry, link to status page

#### A8. Homepage CTA reorder

Current primary CTA: "Read the plan." Replace with ordered CTAs:

1. **Try the demo** → `/demo`
2. **Get started** → `/docs/getting-started`
3. **How it works** → `/docs/understanding/our-approach/how-it-works-now`
4. **Read the plan** → `/docs/plan`

#### A9. Soften unverified quantitative claims

In `the-90-percent-trap.md`, the geocoder accuracy table by housing type, and any other numerically-precise-but-uncited claims: either add a citation/date-stamp to each row, or recast as "illustrative ranges." The rhetorical force of the argument doesn't depend on point precision.

---

### Phase B — Architecture validation (this week, zero GPU, ~200 lines of TypeScript)

**[→ #153](https://github.com/sister-software/mailwoman/issues/153)** — Wire joint-reconcile end-to-end with real model output

This closes the integration gap. It proves (or disproves) the architectural thesis independently of training stability.

#### B1. Expose per-token logits in the TypeScript runtime

`NeuralAddressClassifier.parseWithLogits` already exists. Verify it returns per-token logits for v0.4.0 weights. If it doesn't, add the export path — the ONNX model produces logits, the current runtime discards them after argmax.

#### B2. Implement `aggregateSpanLogits`

~50 lines. For each span proposed by `@mailwoman/phrase-grouper`:

- Sum softmax probabilities across the span's tokens for each candidate tag
- Normalize by span length
- Return top-K (tag, score) pairs per span

#### B3. Wire `reconcileSpans` into `runPipeline` behind `forceJointReconcile`

~50 lines. Feed `(span, tag, score)` triples from B2 into the existing `reconcileSpans`. Track the feature flag so argmax fallback remains the default.

#### B4. Evaluate against kryptonite catalogue + golden v0.1.2

Use v0.4.0 weights. Compare argmax fallback vs joint reconcile on:

- Kryptonite exact-match
- Golden macro_F1
- Combined exact-match on kryptonite ∪ golden
- Per-example failure audit (was the correct tag in the classifier's top-3?)

Decision matrix (from the Claude×DeepSeek follow-up):

| Kryptonite Δ exact-match | Golden Δ macro_F1 | Verdict                                                                           |
| ------------------------ | ----------------- | --------------------------------------------------------------------------------- |
| ≥ +15pp                  | ≤ −1pt            | **Go.** Architecture validated. Train better weights to beat this.                |
| ≥ +15pp                  | > −1pt            | Golden regression. Concordance or resolver scoring is hot. Fix, retest.           |
| < +15pp                  | ≤ −1pt            | Architecture isn't earning its complexity. Revisit scoring before any retraining. |
| < +15pp                  | > −1pt            | Both broken. Step back, diagnose.                                                 |

**Mitigations** (from the Claude×DeepSeek follow-up):

- **WOF parent_id spot-check**: validate 20 (locality, region) pairs against WOF REST API. If >1 mismatch, concordance scoring is evaluating against bad data.
- **v0.4.0 weights may be too weak**: if kryptonite Δ < +15pp, check whether the correct tag was in the classifier's top-3 for each failed example. If not, the bottleneck is classifier quality (need new weights), not reconciler algorithm.
- **Golden v0.1.2 is small** (4,535 entries): a 0.5-1.5pt macro_F1 regression could be annotation noise. Manually inspect all disagreement entries before deciding.

---

### Phase C — Training resolution (this week, gated on CE-only full run)

**[→ #154](https://github.com/sister-software/mailwoman/issues/154)** — CE-only training: validate stability, ship v0.5.0 weights or bisect

#### C1. If CE-only full 50K run converges

- **Ship v0.5.0 weights** with explicit caveats in the model card
- **Then** explore quality knobs (class weights, source rebalance, longer schedules) — now safe under single-loss
- **Parallel**: act on Phase B reconcile matrix result

#### C2. If CE-only diverges

- Bisect corpus: A1 tokenizer + corpus-v0.3.0 (keep tokenizer win, revert corpus)
- If that trains cleanly: transliteration data is the destabilizer → cap B2 at low batch weight, retrain
- If that also diverges: revert tokenizer to v0.1.0 → the A1 tokenizer itself is the destabilizer

#### C3. Synthetic data curriculum (regardless of C1/C2 outcome)

Before any future training run that includes LLM-generated data:

- Cap synthetic transliteration mass at a controlled percentage of batch composition
- Source-specific gradient/loss dashboards
- Near-duplicate detection
- Compare token length, component count, punctuation, source distribution vs real rows
- Semantic spot-check on sampled batch
- Promotion criteria: must pass a constant-LR smoke at full effective batch before joining main corpus

---

### Phase D — Product-level evals (next 1-2 weeks)

**[→ #155](https://github.com/sister-software/mailwoman/issues/155)** — Product-level eval matrix: comparison script as release gate

#### D1. Build eval matrix script

A single script that runs all comparison modes against golden + kryptonite and emits:

- Per-component P/R/F1 (rule-only, neural-only, hybrid, hybrid + joint-decode)
- Full parse exact match
- Parse-level calibration
- Empty-parse rate
- Overconfident-wrong rate
- Top-1 resolver accuracy / top-5 recall
- Per-failure-class breakdown from the "addresses that break geocoders" taxonomy
- Confusion matrix for kryptonite cases

This report becomes the release gate for any new weights.

#### D2. Add resolver precision caveats

Everywhere the docs say "geocoder" or show coordinates: add a note that the current WOF resolver returns administrative/postcode-level place candidates, not rooftop/address-point coordinates. This is not a bug — it's the current resolver scope — but it must be explicit.

---

### Phase E — Doc content promotion (next 2 weeks)

Extract the strongest blog-post technical content into stable concept docs:

#### E1. WOF gotchas → `concepts/whosonfirst-gotchas.md`

Extract the factual content from `taming-wof.mdx`: file-per-place layout, property namespace explosion, Brooklyn Integers, supersession chains, parent_id=-1, the two-layer architecture (WOFPlacenameCache + PlacetypeDataSource), the Piscina pipeline, and `AsyncSpliterator.asMany`. Keep the blog post for narrative; the concept article is the reference.

#### E2. Dual-loss explainer → companion to `dual-loss-curvature-conflict.md`

The "two voices arguing" post is the best beginner explanation in the repo. Extract a condensed "Cooperative-vs-conflict: a beginner's guide" section into `concepts/dual-loss-curvature-conflict.md` or a companion article. Link from the blog post.

#### E3. Eval methodology → `concepts/eval-methodology.md`

Extract the false-negative bucketing methodology, the cosine-LR meta-bug explanation, and the "always categorize before reporting" discipline from the v0.4.0 retrospective into a stable article.

---

### Phase F — Operator docs quarantine (next 1-2 weeks)

Move `TRAINING_ENV.md`, `OPERATIONS.md`, `VERDICT_SMOKES.md`, and the phase files into either:

- A dedicated "Operator notes" sidebar section (visible but marked 🧪), OR
- A separate `/docs/operator/` path with its own sidebar

Add a note at the top of each: "This is operator documentation. If you want to use Mailwoman, see [Getting started](/docs/getting-started)."

Update `ARCHITECTURE.md` with a dated status block and audience header. Do not rewrite it — preserve the historical design rationale, just make clear it's historical.

---

### Deferred (do not start until Phases A–D complete)

- Learned phrase grouper (v0.5.1 scope)
- Span re-reader (v0.6.0 scope)
- Hidden-size bump
- Tier 3 label expansion (attention, po_box, richer POI taxonomy)
- Japan locale validation (Phase 6)
- New resolver backends beyond WOF
- Multi-head encoder extensions
- Studio web UI for human correction

---

## Decision gates

| Gate                      | Condition                                                                | Pass →                                            | Fail →                                                  |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------- |
| CE-only full train        | No divergence past step 2000, val_macro_f1 ≥ 0.35                        | Ship v0.5.0 weights, begin quality-knob iteration | Bisect corpus/tokenizer (Phase C2)                      |
| Joint-reconcile vs argmax | +15pp kryptonite exact-match AND ≤1pt golden macro_F1 regression         | Architecture validated. Promote reconcile default | Fix scoring or defer to classifier improvement          |
| Product eval matrix       | All comparison modes produce numbers, per-failure-class breakdown works  | Release gate established                          | Fix eval infrastructure                                 |
| Synthetic data curriculum | B2 passes constant-LR smoke at full eff_batch with controlled weight cap | Promote B2 to main corpus                         | Investigate distributional causes, retry with lower cap |

---

## What we are protecting

Through all of this, protect the core architectural shape:

1. **Deterministic rules for bounded facts** — postcodes, state abbreviations, format patterns
2. **Small neural classifier for contextual ambiguity** — token typing, multi-word coherence, graceful degradation
3. **Structural priors before classification** — phrase grouper for boundary discovery
4. **Joint coherence after candidate generation** — reconciler with WOF concordance scoring
5. **World hierarchy from the gazetteer** — WOF SQLite, not model memory

That decomposition is the project's intellectual contribution. Nothing in any of the five reviews contradicts it. The work ahead is proving it end-to-end, not redesigning it.
