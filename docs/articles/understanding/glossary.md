---
sidebar_position: 6
title: Glossary
---

# Glossary

Every technical term used in this documentation, defined once. Skim it before reading the [`concepts/`](../concepts/README.md) track, or come back when a word is unfamiliar.

## A

**Alignment** — the step in the corpus pipeline that takes a `(raw, components)` pair from an adapter and produces a `(raw, tokens, BIO labels)` row by finding each component's text inside the raw string and labelling the matching tokens. See [`concepts/corpus-construction.md`](../concepts/corpus-construction.md).

**Attention** — the core mechanism inside a transformer encoder. Each token's representation is updated by looking at every other token, with learned weights deciding how much each one matters. Read more in [`concepts/neural-classification.md`](../concepts/neural-classification.md).

**Adversarial corpus** — eval entries chosen specifically to break the parser. Mailwoman's adversarial set covers cases like "Buffalo Buffalo" (a venue named after a city), "St. Petersburg" (multi-word locality), and prefix-honorific names.

## B

**BIO labels** — a labelling scheme where each token gets one of `B-X` (beginning of an `X` span), `I-X` (inside an `X` span), or `O` (outside any span). The 21-label vocabulary in the current model is `O` + 10 components × `{B-, I-}`. See [`concepts/bio-labels.md`](../concepts/bio-labels.md).

**bf16 / bfloat16** — a 16-bit floating point format used during training. Half the memory of fp32 with similar numeric range. Required to fit the training batch on the lab's GPU.

## C

**CRF — Conditional Random Field** — a structured prediction layer that sits on top of per-token model outputs. The CRF rejects label sequences that violate structural rules (e.g. `O` followed by `I-locality` is invalid because an `I-` must follow a matching `B-` or `I-`). See [`concepts/crf-decoder.md`](../concepts/crf-decoder.md).

**Calibration** — how well the model's reported confidence matches its actual accuracy. A well-calibrated model that says "90% confident" should be right 90% of the time. The eval reports include calibration buckets.

**Cartographer** — Mailwoman's mapping utilities. Composes MapLibre style specifications + builds vector source records for the demo's protomaps basemap.

**Checkpoint** — a saved snapshot of the model weights + optimizer state during training. Mailwoman saves a checkpoint every 100 steps so training can resume after the GPU's periodic firmware hang.

**Classification proposal** — the shared shape that every classifier (rule or neural) writes. The solver consumes proposals without knowing which kind of classifier produced them.

**Component / ComponentTag** — one type of address part: `country`, `region`, `locality`, `postcode`, `street`, `house_number`, `venue`, etc. The full union is in `core/types/component.ts`.

**Corpus** — the curated dataset used for training. The current corpus is `corpus-v0.3.0` with 677 million aligned rows.

## D

**Decoder** — in a transformer encoder-decoder model, the part that produces output sequences. Mailwoman's classifier is **encoder-only** (no decoder); the "CRF decoder" is a different thing — a structured-prediction layer that picks the best label sequence from the encoder's outputs.

## E

**Encoder** — the part of a transformer that turns input tokens into contextualized vector representations. Mailwoman's encoder has 6 layers, 4 attention heads, 256 hidden dimensions. See [`concepts/neural-classification.md`](../concepts/neural-classification.md).

**Eval / Evaluation** — running the model against a held-out golden dataset and computing per-component F1, exact-match, calibration, etc. The latest report is the [Stage 2 step-001800 eval](../evals/stage2-step-001800-eval.md).

## F

**F1 score** — the harmonic mean of precision and recall, a single number between 0 and 1 summarizing how good a classifier is at a class. F1 = 2·P·R / (P + R).

**Fine label** — in Mailwoman's vocabulary, the three Stage 2 labels added in v3.0.0: `venue`, `street`, `house_number`. As opposed to **coarse labels** (`country`, `region`, `locality`, `postcode`).

**fp32 / fp16** — 32-bit and 16-bit floating point formats. Mailwoman trains in bf16 (a 16-bit variant) and exports the ONNX model in int8 for size.

## G

