# Architecture

## System shape

```
┌─────────────────────────────────────────────────────────────────┐
│                         Mailwoman SDK                            │
│                                                                  │
│   ┌──────────────────┐   ┌────────────────────────────────┐     │
│   │  Tokenization    │──▶│  Classifiers (rule + neural)   │     │
│   │  (existing)      │   │                                │     │
│   └──────────────────┘   │  ┌──────────────────────────┐  │     │
│                          │  │ rule: house_number       │  │     │
│                          │  │ rule: postcode           │  │     │
│                          │  │ rule: street_prefix      │  │     │
│                          │  │ rule: whos_on_first      │  │     │
│                          │  │ ...                      │  │     │
│                          │  │                          │  │     │
│                          │  │ neural: NeuralSequence   │──┼──┐  │
│                          │  └──────────────────────────┘  │  │  │
│                          └────────────────────────────────┘  │  │
│                                       │                       │  │
│                                       ▼                       │  │
│                          ┌────────────────────────────────┐  │  │
│                          │  ClassifierPolicy (per-tag)    │  │  │
│                          └────────────────────────────────┘  │  │
│                                       │                       │  │
│                                       ▼                       │  │
│                          ┌────────────────────────────────┐  │  │
│                          │  Solver (existing)             │  │  │
│                          │  ExclusiveCartesianSolver +    │  │  │
│                          │  filters + augmenters          │  │  │
│                          └────────────────────────────────┘  │  │
│                                       │                       │  │
│                                       ▼                       │  │
│                          ┌────────────────────────────────┐  │  │
│                          │  Ranked Solutions              │  │  │
│                          └────────────────────────────────┘  │  │
│                                                               │  │
└───────────────────────────────────────────────────────────────┼──┘
                                                                │
                          ┌─────────────────────────────────────┴──┐
                          │  @mailwoman/neural (new package)       │
                          │                                        │
                          │  ┌──────────────────────────────────┐  │
                          │  │  NeuralSequenceClassifier        │  │
                          │  │  - lazy-loads ONNX model         │  │
                          │  │  - SentencePiece tokenizer       │  │
                          │  │  - emits ClassificationProposal  │  │
                          │  └──────────────────────────────────┘  │
                          │              │                          │
                          │              ▼                          │
                          │  ┌──────────────────────────────────┐  │
                          │  │  Weights packages (per locale)   │  │
                          │  │  @mailwoman/neural-weights-en-us │  │
                          │  │  @mailwoman/neural-weights-fr-fr │  │
                          │  │  @mailwoman/neural-weights-ja-jp │  │
                          │  └──────────────────────────────────┘  │
                          └────────────────────────────────────────┘
```

## Monorepo layout

```
packages/
  core/                      # existing — tokenization, span/section/phrase, classifier base
  classifiers/               # existing rule classifiers — pulled out of core for clarity
  neural/                    # NEW — ONNX runtime + SentencePiece + sequence classifier
  neural-weights-en-us/      # NEW — ONNX model weights for US English
  neural-weights-fr-fr/      # NEW — ONNX model weights for FR French
  corpus/                    # NEW — TS adapters, alignment, synthesis, Parquet output
  corpus-python/             # NEW — Python training pipeline, NOT published to npm
  studio/                    # FUTURE — Phase 5 web UI for human correction
sdk/                         # existing — public consumer API
server/                      # existing — HTTP service
cli.ts                       # existing
```

The split between `neural/` (runtime) and `neural-weights-*/` (data) is deliberate. Users running US-only deployments should not download French weights. Weights packages are versioned independently from the runtime.

## Key abstractions

### `ComponentTag`

The canonical union of address component types. Defined in `reference/SCHEMA.md`. Single source of truth. Adding a tag requires a written rationale.

### `ClassificationProposal`

The shape every classifier produces. Replaces the current ad-hoc shape used by rule classifiers. See `reference/INTERFACES.md`.

