# The suggestion layer — preregistration for a nudge that would rather abstain

Opened 2026-08-05 from the operator's sketch of a layer that reads what a person typed and offers a
better version of it. The layer connects mailfail's garbage board, `@mailwoman/formatter`, and the
record matcher. The sketch came with two constraints, and each one changes the design rather than
the tuning:

1. **Ordinary people do not reliably know their own postcode.** A postcode is strong evidence when
   present, but it is absent a large share of the time. The layer therefore has to work without a
   postcode, and supplying the missing code is one of the more useful suggestions it can make. The
   layer completes input as well as correcting it.
2. **A suggestion layer that guesses is worse than no suggestion layer.** The layer follows the
   abstention rules already written down twice in this repo: #1480's unknown-postcode abstention,
   and the `PipelineResult.faults` rule that a degraded stage is reported and never silently hidden.

This document inventories what already exists, reports four measurements that size the problem, and
pre-registers three mechanisms with their bars. **This document implements no mechanism.** Bars are
fixed before results, as in the PIX1 preregistration.

## Naming

This work sits between three vocabularies that already exist in the repo, and a name from the wrong
one would collide.

- **`coherence` / joint-consistency** is already used by the four resolver passes and by the
  [postcode-structure arc](./2026-08-05-postcode-structure-arc.md). Those passes decide what the
  answer is. This layer decides what to tell the user about the gap between their input and that
  answer. Do not name anything here `*Coherence`.
- **`faults`** (`core/pipeline/types.ts:501`) is the shape to imitate. It is an always-present array
  whose emptiness is a positive claim, and each entry carries a `stage`, a `name`, and a verbatim
  `cause`. Its docstring states the rule in one line: report the degradation and do not change the
  answer.
- **`transforms`** (`normalize/types.ts:16`) is the existing before/after record. It is a
  discriminated union with spans. It has the right shape, but no consumer reads it (see A.3).

**The surface is therefore called `suggestions`, each entry is a `Suggestion`, and every entry
records the `mechanism` that produced it.** The tree already has a convention for that string:
`PhraseProposal.source` uses `family:rule` (`"paired:quote"`, `"slash:designator-split"`,
`core/pipeline/span-proposer.ts:360-664`). Copy it: `normalize:expand_abbreviation`,
`resolver:postal_city_alias`, `codex:postcode_shape`.

Avoid two words in this arc. **"Correction"** misstates what the layer does, because the layer is
advisory and a completion is not a correction. **"Validation"** already refers to the
shape/containment family in the postcode arc, and reusing it would make the two arcs hard to read
together.

## Part A — Inventory

Every row exists today. The last column says what the suggestion layer would have to add.

### A.1 The round trip — the canonicalizer nobody has diffed

| Thing                   | Where                                       | Role                                                                                                                             |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `formatAddress`         | `formatter/format.ts:153`                   | `(components: ComponentDict, country: string, opts) => string`. Takes a flat dict rather than an `AddressTree`                   |
| `toOpenCageComponents`  | `formatter/format.ts:299`                   | The slot mapping. `venue → house`, `locality → city`, `dependent_locality → suburb`/`quarter`/`place` per country                |
| `canonicalKey`          | `formatter/key.ts:86`                       | The canonical match key. `KEY_FIELD_ORDER` at `:30-46` deliberately excludes `venue` and `attention`                             |
| `normalizeAddressToken` | `formatter/key.ts:63-79`                    | NFKD → strip marks → lowercase → drop apostrophes → non-alphanumeric to space → collapse. The only case-folder in the round trip |
| `reconcileComponents`   | `formatter/format.ts:279`                   | A containment filter: drop a component whose value is absent from the rendered string. Used by the corpus adapters               |
| `/v1/format`            | `api/routes.ts:214-222`, handler `:401-407` | POST, body `{components, country, options}` → `{formatted, canonicalKey}`. Takes a dict, never a raw string                      |
| `PostalAddress`         | `record/address.ts:75`                      | Carries `raw` (`:95`), `formatted` (`:87`), `canonicalKey` (`:83`) side by side                                                  |
| `createPostalAddressID` | `address-id/index.ts:128`                   | `<state>.<H3 cell>.<hash>`; `canonicalizeForHash` (`:100`) is the one place the full `normalize` pipeline runs before hashing    |

**No code in the repo compares a render against the input it came from.** A grep over round-trip,
reparse and reformat patterns, and over every call site of `formatAddress`, `canonicalKey` and
`reconcileComponents`, found no such comparison. The corpus adapters run the inverse direction: they
build a string from components and then use `reconcileComponents` as a containment filter
(`corpus/src/adapters/tiger/adapter.ts:193-196` and six siblings). `registry/ingest.ts:328` keeps
`raw` beside `formatted` on the same record and never diffs them. The idea appears only in two plan
lines: `docs/engineering/reference/ARCHITECTURE.mdx:352` and
`docs/superpowers/plans/2026-07-22-placetype-pair-implementation.md:111`.

**`formatter/README.md:30-52` documents a signature the code does not have**, which will mislead a
reader. It shows `formatAddress(components: ClassificationMap, opts?)` and describes the key as
"abbreviation-expanded", but `key.ts:16-19` says expansion is deliberately not done.

### A.2 The confidence and abstention substrate

