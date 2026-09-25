# Country-lexicon soft-feed channel (#1104)

**Why now:** Country is a closed, enumerable class (~250 surfaces), but the neural model mislabels it
in the WOF-admin / resolver hierarchy case. On "United States of America, Wyoming, Лорейн", it reads
the leading 4-token country phrase as a street. The v261 promotion
(`2026-07-14-v261-promote-country-check-exception.md`) documented golden country recall at 82.0% versus
88.6% for the shipped model. The entire gap came from non-postal WOF-admin rows (220/224 golden
country-gold rows), while real-postal recall and precision stayed identical across the fragment
lineage. A data counterweight was tried and gave diminishing returns (v290 tail rows +0.9pp, v291
leading rows +0.4pp). Training a grammar to memorize a lexicon is the wrong tool. The right permanent
fix is an atlas channel. Pelias handled the same class with a position-independent dictionary phrase
lookup (`classifier/WhosOnFirstClassifier.js extends PhraseClassifier`), and this design implements
the same idea model-first, as an additive soft feature.

## Investigation: the verified truth about the gazetteer channel

The DeepSeek consult claimed that the gazetteer channel already does multi-word phrase matching and
SP-span projection, which would make a country channel a data-only extension. **The code does
phrase matching and projection as claimed, but a country channel still needs a retrain:**

- **Multi-word phrase matching and SP projection exist.** In `neural/gazetteer-inference.ts`,
  `gazetteerCharPaint` runs a longest-first n-gram scan (`max_ngram=7`), and `buildGazetteerFeatures`
  projects from the first non-whitespace char to its piece. The Python mirror in
  `corpus-python/.../gazetteer_anchor.py` is `gazetteer_char_paint` plus
  `realign_gazetteer_to_pieces`. Both load the same JSON, so they cannot drift.
- **A `country` slot already exists and is already populated.** `data/gazetteer/anchor-lexicon-v1.json`
  has `feature_dim: 5` and `slots: [country, region, po_box, cedex, homograph]`, and its `entries`
  already contain `"united states of america": 1`, `"united states": 1`, and `"america": 1`. The
  entries come from codex `COUNTRY_LOOKUP`, which aggregates every ISO name, the alpha-2/3 codes, and
  curated surface forms.
- **The shipped model already consumes it.** `neural-weights-en-us/model-card.json` sets
  `requires.gazetteer.required = true`, and the ONNX graph carries `gazetteer_features` and
  `gazetteer_confidence`.