**Gazetteer** — a database of named places (countries, regions, cities, neighbourhoods) with their canonical names, coordinates, and IDs. Mailwoman uses [Who's On First](https://whosonfirst.org/) as its gazetteer.

**Golden set** — a hand-labelled evaluation dataset. The current golden set is `v0.1.2` with 4,535 entries (US + FR + adversarial).

**gradient clipping** — a training trick: if the gradient norm exceeds a threshold, scale it down. Stops a single bad batch from blowing up the model weights.

## I

**Iteration log** — the running record of each model release. Lives in [`plan/phases/PHASE_2_training.md`](../plan/phases/PHASE_2_training.md) and is the canonical "what shipped when".

**int8 quantization** — converting model weights from 32-bit float to 8-bit integer. Shrinks the model file ~4x with usually minor accuracy loss.

## L

**Label smoothing** — a training regularization technique. Instead of training to put 1.0 probability on the correct label, train to put `1 - ε` on the correct label and `ε / (N-1)` on each wrong label. Improves calibration. Mailwoman v3.0.0 disabled it (`label_smoothing = 0`) for stability reasons.

**libpostal** — an open-source C address parser used by Pelias. Replaced by Mailwoman v1.

**locale** — the combination of language + country that an address comes from. `en-US` and `fr-FR` are the locales Mailwoman ships weights for.

## M

**macro F1** — the unweighted average of per-class F1 scores. Treats every class equally. Mailwoman's primary eval metric.

**Mermaid** — a markdown-friendly diagram syntax. Used in these docs for flowcharts.

## N

**NAD — National Address Database** — a US Department of Transportation dataset of structured address points. Added to `corpus-v0.3.0` as `usgov-nad`, contributing 57.9 million rows.

**Neural classifier** — Mailwoman's transformer-based classifier (the model). Ships as `@mailwoman/neural` + per-locale weight packages.

**NLL — Negative Log Likelihood** — the standard form of a loss function in probability-based models. `loss = -log P(correct_label | input)`. The CRF uses NLL of the entire sequence.

## O

**ONNX — Open Neural Network Exchange** — a portable model file format. Mailwoman exports the trained PyTorch model to ONNX so it can be loaded by `onnxruntime-node` (server) and `onnxruntime-web` (browser) with the same file. See [`concepts/onnx-runtime.md`](../concepts/onnx-runtime.md).

**Orphan-I** — a label sequence bug where `I-X` appears without a matching preceding `B-X` (e.g. `O, I-locality`). Structurally invalid in BIO. The CRF prevents this. See [`concepts/bio-labels.md`](../concepts/bio-labels.md).

## P

**Pelias** — an open-source geocoder, Mailwoman's spiritual predecessor. See [From Pelias to Mailwoman](./from-pelias-to-mailwoman.md).

**Per-token argmax** — picking the highest-probability label at each position independently. Fast and simple but can produce structurally invalid sequences. The opposite of Viterbi.

**Postcode** — the country-specific postal code (US ZIP, FR code postal, etc.). Mailwoman handles postcode parsing entirely by rule classifier — it is a regex problem, not an ML problem.

**Policy registry** — the per-component table that decides which classifier (rule or neural) has authority for each address component. The Ship-of-Theseus dial.

## R

**Rule classifier** — a hand-written piece of code that labels tokens by pattern matching. The Mailwoman v1 approach. See [`concepts/rule-based-classifiers.md`](../concepts/rule-based-classifiers.md).

**Resolver** — the post-parse step that takes labelled components and looks them up in a gazetteer to return coordinates. See [`concepts/resolver-and-wof.md`](../concepts/resolver-and-wof.md).

## S

**SentencePiece** — Google's subword tokenizer library. Mailwoman uses it to split input text into a fixed 16,000-piece vocabulary that handles both English and French (and falls back to byte-level for everything else). See [`concepts/tokenization.md`](../concepts/tokenization.md).

**Ship of Theseus** — the migration pattern Mailwoman uses: replace rule classifiers with neural one component at a time, only when metrics justify. Name from the [philosophical thought experiment](https://en.wikipedia.org/wiki/Ship_of_Theseus).

**Shard** — a partial output file of the corpus build, written in Parquet format. The training pipeline streams shards row-by-row.

**SQLite-wasm** — an open-source build of the SQLite library compiled to WebAssembly. Mailwoman uses it to run the WOF resolver inside the browser.

**Span** — a contiguous range of characters in the input string. The basic unit of address parsing.

**Stage 1 / Stage 2** — internal versioning of which label classes the model emits. Stage 1 is the 4 coarse components (and a few near-coarse). Stage 2 adds `venue`, `street`, `house_number`. Stage 3 (future) would add `attention`, `po_box`, and POI venue subtyping.

## T

**Token** — one word or subword in the tokenized input. For the neural classifier, tokens come from SentencePiece (subword units). For the rule classifiers, tokens are whitespace-and-punctuation-separated words.

**Tokenizer** — the component that splits an input string into tokens. The neural classifier ships its own (SentencePiece, learned from the corpus); the rule classifiers use Mailwoman's hand-written word tokenizer.

**Transformer** — a neural network architecture invented in 2017 ("Attention Is All You Need"). The basis of every modern NLP model from BERT to GPT-4. Mailwoman uses a small, encoder-only transformer. See [`concepts/neural-classification.md`](../concepts/neural-classification.md).

**TIGER** — US Census topographically-integrated geographic database. Used as a corpus source for street-segment data.

## V

**Viterbi** — an algorithm that finds the highest-probability label sequence under a CRF's transition constraints. The CRF's "decode" operation. Replaces the per-token argmax with something structurally valid.

## W

**WOF — Who's On First** — an open gazetteer of named places, maintained by SFO Museum. Mailwoman uses a SQLite distribution as its primary gazetteer. See [`concepts/resolver-and-wof.md`](../concepts/resolver-and-wof.md).

**Warmup** — the early phase of training where the learning rate ramps up from 0 to its peak value. Mailwoman uses 1,000 steps of linear warmup, then cosine decay.

**Weights package** — the npm package that ships the trained model file: `@mailwoman/neural-weights-en-us`, `@mailwoman/neural-weights-fr-fr`. Versioned independently from the runtime.