```ts
interface ClassificationProposal {
	span: Span
	component: ComponentTag
	confidence: number // 0..1
	source: "rule" | "neural" | "merged"
	source_id: string // 'house_number' for rule, 'neural-v0.3-en-us' for neural
	penalty: number
	metadata?: Record<string, unknown>
}
```

Existing rule classifiers wrap their output in this shape. Neural classifier emits the same shape. The solver does not distinguish.

### `ClassifierPolicy`

Per-component configuration that decides which classifier(s) get authority for that component. This is the Ship of Theseus dial.

```ts
interface ClassifierPolicy {
	component: ComponentTag
	mode: "rule_only" | "neural_only" | "both" | "neural_preferred" | "rule_preferred"
	confidence_threshold?: number
	locale?: string // policy can vary per locale
}
```

Default policy is `rule_only` for everything until neural is shipped. Migration happens one component at a time, gated on golden-set metrics.

### `LocaleProfile`

Encapsulates locale-specific behavior: which weights package to load, which rule classifiers apply, which synthesis rules govern training data generation.

```ts
interface LocaleProfile {
	locale: string // 'en-US', 'fr-FR', 'ja-JP'
	weightsPackage: string // npm package name
	ruleClassifiers: string[] // identifiers of rule classifiers active for this locale
	componentsSupported: ComponentTag[] // not every locale supports every tag (e.g. JP has no `street`)
	policy: ClassifierPolicy[]
}
```

## Locale strategy

Locales are first-class. The system does not assume English. Every classifier (rule or neural) declares which locales it serves.

- A US-only deployment loads `en-US` profile, English rule classifiers, US weights.
- A multi-locale deployment loads all configured profiles. Locale detection per input is a separate concern handled by a `LocaleDetector` (Phase 2 work; v0 can require explicit locale).
- New locale = new `LocaleProfile` + new weights package + (optionally) new rule classifiers. Core code does not change.

## Inference path

```
input string
     │
     ▼
Tokenization (existing Mailwoman code)
     │
     ▼
For each Section:
     │
     ├──▶ Rule classifiers produce ClassificationProposals
     │
     ├──▶ NeuralSequenceClassifier (if locale supports it):
     │       1. Tokenize section with SentencePiece (WASM)
     │       2. Run ONNX inference via onnxruntime-node
     │       3. Decode BIO labels back to character spans
     │       4. Emit ClassificationProposals
     │
     ▼
ClassifierPolicy filter:
     For each component, keep only proposals from authorized classifiers
     │
     ▼
Existing ExclusiveCartesianSolver
     │
     ▼
Ranked solutions
```

## Training path (Python, internal)

```
Source data (OSM, WOF, BAN, OpenAddresses, government registries)
     │
     ▼ TypeScript adapters (corpus/adapters/*.ts)
Canonical rows: { raw, components, country, source, source_id }
     │
     ▼ Alignment (corpus/align.ts)
BIO-labeled rows: { raw, tokens, labels, country, source, source_id }
     │
     ▼ Synthesis (corpus/synthesize.ts)
Augmented rows: + case variants, abbreviations, typos, ordering perturbations
     │
     ▼ Parquet shards (versioned)
corpus-vX.Y.Z/{train,val,test}-*.parquet
     │
     ▼ Python training (corpus-python/)
HuggingFace Transformers + PyTorch
     │
     ▼ ONNX export + int8 quantization
neural-weights-{locale}/model.onnx + tokenizer.model
     │
     ▼ Eval on golden set
If golden_F1 >= threshold: publish
```

## Model architecture (what the neural classifier IS)

**Family: encoder-only transformer + per-token classification head.** Standard NER (named entity recognition) shape. Each token of the input address string gets exactly one BIO label from a fixed set (`O` + `B-<tag>` + `I-<tag>` for each tag in the `ComponentTag` union — currently 47 labels = 1 + 2 × 23 tags).

### Why this family, not the others