**Extending the gazetteer with country data would therefore change nothing. The data is already
there and already fed to the model, and the WOF-admin case still fails (#1104).** The failure comes
from low signal salience rather than missing data. Two code-level reasons make the shared slot
insufficient:

1. **Dilution.** The country bit is one entry of a 5-hot vector that shares one learned projection
   (`model.py` `gazetteer_projection: Linear(5, hidden)`) with region, po_box, cedex, and homograph.
   The country signal has no dedicated capacity.
2. **Suppression.** The shipped `suppress_gazetteer_near_postcode` behavior (model card
   `suppress_gazetteer_near_postcode: true`) sets the whole gazetteer vector to zero, including the
   country bit, for pieces adjacent to a postcode-anchor hit. A trailing "…12345 USA" therefore loses
   its country clue in exactly the position where a country appears most often.

Adding a gazetteer slot (5→6) would also change the model's input dimension and require a full
retrain. Neither option avoids a retrain. Since a retrain is required, choose the representation
that gives the model the cleanest and most salient country signal.

## Design decision: a dedicated `country` channel (option b)

The design adds a dedicated soft-feed channel alongside the postcode anchor (#239/#240) and the
gazetteer anchor (#464). It does not extend the gazetteer's country slot. The reasons follow from
the code findings above:

- **Separate capacity.** Country gets its own projection (`Linear(2, hidden)`) and its own learned
  confidence weight. The model can then trust the closed class more strongly, which targets the
  leading long-form case where the shared-vector signal proved too weak.
- **No near-postcode suppression.** The country channel is built independently and does not pass
  through `suppressGazetteerNearPostcode`, which closes the "…12345 USA" recall gap.
- **Same structure as the existing two channels.** It uses the same char-paint → SP-projection →
  per-piece `{features, confidence}` interface, the same ONNX feed pattern (`country_features` /
  `country_confidence`), the same fail-closed `requires.country` declaration, and the same
  confidence=0 identity when a country-trained model runs without the lexicon.

(Note: DeepSeek reached the same "dedicated channel" conclusion from a false premise, namely that
folding country into an "admin" slot confuses region and country. Country and region are already
separate gazetteer slots. The actual justification is the dilution and suppression described above.)

### Feature representation: 2-dim `[country_surface, country_ambiguous]`

DeepSeek proposed a 1-dim `is_country_surface`, which would be fully redundant with the confidence
value. The channel instead emits **2 dims**:

- `country_surface` (bit 1): the piece is inside a recognized country surface phrase.
- `country_ambiguous` (bit 2): the surface is a homograph that is also a US region (for example
  "Georgia" or "CA"), or a curated common-word name ("America", "England"). This bit is a soft
  false-positive guard. The model learns from context to trust `surface & !ambiguous` (unambiguous
  long forms and codes) strongly and `surface & ambiguous` weakly. It is the model-first counterpart
  of Pelias's hard blacklist (`north/south/east/west/street/city/king`) plus its
  `MustNotFollow/Preceed` solver. Unlike the blacklist, it keeps the surface, so recall on "Republic of
  Georgia" is preserved.

Confidence is 1.0 wherever `country_surface` fires. Short codes match only in uppercase through
`code_entries`, so the word "us" does not match "US". Multi-word phrases are unambiguous by
construction. The ambiguity flag is computed from codex (collisions with US state names and
abbreviations) plus a small tunable list of common words, so no homograph table needs manual
maintenance.

The matcher deliberately reuses the gazetteer's tested `gazetteerCharPaint` / `gazetteer_char_paint`,
running one phrase-scan algorithm over two vocabularies. The two channels therefore cannot drift in
how they match a phrase. Only the vocabulary and the emitted feature differ.

## What was implemented (this branch: `feat/country-lexicon-channel`)

Everything defaults to off, so the shipped model is unaffected until the activation retrain turns on
one config flag. Verified: neural `tsc --noEmit` is clean, 303 neural vitest tests pass, and the
corpus-python model forward pass, config round-trip, encode_row emission, and 3-channel matcher
parity checks all pass.

**Data + builder:**

- `codex/tools/build-country-surface-lexicon.ts` reads codex (COUNTRY_SURFACE_FORMS + ISO2_TO_NAME,
  the same source that generates `country-surfaces.json`) and emits the normalized lexicon.
  Regenerate it with `node codex/tools/build-country-surface-lexicon.ts`.
- `data/gazetteer/country-surface-lexicon-v1.json` has 273 entries plus 31 code_entries,
  `max_ngram=7`, and 12 ambiguous entries. Both consumers (TS inference and Python training) load
  this one artifact.

**TS inference (`neural/`):**

- `country-inference.ts` — `COUNTRY_FEATURE_DIM=2`, `parseCountryLexicon`, `buildCountryFeatures`.
- `country-inference.test.ts` — parity fixture mirroring the Python test.
- `soft-features.ts` — a `country` channel (independent of the near-postcode choreography).
- `onnx-runner.ts` — feeds `country_features`/`country_confidence`, guarded by `inputNames`. It does
  nothing on models without those inputs, so it stays inactive until the retrain exports them.
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
- `export_onnx.py` — the `anchor+gaz+country` export combo plus a guard that fails loudly. Country
  can be exported only alongside anchor+gaz, which is the production release config. Any other combo
  raises, so a country-trained model can never silently export with country off (the #566/#685
  failure).

## Activation (the operator's coordinated retrain — NOT done here)

The channel has no effect until a retrain trains `country_projection`. Two config additions turn it
on, mirroring how the gazetteer channel is enabled:

```yaml
data:
  country_lexicon_path: data/gazetteer/country-surface-lexicon-v1.json
model:
  use_country_anchor: true
  country_feature_dim: 2 # must equal the lexicon's feature_dim
```

Recommended recipe: `init_from` the current stable lineage (v257/v261) and fine-tune. The encoder then
keeps its learned grammar and only learns to route the new country cue, which is how the anchor and
gazetteer channels were introduced. `use_country_anchor` defaults to False, so a resume from a
pre-country checkpoint stays byte-identical until the flag is set.

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

**Grade the package-shaped model** (`--weights-cache`), never `--model` alone. Loading a model by
explicit path feeds no sibling channels (the #718 failure), so a `--model`-only grade would silently
run with country off and report the wrong numbers.

## Expected check

- **Primary target:** Golden country recall recovers toward the 88.6% shipped bar on the WOF-admin
  hierarchy rows (the 220/224 non-postal country-gold rows, including the leading long-form
  "United States of America, …" case). The channel marks those surfaces as unambiguous (`[1,0]`),
  which gives the model the salient country cue that the shared gazetteer slot could not.
- **Guard (must not regress):** Real-postal country recall stays at 3/4, and hallucination stays at
  0.7% on the 300 real no-country rows (the falsifier's precision panel). The channel is additive and
  model-first, so precision should hold. The `country_ambiguous` dim exists to keep short and
  homograph forms from firing too often.
- **Non-inferiority:** US/FR assembled-coordinate scores and parity street/house_number/postcode
  scores stay flat relative to the init_from baseline, because the country cue is independent of
  those tags. Run the standard promotion battery plus the mask-regression check, and require zero
  NaN.

## Follow-ups (out of scope here)

- `neural-web` browser runtime: `WebONNXRunner.infer` takes an optional `country` arg, and the
  interface param is already optional, so it compiles. The web loader does not yet fetch and feed the
  country lexicon. Wire that up, mirroring the gazetteer URL fetch, before the channel ships to the
  browser demo.
- Optional cleanup: Extract the shared phrase scan into a `lexicon-matcher.ts` that both
  `gazetteer-inference.ts` and `country-inference.ts` import, instead of having country import
  `gazetteerCharPaint`. It is a pure refactor, deferred to avoid touching the shipped gazetteer path.
- Once the retrained model exists, tune `COMMON_WORD_AMBIGUOUS` in the builder against a real
  false-positive audit. Its current seed list is america, england, britain, turkey, chad, jordan,
  jersey, guinea.
