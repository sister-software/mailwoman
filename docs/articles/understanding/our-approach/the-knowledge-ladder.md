---
sidebar_position: 19
title: The knowledge ladder
tags:
  - architecture
  - staged-pipeline
  - reference
  - neural
  - resolver
---

# The knowledge ladder

The staged pipeline is a contract for **decomposition by what each layer knows**. Every stage is the rightful home of a particular kind of information; pushing work to the wrong stage produces fragile systems that try to learn things from data that they could have looked up, or look up things that they could have learned. This article catalogues the layers, what each one knows, and the two layers we don't ship yet but should.

Read [The pipeline contract](../../concepts/staged-pipeline-contract.md) first for the runtime mechanics. This article is the conceptual companion — _why_ the layers are arranged this way, and where the design has gaps.

## The full ladder

Each layer adds one kind of knowledge the layers below it cannot easily derive:

| Layer                    | Knows                                                         | Shipped today                                                                                                          |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **1. Normalize**         | input preprocessing rules                                     | Yes                                                                                                                    |
| **2. Locale gate**       | language / script family                                      | Yes (rule-based)                                                                                                       |
| **2.5. Kind classifier** | overall query category (postcode_only, structured_address, …) | Yes (rule-based)                                                                                                       |
| **2.7. Phrase grouper**  | **coherent input units (boundary discovery)**                 | **Yes (rule-based, v0.5.0; 57 venue markers, unit gate, positional prior)**                                            |
| **3. Token classify**    | per-token semantic type                                       | Yes (neural, v0.5.2)                                                                                                   |
| **3.5. FST prior**       | **gazetteer-derived emission biases**                         | **Yes (Wikipedia importance-weighted, v0.5.2; [#173](https://github.com/sister-software/mailwoman/pull/173))**         |
| **4. Sequence correct**  | per-token BIO sequence validity                               | Yes (CRF with structural mask)                                                                                         |
| **4.5. Grouper audit**   | **provisional nodes for all-O spans**                         | **Yes (injects venue/locality from grouper proposals; [#170](https://github.com/sister-software/mailwoman/pull/170))** |
| **5. Reconcile**         | **joint-coherent interpretation across candidates**           | Yes (joint-decoding path shipped in v0.5.0; opt-in via `forceJointReconcile`)                                          |
| **6. Resolve**           | world hierarchy (gazetteer)                                   | Yes (WOF SQLite, unified builder in [#176](https://github.com/sister-software/mailwoman/pull/176))                     |

The two emphasized rows are the layers that v0.4.0's mixed result exposed as missing. They're complementary: the phrase grouper feeds cleaner spans IN to the classifier; the expanded reconciler picks coherent assignments OUT of the classifier's candidates.

## What each layer knows (and doesn't)

### Normalize — input preprocessing rules

Unicode normalization, locale-aware case folding, whitespace collapsing. Knows nothing about address structure; it cleans bytes so downstream layers see canonical text. The right home for "the input might use NFD-decomposed accents" but not for "this string contains an address."

### Locale gate — language / script family

Detects whether input is en-US, fr-FR, ja-JP, etc. Today this is a rule-based scorer (script-class + postcode-format hits with a caller-trust fallback). Tomorrow it could be a small detector model. Knows enough to bias the kind classifier and resolver weighting; doesn't know about specific places.

### Kind classifier — overall query category

Bare postcode? Single locality? Full structured address? PO box? Landmark? Intersection? This is a coarse taxonomy of input _shape_ — bitter-lesson-safe (purely structural cues, no place-name dictionaries). The kind decision enables the fast-path routing in the coordinator. Knows the high-level question being asked; doesn't know the answer.

### Phrase grouper — coherent input units (boundary discovery) — SHIPPED (rule-based, v0.5.0)

**Rule-based v1 shipped in v0.5.0 Thread E (`@mailwoman/phrase-grouper`); learned 1-2M-param span proposer scoped for v0.5.1. v0.4.0 made the cost of its absence visible — v0.5.0 closes that gap.**

The neural classifier (Stage 3) is asked to learn three things simultaneously via BIO tagging:

1. **what** each token is (semantic type)
2. **where** each span starts (boundary)
3. **where** each span ends (boundary)

These are coupled in BIO. A wrong boundary makes the type prediction wrong — even when the model "knew" the right type. v0.4.0's bio_slip cases (`", 22220"` for `22220`) are exactly this: type was right, boundary was off.

A phrase grouper proposes coherent units with confidence _before_ the classifier runs:

```
input:     "350 5th Ave, New York, NY 10118"
proposals: [
  { span: "350",           kind_hypothesis: NUMERIC,             confidence: 0.95 },
  { span: "5th Ave",       kind_hypothesis: STREET_PHRASE,       confidence: 0.92 },
  { span: "New York",      kind_hypothesis: LOCALITY_PHRASE,     confidence: 0.85 },
  { span: "NY",            kind_hypothesis: REGION_ABBREVIATION, confidence: 0.95 },
  { span: "10118",         kind_hypothesis: POSTCODE,            confidence: 0.95 },
]
```

The classifier then conditions on these proposals. Instead of discovering boundaries from scratch, it answers the simpler question "what type is this proposed span?" — and can override the grouper when it disagrees.

The information at this layer is **purely structural**: token proximity, punctuation, capitalization, hyphenation, format-shape repetition. The same set of cues v1's rule-based parser used. A rule-based phrase grouper would be a port of v1's section/sub-section logic; a learned phrase grouper would be a small (1-2M param) span proposer trained on segment boundaries from corpus.

This is a separate concern from "is this span a postcode?" The grouper's question is "do these tokens belong together?" — boundary-finding, not typing.

### Token classify — per-token semantic type

The neural classifier. Per-token BIO tagging today. Knows distributions of tokens to tag classes from training. Does **not** know the world (which countries contain which regions) and cannot easily learn the gazetteer from corpus statistics. Asking it to do so wastes capacity that could be spent on type discrimination.

v0.5.0's classifier (Thread C) ships two architectural changes to fit the wider ladder. **Phrase-prior conditioning:** the input layer takes a per-token feature row (BIE markers + `PhraseKind` one-hot from the Stage 2.7 phrase grouper) concatenated onto the token+position embedding and projected back to `hidden_size`. Boundary discovery moves to Stage 2.7 where it belongs; the classifier conditions on those proposals and answers the simpler "what type is this proposed span?" — and is still free to disagree when its evidence outweighs the grouper's confidence. **Top-k inference (`predict_top_k`):** the inference path emits the K most-probable tag sequences with calibrated log-probability scores under the CRF distribution, not just the argmax. Stage 5 reconcile consumes these as the classifier's belief over candidate parses. Both are gated behind config flags (`use_phrase_priors`, `predict_top_k(k=...)`) so the v0.4.0-style argmax-only encoder still works for ablation studies and back-compat.

### Sequence correct — BIO sequence validity

The CRF with frozen structural transition mask. Forbids orphan-`I-*` sequences (no `I-locality` without preceding `B-locality`), enforces the BIO grammar. Knows the structural rules of BIO; doesn't know about semantic coherence.

### Reconcile — joint-coherent interpretation — SHIPPED (joint-decoding path, v0.5.0)

**Joint-decoding path shipped in v0.5.0 Thread D (`core/pipeline/reconcile.ts`). The fallback "sort spans by start" path is still wired as the default in `runtime-pipeline.ts` until Thread C-s lands the classifier top-k contract — at which point joint decoding becomes the default.**

Stage 5's purpose is cross-component reconciliation: take everything the upstream layers produced and pick the joint interpretation that maximizes coherence.

Stage 5's inputs in v0.5.0:

- **Top-k tag interpretations** from the classifier (Thread C-s contract, mocked in tests until it lands)
- **Top-k span proposals** from the phrase grouper (Thread E `PhraseProposal[]`, shipped)
- **Top-k resolver candidates** per (span, tag) from Stage 6 (WOF SQLite, shipped)
- **Concordance constraints** — country / region / locality / dependent_locality assignments are coherent iff their `parent_id` chain agrees in the gazetteer

The implementation is beam search over `(span × tag × resolver)` with incremental concordance. The score per beam is `phrase_conf × classifier_score × resolver_score × concordance_bonus`; per-axis pruning (default `kSpan=3`, `kTag=3`, `kResolver=5`) keeps the search tight. A fully-consistent WOF parent chain contributes `+concordanceWeight` in log-space (default weight 1.0); an explicit contradiction is a hard veto.

Concrete cases this addresses:

- **"NY-NY Steakhouse, Houston, TX"** — classifier tags NY twice as region (it appears twice in the venue brand). Resolver can't find a hierarchy where Houston, TX coexists with NY as a region. Stage 5 reweights the NY tokens toward `venue` (the classifier's second-best interpretation) because that's the only interpretation that's joint-coherent.
- **"Paris, Texas"** vs **"Paris, France"** — same locality classifier output, different hierarchy resolution. Stage 5's concordance scoring picks the Texas reading because the joint TX-region assignment matches Paris-TX's parent chain.
- **"Saint Petersburg, FL"** — CRF prevents the orphan-I split; Stage 5 ensures the joint span resolves to St Pete, FL (not the Russian city), because FL is in St-Pete-FL's parent chain and Russia is not.

Each case is asserted in `core/pipeline/reconcile.test.ts` (grep for `kryptonite catalogue —`).

### Resolve — world hierarchy

WOF SQLite today (Phase 4.3). Knows place IDs, parent_id chains, placetypes, lat/lon. Returns candidates with scores. Does not know the input syntax; doesn't try.

## Positional constraint propagation

There's an internet-classic video about missile guidance systems: "The missile knows where it is at all times. It knows this because it knows where it isn't." The reasoning sounds tautological, but it works.

Address classification has the same structure. A span knows what it is by knowing what the spans around it _cannot_ be. An address is an ordered hierarchy:

```
house_number → street → [unit | venue] → locality → region → country → postcode
```

When the resolver confirms "Chicago" as a locality at position N, the constraint propagates backward: whatever precedes it cannot be a region, country, or postcode. It must be a street, house number, unit, or venue. The classification space for the unconfirmed span collapses from 15 possible tags to 4 — without examining the span itself.

This principle is not a single feature. It runs through every layer of the architecture:

| Layer               | Mechanism                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| CRF transition mask | `B-locality → I-street` is `-inf`. Viterbi cannot sequence a street after a locality.                                                      |
| QueryShape prior    | Region abbreviation at position N → tokens at N-k get +2.0 toward `B-locality`. The abbreviation constrains what preceded it.              |
| FST prior           | Place name matched → `B-street` suppressed by -1.5. If the FST says this is a place, it cannot also be a street.                           |
| Grouper-audit       | All-O span between confirmed components → phrase grouper's structural hypothesis applied. Position + surface form jointly narrow the type. |

Each layer enforces the same constraint through different mechanisms — soft priors, structural masks, post-hoc corrections — but the principle is identical: the classification of a span is partially determined by the spans that come after it, because the address hierarchy forbids certain sequences.

Where it breaks down: inverted orderings ("NY, New York" puts region before locality), missing components (no postcode detected, so the constraint chain has a gap), and international formats (Japan writes region → locality → street, reversing the propagation direction — which is why v0's position penalties are locale-gated).

For the full treatment — the right-to-left scan model, sequence elasticity, and the locale ordering registry — see [Positional constraint propagation](../../concepts/positional-constraint-propagation.md).

## Why this decomposition is bitter-lesson aligned

Bitter lesson says "general methods that leverage computation" win in the long run. It does NOT say "make one model do everything." It says don't hand-engineer domain knowledge in places where the system could learn it from data.

What we want to learn from data: per-token semantic type distribution (Stage 3), structural transition validity (Stage 4 if learned-CRF replaces structural-mask).

What we should look up: the world's place hierarchy (Stage 6, the gazetteer). Forcing the model to memorize WOF wastes capacity.

What we should compose: input shape priors (Stages 2, 2.5, 2.7), output coherence (Stage 5). Decomposition + joint decoding > end-to-end-everything when the components have clean contracts.

## What v0.4.0 taught us about the missing rungs

The v0.4.0 ablation campaign's failure modes mapped almost cleanly to two missing information layers. v0.5.0 closed both:

| v0.4.0 failure                                                              | Missing layer                                                      | v0.5.0 fix                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **65% empty_pred** on mid-position postcodes (`Paris 75008`)                | Phrase grouper (Stage 2.7) — no boundary prior                     | `@mailwoman/phrase-grouper` proposes `75008` as a coherent unit before classification   |
| **6% bio_slip** on `", 22220"` for `22220`                                  | Phrase grouper (Stage 2.7) — boundary-trimming is a downstream fix | Phrase grouper proposes `22220` as a span; the classifier never sees the `, `           |
| **Kryptonite cases** (`NY-NY Steakhouse`, `Paris, Texas`, `St. Petersburg`) | Reconcile (Stage 5) — no joint-coherence check                     | `reconcile.ts` beam search with WOF concordance scoring catches joint-incoherent parses |
| **92% adversarial transliteration** on country FN                           | Tokenizer (separate concern)                                       | A1 tokenizer halves byte-fallback on multi-script eval (36.7% → 18.2%)                  |

The missing rungs were _information layers_. v0.4.0 wasn't doing the joint reasoning the architecture's contract implied it should. v0.5.0's scaffolding adds those rungs. The remaining work is training stable classifier weights that exercise them end-to-end.

## Training: CE-only resolved the divergence

Both v0.4.0 and v0.5.0 training runs diverged under dual loss (CRF-NLL + CE). The CRF-NLL gradient dominated CE by 8-20x, pulling the model toward a degenerate attractor. CE-only training (`crf_loss_weight: 0.0`) resolved this — the CRF is now an inference-time structural decoder with a frozen mask, not a training objective.

v0.5.2 shipped from a stable 100K-step CE-only run. v0.5.3 is in progress with improved diagnostics (per-tag F1 at every 2K steps, reduced label smoothing, rebalanced class weights). The knowledge ladder's "sequence correct" rung is now cleanly separated: the model learns per-token type distributions (Stage 3), the CRF enforces BIO validity (Stage 4) — no competing gradients.

## See also

- [The staged pipeline](./the-staged-pipeline.md) — narrative framing
- [The staged pipeline contract](../../concepts/staged-pipeline-contract.md) — runtime mechanics for integrators
- [What is a concordance?](../the-problem/what-is-a-concordance.md) — how Stage 5's concordance scoring works
- [What is a postcode?](../the-problem/what-is-a-postcode.md) — why the resolver can't treat postcodes as polygons
- [`STAGES.md`](../../plan/reference/STAGES.md) — formal per-stage type contracts
- [`VERDICT_SMOKES.md`](../../plan/reference/VERDICT_SMOKES.md) — the process-side companion
- [v0.4.0 ablation campaign retrospective](../../retrospectives/v0-4-0-ablation-campaign.md) — the failures that exposed the missing rungs
- [v0.5.0 C-train blog post](pathname:///blog/2026-05-24-v0-5-0-c-train-bisect) — the training divergence bisect