| Family                                                                        | Used for                                                        | Why not us                                                                                                                         |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Encoder-only + classification head** (BERT / RoBERTa / DeBERTa + NER heads) | Per-token tagging; same number of output labels as input tokens | **This is us.** Address parsing is a tagging problem, not a generation problem.                                                    |
| Encoder-decoder (T5, BART)                                                    | Seq2seq — translation, summarization                            | The output isn't a different sequence; it's structured tags per input token. Encoder-decoder is overkill and lossy for this shape. |
| Decoder-only (GPT, Llama)                                                     | Autoregressive generation                                       | We annotate, we don't generate. A decoder LLM could approximate via constrained decoding at 1000× the cost.                        |
| Conditional random field (CRF)                                                | Pre-transformer per-token tagging with Markov features          | This is libpostal. We're replacing the CRF with a transformer encoder in front of an effectively-similar tag space.                |

### Concrete config (Phase 2 / issue #10)

- **Backbone**: HuggingFace `BertForTokenClassification` with custom small config — **6 layers, 256 hidden dim, 4 attention heads, 1024 FF intermediate, max position 128.** Trained **from scratch** (not fine-tuned from a pretrained English-internet BERT — the address vocabulary is too narrow and too unlike natural language for that pretraining to help).
- **Tokenizer**: SentencePiece (unigram), `vocab_size=16000`, `character_coverage=0.9995`, `byte_fallback=true`. Trained on the corpus, not picked off the shelf. Tokenizer version is locked into corpus version.
- **Output head**: linear projection → 47 logits per token (the BIO label space derived from `ComponentTag`).
- **Inference**: softmax over labels, take argmax per token, decode BIO spans back to character offsets via SentencePiece's offset map, emit `ClassificationProposal` per span with mean per-token softmax probability as confidence.
- **Size target**: < 30 MB int8-quantized ONNX, < 40 MB including tokenizer. Total parameter count in the low millions.
- **Runtime**: `onnxruntime-node`, CPU execution provider default, no Python at inference time.

### The cousin: spaCy's `ja_core_news_trf`

The closest commercial reference point is spaCy's [Japanese transformer pipeline](https://spacy.io/models/ja#ja_core_news_trf):

|                       | spaCy `ja_core_news_trf`                                                                 | mailwoman planned                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Backbone              | `cl-tohoku/bert-base-japanese-char-v2` (BERT-base — 12 layers, 768d)                     | small BERT (6 layers, 256d) — ~10× smaller                                                       |
| Vocab                 | 6,144 char-level (Japanese requires character-level for OOV handling)                    | 16,000 SentencePiece (multilingual; bytes fall back for OOV)                                     |
| Pretrained            | Yes (Tohoku-Univ. Inui Lab BERT)                                                         | No (from scratch on address corpus)                                                              |
| Task heads            | **3** on shared encoder: morphologizer (POS), parser (dependency), NER (22 entity types) | **1** on dedicated encoder: NER for 23 address component types                                   |
| Model size            | 320 MB                                                                                   | < 40 MB int8                                                                                     |
| NER F1 (their domain) | 83.31 ENTS_F on general Japanese NER                                                     | TBD; the rule baseline is > 95% on `country` / `region` for the golden set, so the floor is high |
| Inference runtime     | Python (spaCy)                                                                           | Node (`onnxruntime-node`)                                                                        |
| License               | CC BY-SA 3.0                                                                             | AGPL-3.0                                                                                         |

spaCy validates the family choice — when the industry-standard NER toolkit's flagship Japanese model is BERT-encoder + token-classification head, we're in the right shape. The trade-offs we make vs them:

- **Smaller** (10× fewer parameters): we're a narrower task. General-purpose Japanese NER must handle 22 entity types across all of news text; address parsing handles 23 component types in addresses only. Narrow task tolerates narrower model.
- **From scratch, not fine-tuned**: their cl-tohoku backbone was pretrained on Japanese Wikipedia + news. Our domain is far enough from natural-language text that the pretraining transfer is weak; training from scratch on a domain-pure corpus gets us a smaller, faster, more accurate model.
- **Single head, not multi-head**: they share one encoder across morphologizer + parser + NER. We have one head only — the encoder can fully specialize for component disambiguation. (Multi-head is a future extension: see below.)

