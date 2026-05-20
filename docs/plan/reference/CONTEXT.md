# Context

## What Mailwoman is today

Mailwoman is a fork of `pelias/parser`, written in TypeScript. It is a rule-based natural language classification engine for geocoding. Input: an address string. Output: a list of solutions, each a set of `{ component, confidence, offset, penalty }` spans.

Architecture: tokenization (sections → words → phrases) → classification (dictionary/regex/composite classifiers populate a graph) → solving (`ExclusiveCartesianSolver` enumerates valid permutations, additional solvers filter and augment).

Output example for `"Mt Tabor Park, 6220 SE Salmon St, Portland, OR 97215, USA"`:

```ts
;[
	{ venue: "Mt Tabor Park", confidence: 0.8, offset: 0, penalty: 0 },
	{ house_number: "6220", confidence: 0.9, offset: 15, penalty: 0 },
	{ street: "SE Salmon St", confidence: 0.98, offset: 20, penalty: 0 },
	{ locality: "Portland", confidence: 1, offset: 34, penalty: 0 },
	{ region: "OR", confidence: 1, offset: 44, penalty: 0 },
	{ postcode: "97215", confidence: 1, offset: 47, penalty: 0 },
	{ country: "USA", confidence: 0.9, offset: 54, penalty: 0 },
]
```

The shape — per-component confidence + character offset + penalty — is unusually good for ML integration. A token-classification model's natural output is essentially this. We are not adapting a model to fit a foreign output shape.

## What the field looks like

- **libpostal** (C, CRF) — the de-facto baseline. 99.45% claimed parse accuracy on held-out data. Trained on OpenStreetMap. Mostly stagnant since ~2018.
- **Deepparse** (Python, Seq2Seq BiLSTM) — academic, fine-tunable, slower than libpostal, >99% component accuracy. Active.
- **Pelias Parser** (JS, rule-based) — our upstream. Explicitly rejects black-box ML in favor of debuggable rules. Active.
- **Airmail** (Rust, tantivy-based geocoder) — sidesteps parsing entirely by treating it as an IR problem. 376 stars, single-maintainer, planet-scale for ~$5/month. Worth studying.
- **Transformer-based parsers in academic literature** — Guermazi et al. 2024 shows transformers beat libpostal on noisy/multilingual data. Not productized.

The gap: there is no widely adopted neural address parser shipped as a library. Everyone either uses 2018-era CRF (libpostal) or rolls their own.

## Why neural, why now

Three reasons rules hit a ceiling:

1. **Ambiguity that needs context.** "Paris Texas" vs "Paris, Texas" vs "Paris, France." Rules need explicit comma logic; a model learns context.
2. **Internationalization without rule explosion.** Every country's rule set is bespoke maintenance. A model trained on country-tagged data generalizes.
3. **Graceful degradation on novel input.** Rules either match or don't. A model produces probabilities, enabling confidence-weighted decisions in the solver.

But rules win in three places:

1. **Postcodes.** A US ZIP is a regex. A model is wasted capacity.
2. **Explicit dictionaries.** Country names, state abbreviations — lookups are perfect and instant.
3. **Debuggability.** When a rule misclassifies, you can read the rule. When a model misclassifies, you train on more data and hope.

Hence Ship of Theseus: migrate component-by-component, gated on metrics, never flip a single "neural on" switch.

## Why TypeScript-first

Mailwoman's users are in the Node ecosystem. A Python or Rust dependency is a deployment regression for them. ONNX Runtime has a stable Node binding (`onnxruntime-node`) with CPU + CUDA execution providers. SentencePiece has WASM builds. The full inference path runs in a Node process without spawning subprocesses or shelling out.

Training stays in Python because the ecosystem (HuggingFace Transformers, PyTorch, the `datasets` library, ONNX export tooling) is unmatched. The training code is internal to the project and never published to npm.

## Why US + France first

- **US:** the maintainer's home market, rule classifiers are already strong here, easiest to A/B against.
- **France:** non-Anglo, non-trivial grammar (particles `de la`/`du`/`des`, CEDEX postal routing, arrondissement notation), official open data (BAN) that's first-class, and uses Latin script so we don't yet need to solve tokenizer vocabulary problems.

If the architecture handles FR cleanly, it will handle DE/IT/ES/PT trivially.

## Why Japan as the validation milestone

Japanese addressing is structurally different from Western addressing: no streets, nested blocks (chōme/banchi/go), written right-to-fine-grained. If the schema, classifier interface, and policy system survive JP without core refactor, the architecture is sound. If they don't, we learn it in Phase 6 and not in production five years from now.

## The bitter lesson, applied to address parsing

The project's design intent originated in Richard Sutton's "Bitter Lesson" essay. The thesis applied here: rule-based classifiers + Cartesian solvers approximate a human's address-parsing intuition with hand-crafted machinery; given sufficient corpus, a language model approximates that intuition directly — and outperforms — without the scaffolding.