| Thing                               | Where                                                                                         | State                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Per-token softmax confidence        | `neural/classifier.ts:1084`, `:1093`                                                          | `probs[idx]`, or the word-consistency vote's mean when a word was healed                                                |
| Span confidence                     | `core/decoder/types.ts:74`, aggregated `build-tree.ts:98-100`                                 | Mean over the span's tokens, optionally via a `Calibrator` (`core/decoder/calibration.ts:9-49`) that no caller supplies |
| Widened-span merge rule             | `neural/span-bridge.ts:129`                                                                   | `Math.min` of the two rather than the mean                                                                              |
| `PipelineResult.faults`             | `core/pipeline/types.ts:501`, type `:460`, stages `:444-448`                                  | Three stage values only (`classifier`, `phrase-grouper`, `resolver`); `name` is the thrown value's constructor name     |
| Fault propagation                   | —                                                                                             | **Stops at the pipeline boundary.** `faults` appears nowhere in `mailwoman/geocode-core.ts`, `api/`, or `apps/`         |
| `minWinningScore`                   | `core/resolver/types.ts:383`, default `resolve.ts:762`, check `:1112`                         | Default 0. Set by exactly one caller in the tree: `resolver/resolve.test.ts:306`. Built, uncalled                       |
| Postcode abstention (#1480)         | `resolver-wof-sqlite/candidate-lookup.ts:437-443`, cause `:433-436`                           | Skips the trigram rung for postcode-typed queries. **Stamps no metadata** — a silent empty return                       |
| The stamp idiom                     | `resolver/resolve.ts:329`, `:1155`, `:1168`, `:1175`, `postcode-country-coherence.ts:289-290` | ~20 `metadata` keys, without a registry or a type. The deletion list at `resolve.ts:509-517` is the closest thing       |
| The one stamp that reaches a caller | `mailwoman/geocode-core.ts:868`, `:144`, `api/schema.ts:153`                                  | `postcode_country_scope`. Its sibling `postcode_country_scope_km` does not                                              |

The 2026-08-04 characterization
(`docs/articles/reviews/2026-08-04-resolver-score-abstention.md`) is the standing evidence and its
conclusion is the basis for this design. `resolver_score` separates a correct locality from a
garbage one at Youden J = 0.357 (FTS) / 0.573 (candidate), and the two backends do not share a unit.
**Classifier span confidence gets J = 0.929 / 0.917 on the same populations.** It is already in
`[0, 1]`, already on the node, and independent of the backend. The signal that should drive
abstention is therefore upstream of the resolver. The number comes with three caveats. The
correct-control band was 0.918–0.945 across 149 clean US street addresses. Corroboration imposed no
cost only because every control row was a full street address. The violation side had only
n=14/n=12. S-3 below re-derives all of it on a different population and finds that the caveats were
understated.

### A.3 The silent cleanups — what a nudge could make visible

The mechanism column lists what changes the answer. The last column decides whether a suggestion
layer can report the change.

| Mechanism                              | Where                                                                         | Default                       | Records what it changed?                                                               | Survives to the caller?                     |
| -------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| `normalize` transforms                 | `normalize/compute.ts:18`, union at `normalize/types.ts:16`                   | 4 of 6 always on              | **Fully.** 6-member union; `expand_abbreviation` carries `{from,to,at}`                | **No** — see below                          |
| Word-consistency heal (#1132)          | `neural/word-consistency.ts:146`, ship default `core/pipeline/types.ts:367`   | **ON**                        | Before/after only when `traceRepairs` is set (`classifier.ts:1067`)                    | No                                          |
| Case normalization (#690/#829)         | `neural/case-normalize.ts:140`, applied `classifier.ts:607`, `:668`           | **ON** (`!== false`)          | `trace.caseNormalized` only (`neural/trace.ts:122`)                                    | No                                          |
| `@mailwoman/variant-aliases`           | `variant-aliases/lookup.ts:79`                                                | **Not wired**                 | n/a — `AliasLookupResult` already carries `{alias, confidence}`                        | n/a                                         |
| Trigram fuzzy tier                     | `resolver-wof-sqlite/candidate-lookup.ts:444-460`, scorer `name-score.ts:42`  | ON, name-only since #1480     | **No.** The Jaccard is computed at `:450` and discarded                                | No — `PlaceCandidate` has no `matchType`    |
| Postal-city short-circuit (#741)       | `resolver-wof-sqlite/candidate-lookup.ts:316-335`                             | on when the side-index exists | **No.** Returns one synthetic candidate with `score: 1, exactMatch: true`              | No                                          |
| Postal-city alias scorer (#475)        | `resolver-wof-sqlite/lookup.ts:1056-1105`                                     | Opt-in (env)                  | No — which alias matched is lost in a scalar                                           | No                                          |
| `applyPostcodeConsistency` (#370/#945) | `resolver/resolve.ts:266`, called `:850`                                      | **ON**                        | Yes: `postcode_repicked` `:321`, `postcode_city_mismatch` + `coordinate_source` `:329` | Tree metadata only                          |
| `postcodeCountryCoherence` (#42/#1477) | `resolver/postcode-country-coherence.ts:277-290`, called `resolve.ts:792-815` | **on** since 2026-08-05       | Yes: `postcode_country_scope`, `postcode_country_scope_km`                             | **Yes** — the only one that reaches the API |

**The normalize finding is the cheapest fix in this document.** `NormalizedInput` carries the full
transform list. `NormalizedInputLite` (`core/pipeline/types.ts:112`) declares only
`{raw, normalized, appliedLocale?}`. The array is still on `result.normalized` at runtime, because
core never copies fields, but it is invisible at the type level, and reading it needs an unsafe
cast. The geocode path discards it outright. `mailwoman/geocode-core.ts:560`, `:610` and `:628` are
three copies of `normalize(input, {expandAbbreviations: true, locale: "und"}).normalized`, so every
`geocodeAddress` call generates `expand_abbreviation` entries with full `{from, to, at}` and drops
them. Across the repo, four lines read `.transforms`, all in the normalize package's own tests.

The `postcodeCountryCoherence` row is the template the rest should follow. It is the only mechanism
whose provenance survives all the way to the OpenAPI interface. It got there because #42 needed a
record of each firing before it could be graded, and a suggestion needs the same record to be
auditable.

### A.4 The entity-snap tier — batch-shaped, and that is the gap

`@mailwoman/match` has three stages, and every entry point takes a corpus:

- `block(records: readonly R[], keys, opts)` — `match/blocking.ts:136`
- `scorePair(model, a, b)` — `match/fellegi-sunter.ts:209`, the Fellegi-Sunter scorer
- `decide(score, {upper, lower})` — `match/fellegi-sunter.ts:251`
- `cluster(records, links, opts)` — `match/clustering.ts:112`
- Driver: `resolveEntities(records, config)` — `registry/resolve.ts:374`, which builds a
  term-frequency table over the whole input at `:378-385` before it can score anything
- Exact-match complement: `postalAddressID` / `addressIDBlockingKey` — `registry/address-key.ts:27`,
  `:40`. Still a blocking key, still batch

**The repo has no function that matches one record against an index.** A grep across `match/` and
`registry/` confirmed this. That function is the single new API this arc needs, and it is an
addition rather than a change: blocking key → candidate fetch → `scorePair` → `decide`. The
term-frequency dependency needs thought. `withTermFrequency` (`match/tf.ts:83`) is fitted on the
corpus, so a single-record path must either ship a prebuilt table or drop the adjustment and say so.

### A.5 The negative material

| Board                       | Where                                                                      | Size      | What it grades today                                                                                       |
| --------------------------- | -------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| mailfail fixture            | `mailwoman/eval-harness/fixtures/mailfail.jsonl`                           | 105 rows  | **No metric.** Zero code files reference it                                                                |
| — bars                      | same                                                                       | 35/35/35  | `no-component` / `no-resolve` / `no-throw`                                                                 |
| — classes                   | same                                                                       | 7         | script 21, degenerate 18, adversarial 18, numeric 16, structured 15, symbolic 14, size 3                   |
| Gauntlet regression         | `mailwoman/eval-harness/gauntlet/cases/regression.ts:50`                   | 192 cases | Assembled coordinate + tier + asserted components. 90 `pass`, 101 `improvement_target`, 1 `known_fail`     |
| The 2026-08-05 operator set | `cases/regression.ts:2475-3506`, `source: "operator:2026-08-05"`           | 55        | Same                                                                                                       |
| Venue-year-as-postcode      | `cases/regression.ts:880-896`, `venue-bar-1802-pascal`                     | 1         | `improvement_target`. The pipeline emits `postcode="1802"` — the venue's YEAR                              |
| Degenerate duplicate venue  | `cases/regression.ts:3214-3224`, `us-op3-island-lake-duplicate-degenerate` | 1         | `improvement_target`, and its note records the schema gap: the table cannot express "expect no coordinate" |
| Metamorphic DIR             | `gauntlet/metamorphic.ts:420-434`, bases `:67-81`                          | **3**     | Dropping a 5-digit postcode must land within 5 km of the with-postcode anchor                              |

The mailfail fixture's commit message says it was committed "so these cases can become a check".
Nobody built that check. The repo has no `mailfail-board.ts` beside `digit-board.ts` /
`fragment-board.ts` / `poi-board.ts`. The only related executable code is
`core/pipeline/runtime-pipeline.test.ts:803-882`, which asserts the fault interface against
synthetic throwing stubs and does not use the 105 rows.

The Gauntlet's shared runner has no way to express abstention either. `GauntletResult`
(`gauntlet/harness.ts:316-342`) carries resolved values only, `checkCase` has no must-not-resolve
predicate, and `faults` never reaches `runOne`. The `us-op3-island-lake-duplicate-degenerate` note
records this gap in its own text.

### A.6 What the inventory says about the sketch

- **Half of the round trip is missing.** Parse, resolve and render all ship, but no code has ever
  computed the diff between the render and the input.
- **The abstention signal exists, upstream of the resolver.** Span confidence is on the node, in
  `[0, 1]`, on both backends. The check that would use a score (`minWinningScore`) reads the wrong
  field, and no caller sets it.
- **Attribution is the hard part, and three places each lack one field.** Of the eight
  answer-changing mechanisms in A.3, two stamp what they did, and only one of those two reaches a
  caller. The other six either compute the evidence and discard it (the fuzzy Jaccard at
  `candidate-lookup.ts:450`) or record it behind a flag no caller sets (`traceRepairs`).
- **The entity tier is corpus-shaped**, so the second suggestion tier needs one new function rather
  than a new package.
- **The garbage board is committed and needs no new data**, so the layer's most important bar can be
  written today against existing material.

## Part B — Measurements

The scripts are in the session scratchpad under `scripts/diagnostic/suggestion/` (gitignored, per the
convention `docs/articles/reviews/2026-08-02-mailfail-robustness.md:402` established). Every number
comes from a run against the shipped weights (`model.onnx` md5 `c968c24a`, the candidate-table
backend at `$MAILWOMAN_DATA_ROOT/db/wof/candidate.db`), not from an estimate.

### S-1: round-trip fidelity — the nudge inventory

`s1-roundtrip.ts` runs over all 90 `status=pass` rows of `regression.db`. It geocodes each row
through the Gauntlet deps, packs the assembled components into a `ComponentDict`, renders them with
`formatAddress(dict, countryCode, {separator: ", "})`, and diffs the render against the raw input.
The diff checks byte equality first, then equality under `normalizeAddressToken`, then a token
multiset diff.

```
n = 90  (gauntlet status=pass)

appendCountry: false  (the formatter's shipped default)
  byte_identical    43
  canonical_only     7      differ only under NFKD/case/punctuation folding
  reorder_only       1      same token multiset, different order
  dropped           33      render is missing input tokens
  both               6      tokens dropped AND added

appendCountry: true
  byte_identical    10
  added             50
  both              20
  dropped            9
  canonical_only     1

the 39 non-identical rows under the shipped default, re-split by cause:
  country_line_only 13      the ONLY missing tokens are the country name
  material          26      something else moved
```

**Four findings.**

1. **Slightly under half the corpus round-trips byte-identical (43/90).** These rows are the layer's
   inertness population. A suggestion layer that emits anything on them is broken, so they give a
   free bar.
2. **`appendCountry` is a policy choice, and neither default is right.** With it off, 13 rows lose
   only the country line the user typed. With it on, 50 rows gain a country line the user did not
   type. A suggestion layer must set the flag based on whether the input carried a country at all.
   Grading either setting alone measures the flag rather than the layer.
3. **The canonicalization class is real and small (7 rows), and the fold hid a parse defect in one
   of the seven.** Six rows insert a comma the input omitted. Five insert it between locality and
   region (`4900 Airport Pkwy, Addison TX 75001` → `…, Addison, TX 75001`), and one between locality
   and postcode (`London SW1Y 4LH` → `London, SW1Y 4LH`). The seventh,
   `Derry/Londonderry, United Kingdom` → `Derry/Londonderry, United, Kingdom`, looks cosmetic but is
   a parse error: `s1b-probe.ts` reads back `locality="Derry/Londonderry, United"` and
   `region="Kingdom"`. The render reproduces the input's tokens, so the case-and-punctuation fold
   classifies it as cosmetic. **The diff needs a check beyond the token-level fold**, and B1-4's
   reversibility bar exists to catch this row.
4. **The 26 "material" rows are mostly parse defects on rows that pass the coordinate check.**
   `s1b-probe.ts` dumps the components for six of them. The output is the main argument for building
   the diff:

```
MR & MRS CRAB, 20 Rue de la Huchette, 75005 Paris
  venue="MRS CRAB"  house_number="20"  street="Rue de la Huchette"
  locality="MR"     postcode="75005"   tier=address_point  (48.853069, 2.345524)

Wingstop Bastille, 61 Rue du Faubourg Saint-Antoine, 75011 Paris, France
  venue="Bastille"  locality="Wingstop"  tier=address_point  (48.852022, 2.37363)

Le 9Neuf, 13 Rue Gaillon, 75002 Paris
  venue=null        locality="Le 9Neuf"  tier=address_point  (48.868604, 2.334157)

Les 2 Garçons, 14 Middle Ln, London N8 8PL, United Kingdom
  house_number="14 Middle"  street="Les 2 Garçons"  locality="United Kingdom"  tier=admin

Neusser Str. 12, Nippes, 50733 Köln
  dependent_locality=null   locality="Köln"   ("Nippes" dropped entirely)

123 Main St, Park Slope, Brooklyn, NY 11215
  dependent_locality="Park Slope"  locality="Brooklyn"   (parsed correctly; the US template
  has no slot for it, so the render drops it)
```

Three of these carry `status=pass` and resolve to the correct rooftop. **The coordinate check cannot
detect a venue/locality slot swap, and a single round-trip render shows it.** The last row is the
opposite case and shows why attribution matters. `Park Slope` was parsed correctly and then lost in
the render, because `DEPENDENT_LOCALITY_SLOTS.postRender` (`formatter/format.ts:83`) covers ES and
its siblings but not the US. If the layer reports "we dropped Park Slope" without saying which stage
dropped it, the user learns to distrust correct input because of a formatter gap.

### S-2: postcode-free viability, and the deletion-ablation runner's first cell

`s2-postcode-free.ts` selects every Gauntlet row whose asserted `expect_components.postcode` appears
verbatim in the input (139 of 192). It geocodes each row twice: once as written (the anchor), and
once with that exact substring deleted and the leftover separators cleaned up. The script uses a
literal delete rather than a regex. A pattern-based stripper would delete house numbers in the
4-digit postcode systems, which is the arc's M-1 finding in reverse.

```
eligible rows                              139
anchor arm resolved                        138 / 139
postcode-free arm resolved                 139 / 139

displacement from the anchor, postcode-free arm
  within  0.1 km    71 / 139   (51.1%)
  within  1   km    75 / 139   (54.0%)
  within  5   km    87 / 139   (62.6%)
  within 10   km    90 / 139   (64.7%)
  within 25   km    93 / 139   (66.9%)
  p50 0.00 km   p90 6,240.45 km   max 14,719.47 km

rooftop -> coarser tier drops               12 / 26 address_point anchors
postcode-free arm re-emitted A postcode     16 / 139
...and it was the deleted one                0 / 139
```

Per locale, which is the ablation map's first row:

> **Correction 2026-08-05 (ablation run, PR #1500):** the GB row below was measured without the GB
> weight artifacts. The S-2 worktree had neither `pair-index-gb` nor `fst-en-gb`, so GB was graded
> through the bare base package. The other locales reproduce byte-for-byte under the full
> environment. The corrected GB numbers are **26/47 (55.3%) within 5 km, 17/47 (36.2%) over 100 km,
> p50 1.97 km**. Finding 1's "roughly four times" becomes **roughly 2.5×**. The direction is
> unchanged and the magnitude is smaller. The table is left as measured, and the ablation map's GB
> cells hold the current numbers.

| locale | n   | within 5 km | over 100 km |
| ------ | --- | ----------- | ----------- |
| GB     | 47  | 23 (48.9%)  | 20 (42.6%)  |
| FR     | 26  | 19 (73.1%)  | 5 (19.2%)   |
| US     | 22  | 18 (81.8%)  | 2 (9.1%)    |
| ES     | 7   | 6           | 1           |
| IE     | 6   | 2           | 3           |
| MX     | 5   | 0           | 4           |
| SI     | 5   | 5           | 0           |
| IM     | 3   | 0           | 2           |
| PR     | 3   | 2           | 1           |
| VI     | 3   | 3           | 0           |

**Three findings. The third one tests the completion nudge.**

1. **The postcode's value depends strongly on locale.** Deleting a US ZIP leaves 81.8% of rows
   inside 5 km. Deleting a GB postcode leaves 48.9% inside 5 km and sends 42.6% more than 100 km
   away. On this board, the postcode-completion nudge is worth roughly four times as much in GB as in
   the US. The ablation map is meant to produce this per-(component, locale) ranking, and S-2 is its
   first cell.
2. **The three rows with a contradicting `defaultCountry` all land far away**
   (`fr-rivoli-us-scoped` 6,494 km, `gb-downing-us-scoped` 6,240 km, `de-linden-us-scoped`
   6,240 km), and two of them drop from rooftop to admin. The postcode is the only evidence #42's
   coherence pass can use to override a wrong country prior, so deleting it removes the override. A
   completion nudge is therefore worth most where the country prior is least trustworthy.
3. **Deleting a postcode does not leave the postcode slot empty.** 16 of 139 rows emit a different
   token as the postcode, and 0 of 139 recover the deleted one. The substitutes:

```
us-subvenue-googleplex-building   94043 deleted -> emitted "1600"      (the house number)
us-op3-twin-peaks-golf-longmont   80503 deleted -> emitted "1200"      (the house number)
pr-op3-place-at-the-sea-ponce     00716 deleted -> emitted "3499"      (the house number)
mx-op3-one-villahermosa-2000      86035 deleted -> emitted "2000"      (part of the venue name)
venue-bar-1802-pascal             75005 deleted -> emitted "1802"      (the venue's year)
us-op3-four-corners-monument      86514 deleted -> emitted "NM-597"    (a route number)
im-op2-simpsons-field           IM2 4RE -> emitted "5G8H+8F5"          (a plus code)
gb-op3-odyssey-w4-belfast       BT3 9QQ -> emitted "W4"                (part of the venue name)
```

Four of these (`1600`, `1200`, `3499`, `2000`) are the same spans the postcode arc's M-1 listed as
its cross-system exclusion population, measured statically. S-2 shows that the parser goes further
than accepting these spans as postcode-shaped. It emits them as the postcode as soon as the real code
is gone. `venue-bar-1802-pascal` is the Gauntlet's own venue-year row, reproduced by ablation.

**Consequence for the design:** a completion nudge built on today's behavior would find the postcode
slot already filled on 16 of 139 rows, by a house number in three of the eight examples above. It would then abstain for the wrong reason, or
confirm the house number as the postcode. The completion mechanism therefore requires the arc's
Mechanism 1 (shape exclusion) or an equivalent guard, and its bar has to grade the substitution
rate as well as the fill rate.

### S-3: the abstention population — what a naive layer would say about garbage

`s3-garbage-suggestions.ts` runs over all 105 committed mailfail rows. It parses each row with
`parseForGeocode`, capturing every span's confidence, then geocodes it, packs it into a
`ComponentDict`, and renders it. A row counts as "suggesting" when the render is non-empty, because
a layer that naively formats the parse would then show a person a suggestion.

```
n = 105

rows that THREW                              0
rows producing >= 1 component               76
rows a naive format-nudge would SUGGEST     76      (72.4%)
rows that also resolved to a coordinate     40

suggesting rows by committed bar
  no-resolve      35 / 35        every one
  no-throw        35 / 35        every one
  no-component     6 / 35

suggesting rows by class
  script 20   adversarial 17   numeric 16   structured 14   degenerate 4   symbolic 3   size 2

max span confidence reduce, applied to the 76
  >= 0.5     66 survive
  >= 0.8     28 survive
  >= 0.9      8 survive
  >= 0.918    7 survive     (the 2026-08-04 characterization's reduce)
  >= 0.95     1 survive
```

**Four findings.**

1. **Three quarters of the garbage board produces a suggestion today.** The guards exist to suppress
   this population, and the zero-suggestions bar is written against this number.
2. **A confidence reduce alone cannot reach zero, and the way it fails is informative.** At
   `>= 0.95` the single survivor is `+1 (555) 867-5309` → `"1, 867-5309"` at **0.964**. This is the
   same phone number the 2026-08-04 review found at the top of its violation set. It is the
   highest-confidence row on the garbage board, higher than any real address on it. The fullwidth
   `３５０ ５ｔｈ Ａｖｅ`, which the layer should nudge to `350 5th Ave`, scores 0.923. Confidence
   ranks these two rows in the wrong order.
3. **Confidence and corroboration together reach zero on the bars that matter.** 41 of the 76
   suggestions carry a `no-resolve` or `no-component` bar (the true violations). Under
   `maxSpanConfidence >= 0.918` alone, 1 survives. Under `componentCount >= 3` alone, 8 survive.
   Under **both, 0 of 41 survive**. The three rows that pass both conditions all carry the weakest
   bar (`no-throw`). Two of them are `﻿350 5th Ave, New York, NY` (leading BOM) and
   `350 5th Ave⟨U+2028⟩New York⟨U+2029⟩NY`. Both render correctly, which is the intended behavior on
   hostile but real input.
4. **The corroboration condition has a measured cost, and the 2026-08-04 review warned about the
   same cost.** 30 of the 90 Gauntlet `pass` rows carry fewer than 3 components. These are bare
   localities (`Toronto, Canada`, `Sydney, Australia`, `Beirut, Lebanon`), the map-search input this
   product is aimed at. A `componentCount >= 3` rule removes the nudge on a third of the real board.
   It also removes the fullwidth-fold nudge, which has 2 components. The guard is therefore a stack
   of conditions with a stated cost rather than a single threshold, and the design must include the
   bare-locality exception from the start.

## Part C — The design

This part defines three mechanisms. Each states where it lives, what it needs, its D-rule posture,
and its pre-registered bars. **No bar may be changed after results are seen.** All three ship
opt-in.

### C.0 The surface

The layer has one mode with two tiers behind it. The library entry is `suggestAddress(raw, deps)` in
a new `@mailwoman/suggest` workspace. The HTTP entry is `POST /v1/suggest` beside `/v1/format`
(`api/routes.ts:214`). The return shape:

```ts
interface SuggestionResult {
	input: string
	/**
	 * The formatter's render of the resolved parse — the thing to show the user. NULL exactly when
	 * `abstainReasons` is non-empty; an empty string is never returned, because "we rendered nothing"
	 * and "we declined" are different claims and a magnitude never carries its own absence.
	 */
	canonicalForm: string | null
	/**
	 * Every difference between `input` and `canonicalForm`. Always present; empty means the layer
	 * examined the input and found nothing to say, which is a different claim from a missing field.
	 */
	diff: readonly Suggestion[]
	/**
	 * Per-component confidence and provenance, one entry per emitted `ComponentTag`.
	 */
	components: readonly SuggestedComponent[]
	/**
	 * Always present. Non-empty means the layer declined and `canonicalForm` is null.
	 */
	abstainReasons: readonly AbstainReason[]
	/**
	 * Which tier answered. `"format"` needs no gazetteer; `"entity"` is matcher-backed.
	 */
	tier: "format" | "entity"
}

interface Suggestion {
	/**
	 * `canonicalize` — same value, different surface (case, punctuation, abbreviation, separator).
	 * `complete` — a value the input did not carry at all.
	 * `replace` — a different value for a span the input did carry.
	 * `drop` — the render omits something the input carried.
	 * The four are the classes S-1 measured; a fifth would need its own measurement.
	 */
	op: "canonicalize" | "complete" | "replace" | "drop"
	tag: ComponentTag
	before: string | null
	after: string | null
	/**
	 * `family:rule`, per the `PhraseProposal.source` convention (`core/pipeline/span-proposer.ts:360`).
	 * Never `"unknown"` — an unattributable change is a bug in the pass that made it, and B1-3 checks
	 * on that.
	 */
	mechanism: string
	confidence: number
	/**
	 * Byte range in the ORIGINAL input, or null for a `complete` (which refers to no input bytes).
	 */
	at: { start: number; end: number } | null
}

interface SuggestedComponent {
	tag: ComponentTag
	value: string
	/**
	 * The span's own confidence, straight off `AddressNode.confidence` — raw mean-of-softmax until a
	 * `Calibrator` is fitted, and stated as raw so nobody reads it as a probability.
	 */
	confidence: number
	/**
	 * Byte range in the ORIGINAL input, or null when the component was completed rather than read.
	 */
	at: { start: number; end: number } | null
	/**
	 * Whether the input carried this component at all — the corroboration count S-3's guard reads is
	 * the number of entries with `fromInput: true`.
	 */
	fromInput: boolean
}

interface AbstainReason {
	/**
	 * `low_span_confidence` | `no_corroboration` | `stage_fault` | `no_components` |
	 * `unresolved` | `known_non_address_shape` | `ambiguous_completion` | `unknown_postcode` |
	 * `degenerate_repeat`
	 */
	code: string
	message: string
	/**
	 * The measurement that tripped it, so the reason is auditable rather than assertive.
	 */
	evidence?: Record<string, unknown>
}
```

`abstainReasons` is modeled on `PipelineResult.faults` on purpose, down to the always-present array.
It uses the same interface and the same docstring conventions for the same reason: an empty array
states that the layer checked.

### C.1 Mechanism 1 — the format nudge (free, offline)

**Change shape.** This is a render-time change that leaves the model alone: `normalize` + parse +
`formatAddress` + `codex`. It runs without a GPU, a retrain, or a gazetteer. This tier runs in a browser
with only the weights, which is why it is the default tier.

**Where it lives.** `suggest/format-nudge.ts` consumes `PipelineResult` and the formatter. It never
calls the resolver.

**What it does.** It renders the parse, diffs the render against the input by the S-1 method (byte
equality → `normalizeAddressToken` equality → token multiset), and emits only `canonicalize` and
`drop` ops. These cover the classes S-1 found: the missing locality/region comma (7 rows), the
fullwidth, NBSP and BOM folds, `Str.` → `Str`, `Av.` → `Avenue`, and the country line. The layer
decides the country line from whether the input carried a country token and ignores the formatter's
default.

**Artifact.** None. The mechanism needs two interface changes, both additive:

- `NormalizedInputLite` (`core/pipeline/types.ts:112`) gains `transforms`. The data already exists at
  runtime, so this widens the type and stops the three `.normalized` discards in `geocode-core.ts`.
  Without it, every `canonicalize` op has to be re-derived by string comparison from data the
  pipeline already computed and discarded.
- `PlaceCandidate` (`resolver-wof-sqlite/types.ts:48-93`) gains `matchType: "exact" | "alias" |
"postal_city" | "fuzzy"`. The value is already computed at
  `candidate-lookup.ts:450` (the Jaccard) and `:328` (the postal-city short-circuit), then
  discarded. `PostcodeAnchor` already carries this field under this name
  (`neural/postcode-anchor.ts:87`), so the name is settled.

**D-rule.** The mechanism is opt-in behind `suggest` and off by default. It only reports and never
changes an answer, so promotion depends on the precision of the suggestions rather than on
resolution accuracy. That needs a different set of checks and its own record.

**Pre-registered bars.**

- **B1-1 (the garbage board, the bar this layer exists for).** All 105 mailfail rows. Bar: **zero
  non-null `canonicalForm` on the 70 rows carrying a `no-resolve` or `no-component` bar**, against
  the 41 that S-3 measured today. Rows in the `no-throw` tier may produce a suggestion.
  `﻿350 5th Ave, New York, NY` should be nudged, and a bar that forbids it would require the layer
  to fail on real input with awkward wrapping. Run this bar first. It is the cheapest, and it can
  rule out the mechanism.
- **B1-2 (inertness on the clean population).** The 43 Gauntlet `pass` rows that S-1 measured as
  byte-identical. Bar: **43/43 return an empty `diff` and a `canonicalForm` equal to the input.**
  A single op here means the diff reports the formatter's own defaults as advice to the user.
- **B1-3 (every change records its mechanism).** Across the Gauntlet and the mailfail board. Bar:
  **zero `Suggestion` entries with an unattributed `mechanism`**, and every distinct value maps to a
  `family:rule` that exists in the tree. Without this bar, the diff would only say that two strings
  differ.
- **B1-4 (the cosmetic ops are reversible).** For every `canonicalize` op, applying it to the input
  and re-parsing must yield the same `ComponentDict`. Bar: **100% on the 7 S-1 `canonical_only` rows
  plus the four mailfail folds** (BOM, fullwidth, NBSP, U+2028). This bar defines a cosmetic change
  as one that leaves the parse unchanged.
- **B1-5 (the bare-locality exception is measured rather than assumed).** The 30 Gauntlet `pass`
  rows with fewer than 3 components. Bar: **report the suggestion rate on this stratum separately in
  every run**, and declare the corroboration guard per stratum rather than globally. S-3 measured
  the cost at a third of the board. A design that finds this out after shipping has broken map
  search.

**Kill condition.** B1-1 cannot reach zero without a rule that also fails B1-5, because the only
guards that silence garbage also silence bare localities. In that case the format nudge cannot ship
as a default-visible surface. The allowed outcome is advisory metadata behind a flag, which is what
the 2026-08-04 review recommended for Design B.

### C.2 Mechanism 2 — the postcode-completion nudge

**Change shape.** This is a retrieval-augmented prior at resolve time that reuses the already loaded
postcode gazetteer. It implements the operator's constraint 1: for an input with no postcode, the
most useful thing the layer can do is supply one.

**Where it lives.** `suggest/postcode-completion.ts` runs after the resolve and reads the resolved
node's coordinate. It has three sources, in ascending order of what they can assert:

1. **Reverse lookup at the resolved point.** When the parse resolved a locality or a street and
   carries no postcode, the layer looks up the postcode covering that coordinate. Confidence comes
   from the code's own dispersion, which the arc's PFX1 `radiusP95Km` provides
   (`2026-08-05-postcode-structure-arc.md`, Mechanism 3). A rooftop-tier resolve yields a unit code.
   An admin-tier resolve yields whatever level the dispersion supports, and when that is a district,
   the suggestion says so.
2. **The arc's B2 containment coherence**, for the case where a postcode is present and disagrees
   with the street. That mechanism produces "the nearest consistent completion", and this layer
   renders it as a `replace` op with the disagreement as its evidence.
3. **PFX1 for a partial code**, such as `SW1A` or `BT9` with no unit. The completion is the
   ancestry and never a coordinate. M-2b's 80 BT districts have no coordinates, and no permissive
   source will supply them.

**Artifact.** None new. The mechanism consumes the postcode gazetteer, `postal-city-alias-us.db`
where present, and PFX1 once the arc's B3-1 lands. It does not build anything.

**D-rule.** The mechanism is opt-in behind `postcodeCompletion`, off by default, and **blocked on the
arc's Mechanism 1 or an equivalent shape guard.** S-2's finding 3 is the reason. On 16 of 139 rows, a
house number, a venue year or a route number already occupies the postcode slot. A completion
mechanism that only tests whether the postcode slot is empty would get the wrong answer on 11.5% of
this board.

**Pre-registered bars.**

- **B2-1 (completion accuracy on the S-2 population).** The 139 eligible rows, with the postcode
  deleted and the layer asked to complete it. Bar: **the completed code equals the deleted code on
  ≥ 60% of the rows whose postcode-free arm landed within 5 km of the anchor** (87 of 139 by S-2),
  against the 0/139 the pipeline recovers today. Report it per locale, because S-2 measured a
  33-point spread between GB and US that a single aggregate would hide.
- **B2-2 (abstain on the unknown code, restating the #1480 bar).** A board of NI addresses carrying
  a BT code that the unit resolver abstains on. Bar: **zero unit-level completions, zero invented
  coordinates, and the district reported where PFX1 has one.** A mechanism that completes `BT3 9QQ`
  to a Sheffield-adjacent unit has reproduced the defect #1480 fixed.
- **B2-3 (never worse than abstaining).** Run both arms, without and with completion, on the
  same board. Bar: **zero rows where the completed code moves the assembled coordinate further from
  ground truth than the no-completion arm.** Abstaining is never worse than a wrong answer, so any
  regression here violates the D-rule.
- **B2-4 (the slot is not already wrongly filled).** The 16 S-2 substitution rows. Bar: **on ≥ 14 of
  16, the layer emits a `replace` op identifying the substitution or abstains with
  `code: "ambiguous_completion"`. It never confirms the house number as a postcode.** This bar
  couples the mechanism to the arc, and it fails if the shape guard is not in place first.
- **B2-5 (cost).** One coordinate-to-postcode lookup per suggestion, on a resolve that already
  happened. Bar: **≤ 10% p95 latency increase** on the demo preset, measured rather than asserted.

**Kill condition.** B2-1 misses at every locale. That would mean the resolved coordinate does not
localize a postcode well enough to complete it, and the completion premise depended on the
gazetteer's density rather than on postcodes. Record the result as a negative next to the arc's own
kill conditions and stop.

### C.3 Mechanism 3 — the entity snap

**Change shape.** This applies the matcher to one record instead of a corpus. It has the highest
cost and the narrowest scope, and it comes last in the sequence.

**Where it lives.** A new `snapRecord(record, index, model)` in `@mailwoman/match` runs blocking key
→ candidate fetch → `scorePair` (`match/fellegi-sunter.ts:209`) → `decide` (`:251`). The suggestion
layer calls it only when Mechanism 1 has produced a `canonicalForm` and Mechanism 2 has either
completed or abstained. The snap either confirms the render against a known entity or declines.

**What it changes about the answer.** No answer value, by construction. A snap that clears `decide`'s upper
threshold becomes `replace` ops with `mechanism: "match:fellegi_sunter"`. A snap in the `decide`
grey band becomes an abstention with the score as evidence. The snap never overwrites silently.

**Artifact.** The snap needs an index to match against, either the registry's own corpus or a
customer's. That is a deployment question rather than a mechanism question. The term-frequency table
(`match/tf.ts:83`) is fitted on the corpus, so the single-record path either ships a prebuilt table
or drops the adjustment and declares that in the result.

**D-rule.** The mechanism is opt-in behind `entitySnap`, off by default, and blocked until
Mechanism 1 clears its bars. A snap on top of a wrong render produces a confident wrong answer, which
is the failure this document is designed to avoid.

**Pre-registered bars.**

- **B3-1 (the degenerate duplicate).** `us-op3-island-lake-duplicate-degenerate`
  (`cases/regression.ts:3214`). Its correct output is a venue with no coordinate, but today it
  resolves confidently to Island Lake, Illinois, 950 km from its sibling. Bar: **the layer abstains
  with `code: "degenerate_repeat"` and emits no `canonicalForm`.** This committed row is the
  clearest single test of the layer's abstention behavior.
- **B3-2 (precision on the operator set).** The 55 `operator:2026-08-05` rows. Bar: **≥ 90% of
  emitted `replace` ops are correct against the case's asserted components, on the rows that assert
  any.** Report the abstention rate beside it, because a layer that abstains on 54 of 55 rows and
  gets the last one right has not passed.
- **B3-3 (no new confident false positive).** The whole Gauntlet, with the snap on and off. Bar:
  **zero rows where the snap moves an assembled coordinate outside its existing tolerance.**

**Kill condition.** B3-2's precision cannot clear 90% without an abstention rate that makes the tier
useless. In that case the entity tier stays a batch-only capability, which `resolveEntities` already
covers, and the single-record path does not justify the added API surface.

### C.4 Diff attribution — the part that is not free

The three mechanisms above are cheap because parse, resolve and render all ship. Attribution needs
new work, as S-1 finding 4 shows. `Park Slope` disappears from the render because the US template
has no slot for it. `Nippes` disappears because the parse dropped it. The visible symptom is the
same, but the causes are opposite and so is the right advice to the user. A diff that cannot tell
them apart teaches people to delete correct input.

Three additive changes, cheapest first:

1. **`NormalizedInputLite` gains `transforms`** (`core/pipeline/types.ts:112`), and
   `geocode-core.ts:560/610/628` stop discarding it. This adds no computation, because every call
   already builds the array.
2. **`PlaceCandidate` gains `matchType`** (`resolver-wof-sqlite/types.ts:48-93`). The fuzzy Jaccard
   (`candidate-lookup.ts:450`) and the postal-city short-circuit (`:328`) both know the match type and
   drop it. With this field, the layer can say "we read `Antioch` as `Nashville` because the
   postal-city index says they share 37013" instead of showing a name the user never typed.
3. **A render-side slot report from the formatter.** `formatAddress` knows which
   `toOpenCageComponents` slots it populated and which the template ignored. Returning that set lets
   the layer attribute a drop to a missing template slot instead of inferring it. This is the only
   change of the three that adds computation, and it is a set difference over at most fifteen keys.

Each change makes one class of change attributable. None of them changes an answer.

### C.5 The ablation map — the dual of this layer

The operator filed the deletion-ablation runner the same day, and it is the dual of this layer:
**the map ranks which completion is worth making, per locale.** Where deleting a component barely
moves the resolution, completing it is low-value advice. Where deleting it moves the result far
away, completing it is the most valuable suggestion. S-2 is the map's first row, measured for
`postcode` across 18 locales. It already separates GB (36.2% of rows over 100 km without the
postcode, as corrected in the S-2 note) from US (9.1%).

This document owes the runner the following interface:

```ts
/**
 * One cell of the deletion-ablation map: what deleting `component` costs in `locale`, on a named
 * board. The suggester reads this as a per-(component, locale) prior on nudge value.
 */
interface AblationCell {
	component: ComponentTag
	/**
	 * BCP-47 or ISO-3166 alpha-2, matching whatever the board keys by — stated, never inferred.
	 */
	locale: string
	/**
	 * Board rows that CARRY this component in this locale. The denominator behind every rate below.
	 * A cell with `support: 0` means NOT MEASURED HERE, and a consumer must represent that as absence
	 * rather than as a zero score (the meaning-of-zero rule).
	 */
	support: number
	/**
	 * Rows whose assembled coordinate moved further than `toleranceKm` once the component was deleted.
	 */
	brokenCount: number
	displacementKmP50: number
	displacementKmP90: number
	/**
	 * Rows whose `resolution_tier` coarsened (address_point -> street -> admin).
	 */
	tierDropCount: number
	/**
	 * Rows that produced no coordinate at all without the component.
	 */
	unresolvedCount: number
	/**
	 * Rows where the deleted component's SLOT was refilled by a different span — the S-2 finding-3
	 * class (a house number emitted as the postcode). Distinct from `brokenCount`: a refill can leave
	 * the coordinate intact and still make the completion nudge unsafe.
	 */
	substitutedCount: number
	toleranceKm: number
	/**
	 * Which board this was measured on, and when. A cell without both is not a measurement.
	 */
	boardID: string
	measuredAt: string
}
```

The suggester ranks candidate completions by `brokenCount / support` in the query's locale. It skips
any cell with `support: 0` rather than treating it as zero value. It refuses to emit a completion for
a component whose `substitutedCount / support` exceeds the mechanism's own guard, which is B2-4
expressed as data instead of as a board.

Reading the map in the other direction benefits the ablation runner and is out of scope here. A
component with high `support` and near-zero `brokenCount` in a locale is one the resolver is not
using. It is either a correct redundancy or a dead channel, and the two are worth telling apart.

### C.6 What needs a retrain

**No mechanism in this design needs a retrain.** Every mechanism above is a render-time or resolve-time
change. The only model-side dependency is span confidence, which the shipped model already emits on
every node (`core/decoder/types.ts:74`). The taxonomy in `CONTRIBUTING_MODEL_WORK.mdx` reserves a
retrain for open-vocab distributional tags, and a diff between two strings is not one.

Two model-adjacent items are listed here so that nobody mistakes them for part of this arc:

- The venue/locality slot swaps S-1b found (`MR & MRS CRAB` → locality `MR`) are parse defects. They
  make the diff noisier, and they are a corpus question rather than a suggestion-layer question.
- The `Calibrator` boundary (`core/decoder/calibration.ts:9-49`) exists, but no caller supplies a bin
  table. Every confidence threshold in this document is therefore a threshold on a raw
  mean-of-softmax, and the 2026-08-04 review's caveat about the 0.918–0.945 band still applies.
  Fitting a calibrator would make the thresholds portable across locales. Because none is fitted,
  B1-1 and B1-5 are graded per board rather than against one global number.

## Part D — Sequencing

**None of this work needs a GPU or depends on a training batch.** The order, cheapest first:

1. **B1-1.** Build the mailfail board (`mailwoman/eval-harness/mailfail-board.ts`, beside
   `digit-board.ts`) and run the naive layer against it. The fixture is committed, the numbers are
   in S-3, and this bar decides whether the layer can be built at all. The board is worth building
   even if the layer never ships, because the 105 committed rows have received no grade since
   2026-08-02.
2. **The three attribution changes (C.4):** the `transforms` widening, `matchType`, and the slot
   report. All three are additive, none changes an answer, and no later bar can be graded without
   them.
3. **B1-2 / B1-4:** inertness and reversibility, both against existing Gauntlet rows.
4. **B1-5:** the bare-locality stratum, which decides the guard's shape before anyone writes the
   guard.
5. **The arc's Mechanism 1 shape exclusion**, which B2-4 requires. It lives in
   [the postcode-structure arc](./2026-08-05-postcode-structure-arc.md) rather than here.
6. **B2-1 / B2-2 / B2-3:** the completion bars, after the shape guard.
7. **The full ablation runner**, generalizing S-2 from `postcode` to every `ComponentTag`. S-2 is one
   column of it, and the script generalizes by parameterizing the deleted tag.
8. **B3-\*:** the entity snap, last, and only if the format tier cleared its bars.

The coupling to the postcode arc runs in one direction, and the plan states it explicitly: **this
layer consumes the arc's mechanisms and blocks none of them.** The arc's B2 (containment coherence)
produces "your postcode and your street disagree". The arc's PFX1 lets a partial code contribute.
The arc's Mechanism 1 stops a house number from occupying the postcode slot. If the arc stalls,
Mechanism 1 of this document can still ship, because the format nudge needs no gazetteer.

## Explicitly out of scope

- **Any default-on promotion.** All three mechanisms are opt-in. A promotion is a separate decision
  with its own evidence record, as #1477 had.
- **Fixing the parse defects S-1b found.** `MR & MRS CRAB` → locality `MR` is a real defect and a
  corpus task. It is listed here so readers understand the diff's noise floor and do not count the
  fix as this arc's work.
- **Calibrating span confidence.** The `Calibrator` boundary is empty. Filling it needs its own
  preregistration with its own held-out set.
- **`formatter/README.md`'s wrong signatures.** A.1 records them so they are not lost. Whoever next
  works on that package should fix them.
- **The Gauntlet's missing "expect no coordinate" column.**
  `us-op3-island-lake-duplicate-degenerate` describes the schema gap in its own note
  (`cases/regression.ts:3223`). B3-1 needs the column, and adding it is a runner change rather than a
  mechanism.
- **A `suggestions` field on `GeocodeResult`.** The suggestion layer is a separate call. Adding it to
  the geocode result would put an advisory surface inside a resolution interface.
  `postcode_country_scope` is the precedent for how narrow that channel should stay.

## Reproduce the measurements

```bash
S1_LIMIT=90  node scripts/diagnostic/suggestion/s1-roundtrip.ts        # S-1  round-trip fidelity
             node scripts/diagnostic/suggestion/s1b-probe.ts           # S-1b the slot-swap probes
S2_LIMIT=139 node scripts/diagnostic/suggestion/s2-postcode-free.ts    # S-2  postcode ablation
             node scripts/diagnostic/suggestion/s3-garbage-suggestions.ts  # S-3 the garbage board
```

All four read `$MAILWOMAN_DATA_ROOT` read-only and write their JSON beside themselves. They need the
dev weights linked (`node neural-weights-en-us/scripts/link-dev-weights.ts`, which needs
`yarn compile` first for the `postcode-us.bin` / `pair-index-us.bin` legs).