### Multi-head extension (Phase 4+)

The spaCy pipeline pattern — one shared encoder + multiple task heads — is a powerful future direction. Candidates if/when we want them:

- **Venue vs address-part head**: a binary classifier per token to help compositional disambiguation (`Buffalo Health Clinic Buffalo NY` — is "Buffalo" venue-token or locality-token?). Useful for [[project-mailwoman-bitter-lesson]]'s kryptonite cases.
- **Locale detection head**: predicts `en-US` vs `fr-FR` vs `ja-JP` for the whole input, lets `LocaleDetector` (currently a separate concern) ride the same encoder.
- **Completeness head**: predicts whether the input is a complete address, a fragment, or noise — feeds graceful-failure signaling per [[project-mailwoman-graceful-failure]].
- **Confidence head**: a separate calibration learner trained on held-out data, replacing the per-token softmax with a calibrated probability.

None of these are Phase 0–3 scope. Filed for Phase 4 territory or beyond. spaCy's existence is the evidence the pattern works at scale.

### Frameworks + tooling stance — what we use, what we don't, what we steal

**Use**: HuggingFace Transformers + PyTorch for training (Python-only, single-shot, output is the ONNX file). `onnxruntime-node` for inference (TypeScript / Node, the user-facing path). SentencePiece for tokenization on both sides. `@dsnp/parquetjs` (patched — see `.yarn/patches/` in the repo) for corpus output. That's the production stack — anything not on this list is either dead weight or duplicative.

**Don't use**: spaCy as a dependency, either runtime or training. Reasons:

- **Runtime**: spaCy is Python-only. The plan's "TypeScript-first" stance is a hard constraint from the epic; adding Python at inference time defeats the deployment-regression-for-Node-users argument that's the project's reason to exist. spaCy's ONNX export path (`spacy-onnx-export`) exists but is rarely production-grade.
- **Training**: spaCy's config-driven training is nice (`spacy.cfg` + `Thinc`) but pays off mostly when pipeline composition matters or the task is novel. Our task — single-head NER on `BertForTokenClassification` — is the most-trodden path in HuggingFace Transformers. spaCy adds an abstraction layer for marginal convenience. Operator's "less Python the better" stance argues against it even for training where Python is unavoidable.

**Steal the patterns, not the tool**:

