# Country-lexicon soft-feed channel (#1104)

**Why now:** country is a CLOSED, ENUMERABLE class (~250 surfaces), but the neural GRAMMAR mislabels
it in the WOF-admin / resolver hierarchy case — "United States of America, Wyoming, Лорейн" reads the
leading 4-token country phrase as a STREET. The v261 promotion (`2026-07-14-v261-promote-country-gate-exception.md`)
documented golden country recall at 82.0% vs 88.6% shipped, **entirely** on non-postal WOF-admin
rows (220/224 golden country-gold rows), with real-postal recall + precision identical across the
fragment lineage. A data counterweight was tried and confirmed to give diminishing returns (v290 tail
rows +0.9pp, v291 leading rows +0.4pp) — teaching a grammar to memorize a lexicon is the wrong tool.
The right permanent fix is an atlas channel, matching how Pelias handled the same class
(`classifier/WhosOnFirstClassifier.js extends PhraseClassifier` — a position-independent dictionary
phrase-lookup), rendered model-first as an additive soft feature.

## Investigation: the verified truth about the gazetteer channel

The DeepSeek consult claimed the gazetteer channel already does multi-word phrase matching + SP-span
projection, making a country channel a "data-only" extension. **Verified against the code — the first
half is TRUE, the conclusion is FALSE:**

- **Multi-word phrase-match + SP projection: CONFIRMED.** `neural/gazetteer-inference.ts`
  `gazetteerCharPaint` (the longest-first n-gram scan, `max_ngram=7`) + `buildGazetteerFeatures` (the
  first-non-whitespace-char → piece projection); Python mirror `corpus-python/.../gazetteer_anchor.py`
  `gazetteer_char_paint` + `realign_gazetteer_to_pieces`. Both load the SAME JSON so they can't drift.
- **A `country` slot ALREADY EXISTS and is ALREADY POPULATED.** `data/gazetteer/anchor-lexicon-v1.json`
  has `feature_dim: 5`, `slots: [country, region, po_box, cedex, homograph]`, and its `entries`
  already contain `"united states of america": 1`, `"united states": 1`, `"america": 1` (built from
  codex `COUNTRY_LOOKUP`, which aggregates every ISO name + alpha-2/3 + curated surface forms).
- **The shipped model ALREADY CONSUMES it.** `neural-weights-en-us/model-card.json`
  `requires.gazetteer.required = true`; the ONNX graph carries `gazetteer_features` /
  `gazetteer_confidence`.

