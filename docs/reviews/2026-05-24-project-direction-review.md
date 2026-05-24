# Mailwoman project direction review - 2026-05-24

## Executive verdict

Mailwoman is on the right strategic track. The strongest idea in the project is still the Pelias-style split between parsing and resolving, updated for a modern TypeScript/runtime world: a small contextual parser proposes possibilities, deterministic structure supplies cheap priors, and a resolver/gazetteer checks world coherence. That direction is better than either "rules forever" or "one model does everything."

The current work is a significant step forward, but mostly as architecture and instrumentation, not yet as model-quality proof. The v0.5.0 scaffolding - QueryShape, kind classification, phrase grouping, JS Viterbi, resolver alternatives, top-k training support, and opt-in joint decoding - is the right shape. The expensive next step should not be "run the full fresh-slate train again and hope." It should be a tighter validation program that proves the destabilizer, closes the top-k-to-Stage-5 integration gap, and establishes slice-level gates before spending H100/LLM/human-labeling budget at scale.

Recommended posture: continue, but narrow the next cycle. Treat the next spend as validation of the pipeline hypothesis, not as a release train.

## Historical context

The docs tell a coherent lineage:

- Pelias/libpostal established the modern split: parse the string, then resolve against a gazetteer.
- libpostal gave the field a strong CRF baseline, but as a large C dependency with opaque retraining and poor fit for browser/serverless/edge TypeScript deployments.
- Pelias Parser/Mailwoman v1 took the opposite path: TypeScript rules, phrase graph, Cartesian solver, dictionary and regex classifiers. It was debuggable and deployable, but long-tail ambiguity grew without bound.
- Mailwoman v2 is trying to keep Pelias's operational shape while replacing the brittle center: rules remain for high-precision bounded problems, while a small neural sequence model handles contextual ambiguity.

That is the correct historical synthesis. Geocoding has never only been NLP and never only been database lookup. The best framing in the docs is from `CONTEXT.md`: a geocoder is a contextual parser plus a constraint solver. Mailwoman is now finally building both halves in the same package family.

## What is directionally strong

### 1. Parse/resolve split stays intact

Keeping parser and resolver separate is the most important architectural decision. It avoids asking the model to memorize WOF/BAN/TIGER, and it gives the resolver room to return candidates instead of pretending one answer is certain. The new `alternatives` field and `--candidates` CLI direction are especially aligned with graceful failure.

This is also where Mailwoman can be meaningfully better than old geocoders: not just "more correct top-1," but more honest about ambiguity. `Springfield`, `Paris`, and postalcode placeholder failures should surface as candidate sets and diagnostics.

### 2. Small, TypeScript-first neural runtime is justified

The Python-training / ONNX-runtime / TypeScript-consumption split is sound. It respects the project audience and keeps inference deployable in Node and browser contexts. The 9M-parameter encoder is a reasonable scale for address tagging. The docs are right that a large LLM would add cost and latency without solving the core task better.

The browser demo constraint is also valuable as a forcing function: it prevents the project from drifting into a server-only research stack. Keep it as a product constraint, but do not let the demo's 60 MB budget block server-side validation work that can later be distilled.

### 3. Ship-of-Theseus migration is the right risk model

The policy registry and component-by-component migration are conservative in the best sense. Postcodes, state abbreviations, and bounded format rules should remain deterministic. Neural should earn authority by component and by locale. This is how to avoid replacing a debuggable rule parser with an opaque model that is worse in production.

### 4. The staged pipeline is the right decomposition

The knowledge ladder is the best current design artifact:

- Normalize owns bytes and reversible offsets.
- QueryShape owns cheap structural priors.
- Locale/kind classifiers route obvious cases.
- Phrase grouper owns boundary proposals.
- Neural classifier owns semantic tagging.
- CRF owns sequence validity.
- Reconcile owns joint coherence.
- Resolver owns world hierarchy.

This decomposition is aligned with the "bitter lesson" more than a monolithic model would be. The important distinction is "learn distributions, look up the world, compose constraints." That is exactly the right line.