| What                                                                                                                 | From                                                                                                                                                  | Where to apply                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Release notes template (label scheme table + transformer config block + per-component F1 + compatibility matrix)     | spaCy's GitHub release format for models like [ja_core_news_trf-3.7.0](https://github.com/explosion/spacy-models/releases/tag/ja_core_news_trf-3.7.0) | Phase 3 (#11) `@mailwoman/neural-weights-*` package READMEs + model card JSON           |
| Eval reporting conventions (per-component P/R/F1 + confusion matrix layout, `displaCy`-style visualization patterns) | spaCy benchmark reports                                                                                                                               | Phase 2 (#10) eval reports                                                              |
| "Training described entirely by a config file, code is just the runner" hygiene                                      | spacy.cfg pattern                                                                                                                                     | `corpus-python/train.py` config shape — adopt the pattern without taking spaCy as a dep |
| Vintage / language-model-version conventions                                                                         | spaCy's `ja_core_news_trf-3.7.0` naming (`<lang>_<domain>_<size>_<framework>-<version>`)                                                              | Weights package versioning + ONNX file naming                                           |

**Optional Phase 3 baseline comparison**: run a fine-tuned `xx_ent_wiki_sm` or `en_core_web_trf` against the same golden set, report comparison numbers in the model card. General NER tagging `LOC` / `ORG` where we expect `locality` / `venue` is informative — shows the address-specific gain over general NER. Operator-time, ~1 hour for an honest baseline run. Not in the install dependency tree; one-off comparison only.

### Casual descriptions (for audiences who don't want the architecture deep-dive)

- **Technical**: "Small encoder-only transformer (BERT-class, from scratch, ~few-million params, less than 40 MB int8 ONNX), per-token classification head emitting BIO-tagged address-component spans. Runs in Node via onnxruntime-node, no Python at inference."
- **Practitioner**: "Tiny BERT-class NER model specialized for address parsing — a learned replacement for libpostal's CRF, sized to fit in a Node process. Architecturally the same family as spaCy's ja_core_news_trf, ~10× smaller because the task is narrower."
- **User-facing**: "A small ONNX model that reads an address string and tells you, with per-component confidence, what each piece of it means."
- **For the bitter-lesson audience**: "The contextual-parser half of a contextual-parser-plus-constraint-solver geocoder front-end. The transformer proposes; the policy registry + solver dispose."

Notably NOT: a translator (no language pair, no autoregressive output). Not a generative model.

## Training cadence vs. plan (2026-05-18 reframing)

The original phase plan (`phases/PHASE_2_training.md`) targeted a **single training run hitting >95% per-component F1** in ~2 weeks. Two iterations in, that framing has been replaced by an **iteration cadence**: each cycle is ~3-7 days of focused work (corpus refinement → train 6-10h GPU → eval → ship), and each cycle produces a shippable artifact even if it doesn't hit the >95% bar.

Why the change:

- **>95% F1 in one shot was aspirational.** Address parsing from scratch on a noisy real-world corpus is harder than that target acknowledged. Real ship gates are lower (~0.85 F1 on coarse components is genuinely useful in production with proper calibration).
- **Shipping below-target IS the bitter-lesson framing.** Per [[project-mailwoman-graceful-failure]], the success metric is graceful failure, not max F1. A 0.85-F1 model with 0.88 calibration in its conf>0.9 bucket is more useful than a 0.95-F1 model with 0.33 calibration (the v0.1.0 situation).
- **Ship-of-Theseus coexistence makes shipping safe.** The neural classifier adds proposals alongside the rule classifiers via the policy registry; we don't have to wait for parity to start using it.
- **Iteration > single-run.** Each cycle produces real artifacts: ONNX weights, model card, eval report, npm package shape, demo updates. Compounding wins.

### Iteration history (live)

| Iteration                                                                           | Scope                                                                                                                                                                                                                                            | Wall-clock                              | Outcome                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v0.1.0**                                                                          | First Tier 1 ship; sequential-data overfit due to corpus imbalance                                                                                                                                                                               | ~3 days                                 | Honest below-target ship; F1 ~0.03 macro, calibration 0.33 (confidently wrong)                                                                                                                                                                                                                                                            |
| **v0.2.0**                                                                          | `source_weights` mechanism + relaxed coarse gate (Phase 2 §6 recipe)                                                                                                                                                                             | ~3 days                                 | **9× macro-F1** (0.037 → 0.335); **calibration tightened 2.6×** (0.33 → 0.88 in conf>0.9 bucket); still below 95% targets but ship-worthy                                                                                                                                                                                                 |
| **v0.3.0 → v3.0.0** (shipped 2026-05-22)                                            | Tier 2 label expansion (`B/I-venue`, `B/I-street`, `B/I-house_number`) + linear-chain CRF decoder + dual loss (CE + 0.05·CRF NLL) + corpus rebuild adding NAD (57.9M) → 677M aligned rows. npm major-bumped from 2.0.6 → 3.0.0.                  | ~1 day (overlap with adapter+demo work) | macro F1 0.32 on golden v0.1.2 (4,535 entries); capability-surface win (`house_number` 0.78, `venue` 0.39, `street` 0.27); **coarse F1 regressed** (region 0.83 → 0.18) — under-trained at step-1800 ship + label-space dilution. CRF makes orphan-`I-*` decode structurally impossible (Saint Petersburg fix verified on the live demo). |
| **v0.4.0** (next — [#116](https://github.com/sister-software/mailwoman/issues/116)) | Recover the coarse-F1 regression + meet #57 fine floors + harden the dual loss. Per-token CRF NLL norm, longer training (step-5000+), class-weighted CE, source-weight rebalance, JS-side Viterbi + vocab-from-model-card. Reuses corpus-v0.3.0. | ~3-5 days                               | Targets: coarse F1 back to ≥0.6 region/locality + ≥0.7 postcode; `venue` ≥0.6, `street` ≥0.7 (the #57 floors); calibration ≥0.85; training runs to step 10K+ without divergence.                                                                                                                                                          |
| **v0.5.0+**                                                                         | Tier 3 organization/POI venue + top-k decoding for Resolver                                                                                                                                                                                      | ~5-7 days                               | Deferred until v0.4.0's coarse recovery lands                                                                                                                                                                                                                                                                                             |
| **Phase 3 (Integration & Ship)** runs in parallel with iterations                   | npm publish pipeline, @mailwoman/neural SDK glue                                                                                                                                                                                                 | ~5-7 days                               | `@mailwoman/neural@0.x.y` on npm                                                                                                                                                                                                                                                                                                          |
| **Phase 4 (Resolver)**                                                              | Source annotations, top-k disambiguation, gazetteer lookup                                                                                                                                                                                       | Deferred                                | Operator-gated                                                                                                                                                                                                                                                                                                                            |

### Why more data doesn't blow up the iteration cost

A single training run is fixed-step-count, not fixed-epoch. v0.2.0's 50K steps × 128 effective batch = 6.4M examples seen ≈ **2.4% of the 263M-row corpus per pass**. Adding NAD (62M) + OA-CA (10M) + state backfills bumps the corpus to ~340M rows; same 50K steps still finishes in ~6.5-10h. The model is nowhere near training-data-limited; more corpus → more diversity per example seen, not more wall-clock.

What ACTUALLY costs more time per iteration:

1. **Vocabulary tier expansion** — adding venue/street/house_number labels requires adapter alignment updates (every adapter's `align.ts` emits the new labels where source data supports it) + golden set verification + corpus rebuild (~260 min). This is the bulk of v0.3.0 work.
2. **CRF decoder + label smoothing** — small training-time additions, big calibration/coherence wins, lands in the same retrain.
3. **Per-iteration golden expansion** — already automated via `expand-golden.ts` + `promote-golden.ts` (PR #48 / #49); each iteration can re-eval against the latest golden version.

### Re-framed success metric per iteration

Not "did F1 hit 95%" but "is the artifact independently shippable and a measurable improvement over the prior iteration?" The eval ledger at `evals/scores-by-version.json` makes this empirical — every shipped run gets a row, with corpus + eval-set sha-pinning so the deltas are honest apples-to-apples.

## Why this shape

- **Classifier-as-plugin** preserves Mailwoman's existing extensibility. New rule classifiers, new neural variants, future learned rankers all conform to the same interface.
- **Per-component policy** allows incremental rollout without big-bang risk. A regression in neural `street` parsing doesn't affect `country` parsing.
- **Locale profiles** prevent the architecture from quietly Anglocentric-by-default. If the abstractions can't express a non-Anglo locale cleanly, we fix the abstractions, not the locale.
- **Separate weights packages** keep npm install times sane and let users opt in to languages they need.
- **Training in Python, inference in TS** uses each ecosystem for what it's best at and avoids the dual-language maintenance tax in production code.

## Output shape (Phase 3 concern, not Phase 2)

The neural model emits per-token BIO labels regardless of how its output is presented. The DECODER chooses the format. Three legitimate shapes, in increasing expressivity:

| Shape                                                            | Preserves                                                      | Loses                                         | Round-trip fidelity                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **JSON object** `{locality: "Paris", postcode: "75005"}`         | tag → value                                                    | order, repetition, hierarchy, untagged tokens | Country-specific formatter required; reorder errors are silent. Libpostal/Pelias compatible.                                              |
| **Tuple array** `[["locality", "Paris"], ["postcode", "75005"]]` | tag → value + **original order** + repetition                  | hierarchy                                     | Reconstruction is `array.map(([_, v]) => v).join(" ")`; trivially faithful to ordering.                                                   |
| **S-expression** `(locality "Paris" (postcode "75005"))`         | order + **hierarchy** + arbitrary attributes (`:conf`, `:src`) | nothing material                              | The most expressive — lets the parsed output say "this postcode is INSIDE this locality." Natural carrier for Phase 4 source annotations. |

**Operator framing (2026-05-18):** address parsing is inherently lossy — you can't extract the original formatted address from the parsed result. The closest you can get is by applying a formatter to the parsed result. S-expressions may better preserve the original shape because they encode hierarchy + ordering + attributes in one tree.

**Implementation plan (Phase 3, #11):** ship all three decoders behind a `--format json|tuple|sexp` CLI flag. Default = JSON for libpostal-compat; S-expr as power-user mode. Round-trip eval (`parse(format(parse(raw))) == parse(raw)`) tells us which shape preserves the most fidelity; if S-expr wins, flip default.

**No model retraining required.** This is post-processing on the BIO output. The same neural model serves all three formats.

**Existing isp-nexus formatter** (`isp-nexus/universe/mailwoman/postal/formatting.ts`) handles flat-object → multi-line-string for shipping-label rendering. Port it as the JSON-decoder's inverse direction; build a separate `sexp→string` formatter for the S-expr path.

## Source attribution (Phase 4 — #12, deferred)

Differentiator vs libpostal and Pelias. Libpostal says "this token is a city"; Pelias adds hit/miss provenance against ES indexes. **Mailwoman's goal** (operator framing): "this token is a locality identified by the wof-admin gazetteer with 0.97 confidence."

The corpus already carries `source` per-row (every alignment + augmentation tags provenance). What's missing is propagating that provenance through the inference output.

**Decision (operator, 2026-05-18): hybrid Option C — model + Resolver.**

- Model emits BIO labels + per-token confidence (already does)
- Resolver at inference time maps `(span, label) → (source-class, src-conf)` via fast lookups against pre-indexed gazettes (wof, ban, tiger, nppes, hrsa, imls-pls, state-\*)
- Output annotations live as S-expression attributes:

```
(locality "Paris" :src wof-admin :conf 0.97
  (postcode "75005" :src wof-postalcode :conf 0.93))
```

### Key insight: provenance is already flowing through training

`source_weights` (shipped 2026-05-18 in PR #44) affects what the trained model emphasizes during training even though the model itself doesn't emit source labels. The Resolver at inference time **surfaces** what was implicit in training. The data path:

```
corpus row (source-stamped)
   → source_weights filter at data loader
   → training distribution (model internalizes source priors)
   → model emits BIO + confidence (no source field)
   → Resolver looks up labeled spans against gazettes
   → output: BIO + label + confidence + source-class + src-conf
```

### Rejected alternatives

- **Resolver-only at inference, no source-aware training** — model has no internal calibration toward gazette-confirmed tokens; weaker.
- **Multi-task neural head** emitting `(label, source-class)` per token — ~15 × 8 = 120 sub-classes; bigger model, harder to retrain, loses the clean separation between span-identification (model job) and provenance (Resolver job).

## Anti-patterns to avoid

- ❌ A `mode: 'auto'` setting in `ClassifierPolicy` that "intelligently" picks rule vs neural. Hidden state, hard to debug. Always explicit.
- ❌ Hardcoding `'en-US'` as default in core. Default should be "no locale, classifiers must opt in."
- ❌ Loading all weights at module init. Lazy-load on first classification request.
- ❌ Mixing inference and resolution. The parser does not know about coordinates, place IDs, or WOF resolution. That's Phase 4.
- ❌ Adding tags to `ComponentTag` without updating the schema doc and the alignment logic in the same commit. Schema drift kills the corpus.