The canonical short-form, from the operator's "Paris, Texas" talk (PeerTube: `peertube.openstreetmap.fr` video `e776d210-f857-4df2-83a7-4414fd52f6f2`, slide 19):

> A geocoder is a **contextual parser + constraint solver**. Not a tokenizer. Not a dumb database lookup.

The neural model is the contextual-parser part. The constraint solver still has a role — it weighs which hierarchy interpretation is consistent (see the Arc-de-Triomphe disambiguation in slides 12→13 of that talk). The "dumb database lookup" pattern is what's being deprecated.

The current `ExclusiveCartesianSolver` inherited from Pelias is what slide 17 calls "Sparkling Bogosort":

> "It's only 'Cartesian permutation' if your gazetteer comes from France. Otherwise it's just 'Sparkling Bogosort'."

France's BAN gives enough constraint that the permutation reduces to a small set; everywhere else it's randomly trying combinations and squinting at which one looks valid. The `PolicyRegistry` (see `reference/INTERFACES.md`) is the mechanism by which this gets phased out, component-by-component — the Ship-of-Theseus migration referenced above.

### Adversarial / kryptonite cases the corpus must include

Slide 14 of the talk's "programming noir" debug list, plus operator additions:

- `Buffalo Health Clinic Buffalo, New York` — venue name overlaps with locality token
- `New York, New York Steakhouse, Las Vegas, Nevada` — venue contains a place-shaped sub-string, then a real address follows
- `Paris Texas` vs `Paris, Texas` vs `Paris, France` — punctuation + context disambiguates
- `St. Petersburg, Russia` — `St.` is "Saint" not "Street"
- `P'tit St. Denis' Street Café` — apostrophe-contracted French (`P'tit` for `Petit`) layered onto the St./Saint/Street ambiguity
- `Saint-Denis` vs `Saint Denis` vs `St. Denis` — same place, three orthographies; the model must learn the alternation, not pick a canonical and reject the rest

These are not noise. They are the inputs a model must learn to handle, and the inputs a rule parser cannot. The corpus pipeline that produces training data must include them — generated alongside their correct labels (compositional synthesis), not relied on the alignment layer to discover them after the fact.

## Success metric: graceful failure

From slide 20 of the same talk:

> People just want what their local post office expects. And, that means failing gracefully.

This is the deliberate counterpoint to F1-maximization. The mail carrier squinting at bad handwriting and figuring it out anyway — that is the target behavior. A wrong answer that at least looks plausible and routes to a recoverable next step is preferable to wrong-with-high-confidence.

### The confidence-as-trap pattern

A core operating principle for everyone making decisions about confidence thresholds, scoring tweaks, or post-hoc adjustments in the parser:

Historically the confidence levels and various phrase constraints, confidence boosts, and demerits in rule-classifier-era geocoders are all part of a greater problem. As one builds more and more exceptions and adjustments to a domain-specific machine, one occludes the true nature of how addresses actually work. And worse, one's mental confidence in how accurately the domain has been mapped reinforces the belief — not with a platonic ideal of well-formed addresses, and not even of the platonic ideal of what a badly formatted address might look like, but with only the addresses which the system happens to struggle with the most. At the beginning, luck is in one's favor and meaningful exceptions surface naturally. But each bug report of a badly parsed address entrenches the system deeper. And if one then tries a new way of parsing, regressions are guaranteed — meaning even more machinery is required.

The principle that inverts this trap, and that should be quoted verbatim wherever this section is referenced:

> _We want the opposite: every additional address should give us confidence in the **possibilities**, not the **constraints**._

### Operational implications

- **Phase 2 training metrics** must capture confidence calibration and graceful-degradation rate, not just per-component F1. A model that scores well on F1 while reporting overconfident wrong answers on ambiguous inputs fails the success metric.
- **`ClassifierPolicy.confidence_threshold` tuning posture**: pick values that prefer "no answer + ask" over "wrong with high confidence." Never tune against specific user-reported failures — that's the entrenchment cycle starting.
- **Bug-triage process**: when a parser bug is reported, add a **training row**, not a rule or a confidence demerit. The bug report becomes a corpus entry; the model learns from the example without anyone touching the parser machinery. If a bug surfaces a missing schema tag, that's a Phase 0 revisit (see `reference/SCHEMA.md`), not a confidence patch.
- **Golden eval set** must include intentionally-ambiguous addresses where the *correct* answer is "partial parse + low-confidence flag" — not just the unambiguous cases.
- **No `confidence_boost` / `confidence_demerit` layer** in the synthesis pipeline or downstream of the model. That's the rule-era machinery the bitter lesson rejects. The model's softmax probability is the confidence; calibration is a training-time concern.

## What this project is not

- Not a geocoder. Resolution to coordinates is Phase 4, separate concern.
- Not a libpostal replacement for everyone. C-language users have libpostal; we're targeting the TypeScript/Node ecosystem.
- Not a research project. We are shipping a library. Novel architectures lose to slightly-tuned standard architectures shipped reliably.
- Not multilingual on day one. The cost of premature internationalization is corpus chaos and slow training. Two locales is the right scope.