### 5. Diagnostics improved materially

The v0.4.0 retrospective is strong engineering. It does not hide failure behind aggregate F1. It buckets false negatives, identifies the cosine-LR smoke meta-bug, and separates real regressions from adversarial-eval artifacts. `VERDICT_SMOKES.md`, `corpus-audit`, and `diagnose_regression.py` are the right kind of infrastructure to build before spending more compute.

## Main critique

### 1. Architecture is ahead of integration

The docs describe a nearly complete v0.5.0 pipeline, but the runtime still does not use the strongest part by default. `reconcileSpans` is opt-in and uses mocked classifier top-k in tests. `runPipeline` collects phrase proposals and passes QueryShape into the classifier, but it does not feed phrase proposals into the classifier, does not receive real top-k from the TypeScript classifier, and does not call joint reconcile.

This is the largest product risk. The architectural thesis is "candidate generation plus joint coherence beats per-stage argmax." That thesis has not been proven end-to-end with real model output in the default runtime.

Before expensive validation, wire the real path behind a flag:

1. TS classifier emits top-k candidate spans/sequences or exposes emissions to a TS n-best decoder.
2. Stage 2.7 phrase proposals are converted into classifier-compatible priors or candidate spans.
3. Resolver supplies top-k candidates per admin span.
4. `reconcileSpans` runs in `runPipeline`.
5. Eval compares fallback argmax vs joint decode on the kryptonite set and normal golden slices.

Until that path exists, further training only validates part of the system.

### 2. Status docs drift enough to create planning risk

There are several status conflicts:

- `TODO.md` still marks v0.5.0 threads A-E as pending, while `v0-5-0-shipped.md` says most shipped or partially shipped.
- `STAGES.md` has an old status header saying stages 1/2/2.5/candidate-list are unbuilt, then later sections say they shipped.
- `runtime-pipeline.ts` comments still describe locale gate/kind classifier as stubbed even though kind is wired and locale-gate exists as a workspace.
- `ARCHITECTURE.md` still describes a 47-label schema and old `packages/` layout, while shipped weights use the 21-label Tier 2 subset.
- `tokenization.md` describes the v0.1 16K tokenizer as if current, while v0.5 docs discuss a 48K A1 tokenizer.

This matters because next steps are expensive. If the docs are the operating layer, stale status can burn GPU cycles on the wrong premise. The first low-cost next step is a status freeze: one page that says "shipped, default, opt-in, scaffold-only, failed, next experiment."

### 3. Eval evidence is still too weak for a large spend

The project has made real progress, but the model metrics are not yet a green light:

- v0.3.0 gained `house_number`, `street`, and `venue` capability, but coarse labels regressed badly.
- v0.4.0 produced small fine-label gains (`street` 0.27 -> 0.30, `house_number` 0.78 -> 0.79) but `postcode` regressed 0.76 -> 0.69 and full-parse exact match fell 0.107 -> 0.082.
- Aggregate macro F1 improved in one framing, but the component-level story is mixed and exact match remains very low.
- Confidence is reported mostly per token; product users need parse-level and candidate-level calibration.
- Golden v0.1.2 includes adversarial transliteration rows the model was not trained for; that is useful as a stress test but misleading as a headline denominator unless separately weighted.

The next expensive run needs predefined acceptance slices, not a single headline F1. Minimum:

- rule-only baseline
- neural-only argmax
- hybrid policy
- hybrid plus QueryShape prior
- hybrid plus real joint reconcile
- parser-only component F1
- resolved top-1 accuracy
- resolved top-k recall
- full-parse exact match
- low-confidence graceful-failure rate
- per-failure-class metrics from `addresses-that-break-geocoders.md`

### 4. Training instability is now the central technical blocker

v0.4.0 and v0.5.0 both show the same pattern: loss descends through warmup, reaches a useful basin, then climbs catastrophically under sustained peak LR. The v0.5.0 bisect ruled out learning rate alone, loss-side knobs, hidden-size bump, and phrase-prior conditioning. The remaining suspect is the A1 tokenizer / corpus-v0.4.0 pair, especially transliteration data distribution.