**So "extend the gazetteer with country data" is a no-op — the data is already there, already fed, and
the WOF-admin case still fails (#1104).** The failure is not a data gap; it is a signal-salience gap.
Two concrete code-level reasons the shared slot is insufficient:

1. **Dilution.** The country bit is one of a 5-hot vector sharing ONE learned projection
   (`model.py` `gazetteer_projection: Linear(5, hidden)`) with region/po_box/cedex/homograph. The
   country signal has no dedicated capacity.
2. **Suppression.** The shipped choreography `suppress_gazetteer_near_postcode` (model-card
   `suppress_gazetteer_near_postcode: true`) ZEROS the whole gazetteer vector — country bit included —
   for pieces adjacent to a postcode-anchor hit. A trailing "…12345 USA" has its country clue
   suppressed exactly where a country most often appears.

Adding a NEW gazetteer slot (5→6) would also change the model's input dimension → a full retrain. So
there is no "data-only, no-retrain" path either way. Given a retrain is mandatory, pick the
representation that gives the model the cleanest, highest-salience country signal.

## Design decision: a dedicated `country` channel (option b)

A dedicated soft-feed channel, sibling of the postcode anchor (#239/#240) and the gazetteer anchor
(#464), NOT an extension of the gazetteer's country slot. Rationale, grounded in the code reality
above:

- **De-entanglement / capacity.** Country gets its OWN projection (`Linear(2, hidden)`) + its own
  learned confidence weight — a distinct, stronger trust for the closed class, exactly the
  leading-long-form case where the shared-vector signal proved too weak.
- **Immunity to near-postcode suppression.** The country channel is built independently and is NOT
  passed through `suppressGazetteerNearPostcode`, closing the "…12345 USA" recall hole.
- **Clean mirror of the two-channel architecture.** Same char-paint → SP-projection → per-piece
  `{features, confidence}` contract; same ONNX feed pattern (`country_features` /
  `country_confidence`); same `requires.country` fail-closed declaration; same confidence=0 identity
  when a country-trained model runs without the lexicon.

(Note: DeepSeek reached the same "dedicated channel" conclusion but via a false premise — that folding
country into an "admin" slot confuses region↔country. In reality country and region are already
separate, clean gazetteer slots. The real justification is dilution + suppression, above.)

### Feature representation: 2-dim `[country_surface, country_ambiguous]`

Rather than DeepSeek's 1-dim `is_country_surface` (where the feature would be perfectly redundant with
the confidence gate), the channel emits **2 dims**:

- `country_surface` (bit 1) — the piece is inside a recognized country surface phrase.
- `country_ambiguous` (bit 2) — the surface is a homograph (also a US region, e.g. "Georgia", "CA")
  or a curated common-word name ("America", "England"). A SOFT false-positive guard: the model learns
  to trust `surface & !ambiguous` (unambiguous long / code forms) strongly and `surface & ambiguous`
  weakly, via context. This is the model-first analogue of Pelias's hard blacklist
  (`north/south/east/west/street/city/king`) + `MustNotFollow/Preceed` solver — without dropping the
  surface, so recall on "Republic of Georgia" is preserved.

Confidence is 1.0 wherever `country_surface` fires. Short codes match uppercase-only (via
`code_entries`, so "us" the word ≠ "US"); multi-word phrases are unambiguous by construction; the
ambiguity flag is computed from codex (US-state-name / abbreviation collision) plus a small tunable
common-word list — no hand-maintained homograph table.

The matcher DELIBERATELY REUSES the gazetteer's tested `gazetteerCharPaint` / `gazetteer_char_paint`
(one phrase-scan algorithm, two vocabularies), so the two channels cannot drift on HOW a phrase is
matched. Only the vocabulary and the emitted feature differ.

## What was implemented (this branch: `feat/country-lexicon-channel`)

Everything defaults OFF — zero impact on the shipped model until the activation retrain flips one
config flag. Verified: neural `tsc --noEmit` clean, 303 neural vitest pass, corpus-python model
forward + config round-trip + encode_row emit + the 3-channel matcher parity all pass.

**Data + builder:**

- `codex/tools/build-country-surface-lexicon.ts` — reads codex (COUNTRY_SURFACE_FORMS + ISO2_TO_NAME,
  the SAME source `country-surfaces.json` is generated from), emits the normalized lexicon. Regenerate:
  `node codex/tools/build-country-surface-lexicon.ts`.
- `data/gazetteer/country-surface-lexicon-v1.json` — 273 entries + 31 code_entries, `max_ngram=7`, 12
  ambiguous. The single artifact both consumers (TS inference + Python training) load.

**TS inference (`neural/`):**

- `country-inference.ts` — `COUNTRY_FEATURE_DIM=2`, `parseCountryLexicon`, `buildCountryFeatures`.
- `country-inference.test.ts` — parity fixture mirroring the Python test.
- `soft-features.ts` — a `country` channel (independent of the near-postcode choreography).
- `onnx-runner.ts` — feeds `country_features`/`country_confidence` (guarded by `inputNames`, so it is
  a no-op on models without the inputs — dormant until the retrain exports them).
- `classifier.ts` — `countryLexicon` config field, `#decode` wiring, trace, `loadFromWeights`
  soft-feed sibling load.
- `scorer.ts` — `DEFAULT_COUNTRY_LEXICON`, `requires.country` fail-closed + `overrides.country`
  ablation, `--country-lexicon` path.
- `weights.ts` — `RequiredChannels.country`, `inferRequiredChannelsFromInputs` (`country_features`),
  `resolveWeights` sibling (`country-surface-lexicon-v1.json`, server tier; pocket is anchor-only).
- `trace.ts` — `NeuralParseTrace.country`.

**Python training-side feature build (`corpus-python/src/mailwoman_train/`):**

- `country_lexicon.py` — `load_country_lexicon`, `realign_country_to_pieces` (reuses
  `gazetteer_char_paint`). The mirror of `country-inference.ts`.
- `test_country_lexicon.py` — parity fixture mirroring the TS test.
- `config.py` — `data.country_lexicon_path`, `model.use_country_anchor`, `model.country_feature_dim`.
- `tokenizer.py` — `encode_row(country_lexicon=…)` emits `country_features`/`country_confidence`.
- `data_loader.py` — threads the two keys (Example fields + load + encode + collate).
- `model.py` — `use_country_anchor` / `country_feature_dim`, `country_projection` +
  `country_token_embedding`, the forward injection `h += c·(W_c·features + v_CTRY)`, config
  serialize/deserialize + `build`.
- `train.py` — `_to_tensor_batch` converts the country tensors.
- `export_onnx.py` — the `anchor+gaz+country` export combo + a fail-loud guard (country is only
  exportable alongside anchor+gaz, the production ship-config; any other combo raises so a
  country-trained model can never silently export country-OFF — the #566/#685 trap).

## Activation (the operator's coordinated retrain — NOT done here)

The channel is inert until a retrain trains the `country_projection`. Exactly two config additions
turn it on (mirroring how the gazetteer channel is enabled):

```yaml
data:
  country_lexicon_path: data/gazetteer/country-surface-lexicon-v1.json
model:
  use_country_anchor: true
  country_feature_dim: 2 # must equal the lexicon's feature_dim
```

Recommended recipe: `init_from` the current stable lineage (v257/v261) and fine-tune, so the encoder
keeps its learned grammar and only learns to route the new country cue — the same shape the anchor and
gazetteer channels were introduced with. `use_country_anchor` default-False means a resume from a
pre-country checkpoint is byte-identical until flipped.

After training:

1. Export via `export_onnx.py` (the `anchor+gaz+country` combo fires automatically).
2. Copy `country-surface-lexicon-v1.json` into the weights packages (add it to the copy-weights /
   publish step alongside `anchor-lexicon-v1.json`).
3. Add to `neural-weights-en-us/model-card.json` `requires`:
   ```json
   "country": { "required": true }
   ```
   Then `createScorer` + `loadFromWeights` feed it automatically and fail-closed if the lexicon is
   missing.

**Grade PACKAGE-SHAPED** (`--weights-cache`), never `--model` alone — the #718 trap: explicit-path
model loading feeds NO sibling channels, so a `--model`-only grade would silently run country-OFF and
mismeasure.

## Expected gate

- **PRIMARY (the target):** golden country recall recovers toward the 88.6% shipped bar on the
  WOF-admin hierarchy rows (the 220/224 non-postal country-gold rows, incl. the leading long-form
  "United States of America, …" case). The channel paints those surfaces unambiguous (`[1,0]`), giving
  the model the salient country cue the shared gazetteer slot could not.
- **GUARD (must not regress):** real-postal country recall stays 3/4 and hallucination stays 0.7% on
  the 300 real no-country rows (the falsifier's precision panel) — the channel is additive and
  model-first, so precision should hold; the `country_ambiguous` dim exists to keep short/homograph
  forms from over-firing.
- **NON-INFERIORITY:** US/FR assembled-coordinate + parity street/house_number/postcode flat vs the
  init_from baseline (the country cue is orthogonal to those tags). Run the standard promotion battery
  - mask-regression gate; zero NaN.

## Follow-ups (out of scope here)

- `neural-web` browser runtime: `WebONNXRunner.infer` takes an optional `country` arg (the interface
  param is already optional, so it compiles), but the web loader does not yet fetch + feed the country
  lexicon. Wire it before the channel ships to the browser demo (mirror the gazetteer URL fetch).
- Optional cleanup: extract the shared phrase-scan into a `lexicon-matcher.ts` that both
  `gazetteer-inference.ts` and `country-inference.ts` import, instead of country importing
  `gazetteerCharPaint`. Pure refactor; deferred to avoid touching the shipped gazetteer path.
- Tune `COMMON_WORD_AMBIGUOUS` in the builder against a real false-positive audit once the retrained
  model exists (currently seeded: america, england, britain, turkey, chad, jordan, jersey, guinea).