That means the bottleneck is no longer architecture ideation. It is training-system forensics. The next cycle should isolate:

- A1 tokenizer + corpus-v0.3.0
- v0.1 tokenizer + corpus-v0.4.0
- corpus-v0.4.0 with B2 transliteration downweighted or removed
- B2-only gradient norm / loss contribution
- per-source gradient variance
- duplicate or templated synthetic rows
- embedding-frequency skew from the 48K vocab
- effective batch geometry matching full runs

Do not add a learned phrase proposer, span re-reader, larger hidden size, or label expansion until this is stable.

### 5. Synthetic corpus validation catches alignment, not semantics

The substring validator is correctly treated as load-bearing. But it only proves annotated values appear in raw strings. It does not prove the labels are complete, semantically correct, or distributionally sane.

Given v0.5.0 divergence, the synthetic additions need more scrutiny before they become a major training signal:

- cap synthetic mass as a controlled percentage of batches
- stratify DeepSeek rows by template family and script
- add near-duplicate detection
- compare token length, component count, punctuation, and source distribution to real rows
- run semantic spot checks on a sampled batch
- require source-specific gradient/loss dashboards

LLM data is useful here, especially for kryptonite cases, but it should enter as a weighted adversarial curriculum, not as an unexamined corpus expansion.

### 6. Rule-based structural layers must stay bounded

QueryShape and phrase-grouper are justified because they encode structural facts, not gazetteer knowledge. But there is a slippery slope: venue marker lists, street suffix dictionaries, and phrase heuristics can become the same long-tail machinery the project is trying to escape.

The rule should be explicit:

- OK: punctuation, token classes, postcode formats, offset maps, script class, bounded postal formats.
- Be careful: venue markers, street suffix lists, capitalization heuristics.
- Not OK: locality/place dictionaries in pre-classifier structural layers.

If a new phrase-grouper rule needs a large dictionary or a bug-specific exception, it belongs in training data or resolver concordance instead.

## Technical decision review

### Keep

- TypeScript-first runtime with Python-only training.
- ONNX + SentencePiece model packaging.
- Locale-specific weight packages.
- Parse/resolve separation.
- WOF resolver with top-k alternatives.
- Component schema as a guarded contract.
- Rule/neural policy registry.
- JS Viterbi structural mask.
- QueryShape as a cheap prior system.
- Constant-LR verdict smokes and full-run geometry matching.
- Corpus quarantine, source manifests, and eval ledgers.

### Change or tighten

- Make `docs/articles/plan/v0-5-0-shipped.md` the temporary source of truth, then reconcile `TODO.md`, `STAGES.md`, `ARCHITECTURE.md`, and concept pages against it.
- Move from "model F1" gates to "pipeline outcome" gates: parse exact match, top-k resolver recall, graceful failure, and calibration.
- Treat `reconcileSpans` as an integration priority, not a future idea.
- Promote `predict_top_k` from Python training support into TypeScript/browser runtime support.
- Use synthetic data as a controlled slice with explicit weights, not just extra rows.
- Create an explicit "expensive run preflight" checklist that must pass before rented GPU time.

### Defer

- Learned phrase-grouper v0.5.1.
- Span re-reader.
- hidden-size bump.
- Tier 3 label expansion (`attention`, `po_box`, richer POI taxonomy).
- Japan locale validation.
- New resolver backends beyond WOF/BAN experiments.

These are all reasonable future work, but they multiply variables before the current training instability is explained.

## Recommended next steps

### Step 1 - Freeze status and decision surface

Create one operational page:

| Area             | State             | Default?             | Evidence          | Next action                    |
| ---------------- | ----------------- | -------------------- | ----------------- | ------------------------------ |
| QueryShape       | shipped           | yes                  | tests             | keep                           |
| locale-gate      | workspace shipped | not wired in factory | tests             | wire or document stub          |
| phrase-grouper   | shipped rule v1   | yes in factory       | kryptonite tests  | feed into classifier/reconcile |
| top-k classifier | Python scaffold   | no TS runtime        | tests only        | runtime adapter                |
| joint reconcile  | shipped opt-in    | no                   | mocked tests      | integrate behind flag          |
| A1 tokenizer     | trained/evaluated | no stable classifier | byte fallback win | bisect corpus/tokenizer        |
| v0.5 weights     | not shipped       | no                   | divergence        | isolate                        |

This reduces coordination risk immediately.

### Step 2 - Finish the v0.5 divergence bisect

Run the next cheap-but-informative experiments before any full retrain:

1. A1 tokenizer + corpus-v0.3.0, v0.4 stable recipe.
2. v0.1 tokenizer + corpus-v0.4.0, v0.4 stable recipe.
3. A1 tokenizer + corpus-v0.4.0 with B2 transliteration weight capped low.
4. Per-source loss/gradient-norm probe, especially B2 and kryptonite sources.

Decision:

- If A1 + v0.3 trains cleanly, ship tokenizer win without B2 mass and defer transliteration training.
- If v0.1 + v0.4 diverges, corpus composition is the blocker.
- If only A1 diverges, investigate vocab/embedding frequency and maybe reduce vocab or initialize from A0 differently.

### Step 3 - Wire real joint decode behind a feature flag

This is the most important architectural validation.

Target shape:

```text
normalize -> queryShape -> locale -> kind -> phraseProposals
  -> classifierTopK
  -> resolverCandidates
  -> reconcileSpans
  -> resolved top-k output
```

Gate it behind `forceJointReconcile` or similar. Run it against:

- kryptonite catalogue
- golden v0.1.2
- postcode-only/locality-only fast paths
- browser demo fixture set

Compare to current fallback. If joint decode does not beat fallback on kryptonite without hurting normal slices, fix scoring before retraining.

### Step 4 - Build an eval matrix that mirrors product claims

The model should not be judged only as a tagger. Add a report that gives:

- component P/R/F1 by tag
- full parse exact match
- parse-level calibration
- "empty parse" rate
- overconfident wrong rate
- top-1 resolver accuracy
- top-5 resolver recall
- candidate ambiguity surfaced rate
- per-source and per-failure-class breakdown
- rule-only vs neural-only vs hybrid vs joint-decode comparison

This report should become the release gate for any new weights.

### Step 5 - Make synthetic data a curriculum

Keep DeepSeek generation, but route it through explicit curriculum weights:

- start synthetic transliteration at a low batch share
- keep kryptonite rows as high-value adversarial validation and small training slice
- preserve a clean non-synthetic control run
- use source-specific gradient/loss dashboards
- require semantic spot-check sampling before corpus promotion

### Step 6 - Spend only after preflight passes

Before paying for a full expensive validation run, require:

- docs/status freeze complete
- corpus-audit clean
- constant-LR smoke at full effective batch survives beyond the known cliff window
- next bisect identifies or clears tokenizer/corpus destabilizer
- real joint-decode path runs behind flag
- eval matrix produces baseline numbers for fallback and joint paths

Then spend on a full C-train. Not before.

## Where Mailwoman should go

The project should aim to become the TypeScript-native open geocoding front end: parser, structured candidate generator, and resolver interface that can run locally, in a browser, or next to Pelias-like services. It does not need rooftop precision or a universal world model to be valuable. It needs to be:

- easy to deploy
- honest about ambiguity
- cheap enough for browsers and serverless
- retrainable on open data
- calibrated enough that downstream systems can decide when to ask for more context

That direction is coherent. The current architectural work supports it. The next proof must be operational: stable training, real top-k integration, joint reconcile in the default path, and evals that show the whole pipeline improves outcomes rather than only improving isolated components.

## Bottom line

Continue the project. Do not expand scope yet.

The next investment should be a validation sprint:

1. resolve v0.5 divergence,
2. integrate real top-k joint decoding,
3. establish product-level eval gates,
4. then run the expensive train.

The thesis is sound. The expensive part should wait until the pipeline can measure the thesis end-to-end.
