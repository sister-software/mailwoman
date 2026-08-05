# The suggestion layer — preregistration for a nudge that would rather say nothing

Opened 2026-08-05 from the operator's sketch: a layer that reads what a person typed and offers a
better version of it, connecting mailfail's garbage board, `@mailwoman/formatter`, and the record
matcher. Two constraints came attached, and each one changes the design rather than the tuning:

1. **Ordinary people do not reliably know their own postcode.** It is strong evidence when present
   and absent a large share of the time, so the layer has to work postcode-free — and SUPPLYING the
   missing code is one of the better nudges it can make. Completion, not only correction.
2. **A suggestion layer that guesses is worse than no suggestion layer.** The posture is the
   abstention discipline already written down twice in this repo: #1480's unknown-postcode
   abstention, and `PipelineResult.faults`'s rule that a degraded stage is REPORTED and never
   silently papered over.

This document is the inventory of what already exists, four measurements that size the problem, three
pre-registered mechanisms, and the bars. **No mechanism is implemented here.** Bars are fixed before
results, per the PIX1 preregistration idiom.

## Naming

The repo already has three vocabularies this work sits between, and picking the wrong one collides.

- **`coherence` / joint-consistency** is taken, by the four resolver passes and by the
  [postcode-structure arc](./2026-08-05-postcode-structure-arc.md). Those decide what the answer IS.
  This layer decides what to TELL the user about the gap between their input and that answer. Do not
  name anything here `*Coherence`.
- **`faults`** (`core/pipeline/types.ts:501`) is the shape to imitate: an always-present array whose
  emptiness is a positive claim, carrying a `stage`, a `name`, and a verbatim `cause`. Its docstring
  states the doctrine in one line — report the degrade, do not change the answer.
- **`transforms`** (`normalize/types.ts:16`) is the existing before/after record, and it is a
  discriminated union with spans. It is the right shape and nothing reads it (see A.3).

**So: the surface is named `suggestions`, each entry is a `Suggestion`, and every entry names the
`mechanism` that produced it.** The convention for that string is already in the tree —
`PhraseProposal.source` uses `family:rule` (`"paired:quote"`, `"slash:designator-split"`,
`core/pipeline/span-proposer.ts:360-664`). Copy it: `normalize:expand_abbreviation`,
`resolver:postal_city_alias`, `codex:postcode_shape`.

Two words to avoid in this arc: **"correction"** (the layer is advisory, and calling a completion a
correction misstates what it did) and **"validation"** (that is the shape/containment family in the
postcode arc, and reusing it makes the two arcs unreadable together).

## Part A — Inventory

Every row exists today. The last column says what the suggestion layer would have to add.

### A.1 The round trip — the canonicalizer nobody has diffed

| Thing                   | Where                                       | Role                                                                                                                             |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `formatAddress`         | `formatter/format.ts:153`                   | `(components: ComponentDict, country: string, opts) => string`. Takes a FLAT dict, not an `AddressTree`                          |
| `toOpenCageComponents`  | `formatter/format.ts:299`                   | The slot mapping. `venue → house`, `locality → city`, `dependent_locality → suburb`/`quarter`/`place` per country                |
| `canonicalKey`          | `formatter/key.ts:86`                       | The canonical match key. `KEY_FIELD_ORDER` at `:30-46` deliberately excludes `venue` and `attention`                             |
| `normalizeAddressToken` | `formatter/key.ts:63-79`                    | NFKD → strip marks → lowercase → drop apostrophes → non-alphanumeric to space → collapse. The only case-folder in the round trip |
| `reconcileComponents`   | `formatter/format.ts:279`                   | A containment filter: drop a component whose value is absent from the rendered string. Used by the corpus adapters               |
| `/v1/format`            | `api/routes.ts:214-222`, handler `:401-407` | POST, body `{components, country, options}` → `{formatted, canonicalKey}`. Takes a dict, never a raw string                      |
| `PostalAddress`         | `record/address.ts:75`                      | Carries `raw` (`:95`), `formatted` (`:87`), `canonicalKey` (`:83`) side by side                                                  |
| `createPostalAddressID` | `address-id/index.ts:128`                   | `<state>.<H3 cell>.<hash>`; `canonicalizeForHash` (`:100`) is the ONE place the full `normalize` pipeline runs before hashing    |

**Nothing in the repo compares a render against the input it came from.** Verified by grep over
round-trip / reparse / reformat patterns and over every call site of `formatAddress`, `canonicalKey`
and `reconcileComponents`. The corpus adapters run the INVERSE direction (components → string, then
`reconcileComponents` as a containment filter — `corpus/src/adapters/tiger/adapter.ts:193-196` and six
siblings). `registry/ingest.ts:328` retains `raw` beside `formatted` on the same record and never
diffs them. The only statements of the idea are two plan lines:
`docs/engineering/reference/ARCHITECTURE.mdx:352` and
`docs/superpowers/plans/2026-07-22-placetype-pair-implementation.md:111`.

Also worth recording because it will mislead a reader: **`formatter/README.md:30-52` documents a
signature the code does not have** (`formatAddress(components: ClassificationMap, opts?)`, and a key
that is "abbreviation-expanded" — `key.ts:16-19` says expansion is deliberately NOT done).

### A.2 The confidence and abstention substrate

| Thing                               | Where                                                                                         | State                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Per-token softmax confidence        | `neural/classifier.ts:1084`, `:1093`                                                          | `probs[idx]`, or the word-consistency vote's mean when a word was healed                                                  |
| Span confidence                     | `core/decoder/types.ts:74`, aggregated `build-tree.ts:98-100`                                 | Mean over the span's tokens, optionally through a `Calibrator` (`core/decoder/calibration.ts:9-49`) that nothing supplies |
| Widened-span merge rule             | `neural/span-bridge.ts:129`                                                                   | `Math.min` of the two, not the mean                                                                                       |
| `PipelineResult.faults`             | `core/pipeline/types.ts:501`, type `:460`, stages `:444-448`                                  | Three stage values only (`classifier`, `phrase-grouper`, `resolver`); `name` is the thrown value's constructor name       |
| Fault propagation                   | —                                                                                             | **Stops at the pipeline boundary.** `faults` appears nowhere in `mailwoman/geocode-core.ts`, `api/`, or `apps/`           |
| `minWinningScore`                   | `core/resolver/types.ts:383`, default `resolve.ts:762`, gate `:1112`                          | Default 0. Set by exactly one caller in the tree: `resolver/resolve.test.ts:306`. Built, uncalled                         |
| Postcode abstention (#1480)         | `resolver-wof-sqlite/candidate-lookup.ts:437-443`, cause `:433-436`                           | Skips the trigram rung for postcode-typed queries. **Stamps nothing** — a silent empty return                             |
| The stamp idiom                     | `resolver/resolve.ts:329`, `:1155`, `:1168`, `:1175`, `postcode-country-coherence.ts:289-290` | ~20 `metadata` keys, no registry, no type. The deletion list at `resolve.ts:509-517` is the closest thing                 |
| The one stamp that reaches a caller | `mailwoman/geocode-core.ts:868`, `:144`, `api/schema.ts:153`                                  | `postcode_country_scope`. Its sibling `postcode_country_scope_km` does not                                                |

The 2026-08-04 characterization
(`docs/articles/reviews/2026-08-04-resolver-score-abstention.md`) is the standing evidence and its
conclusion is the one this design is built on: `resolver_score` separates a correct locality from a
garbage one at Youden J = 0.357 (FTS) / 0.573 (candidate), the two backends do not share a unit, and
**classifier span confidence gets J = 0.929 / 0.917 on the same populations** — already `[0, 1]`,
already on the node, backend-independent. The signal that abstains is upstream of the resolver. Its
three caveats travel with the number: the correct-control band was 0.918–0.945 across 149 clean US
street addresses, corroboration cost nothing only because every control row was a full street
address, and n=14/n=12 on the violation side. S-3 below re-derives all of it on a different
population and finds the caveats were understated.

### A.3 The silent cleanups — what a nudge could make visible

The mechanism column is what changes the answer. The last column is the one that decides whether a
suggestion layer can name the change.

| Mechanism                              | Where                                                                         | Default                       | Records what it changed?                                                               | Survives to the caller?                     |
| -------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| `normalize` transforms                 | `normalize/compute.ts:18`, union at `normalize/types.ts:16`                   | 4 of 6 always on              | **Fully.** 6-member union; `expand_abbreviation` carries `{from,to,at}`                | **No** — see below                          |
| Word-consistency heal (#1132)          | `neural/word-consistency.ts:146`, ship default `core/pipeline/types.ts:367`   | **ON**                        | Before/after only when `traceRepairs` is set (`classifier.ts:1067`)                    | No                                          |
| Case normalization (#690/#829)         | `neural/case-normalize.ts:140`, applied `classifier.ts:607`, `:668`           | **ON** (`!== false`)          | `trace.caseNormalized` only (`neural/trace.ts:122`)                                    | No                                          |
| `@mailwoman/variant-aliases`           | `variant-aliases/lookup.ts:79`                                                | **Not wired**                 | n/a — `AliasLookupResult` already carries `{alias, confidence}`                        | n/a                                         |
| Trigram fuzzy tier                     | `resolver-wof-sqlite/candidate-lookup.ts:444-460`, scorer `name-score.ts:42`  | ON, name-only since #1480     | **No.** The Jaccard is computed at `:450` and discarded                                | No — `PlaceCandidate` has no `matchType`    |
| Postal-city short-circuit (#741)       | `resolver-wof-sqlite/candidate-lookup.ts:316-335`                             | ON when the side-index exists | **No.** Returns one synthetic candidate with `score: 1, exactMatch: true`              | No                                          |
| Postal-city alias scorer (#475)        | `resolver-wof-sqlite/lookup.ts:1056-1105`                                     | Opt-in (env)                  | No — which alias matched is lost in a scalar                                           | No                                          |
| `applyPostcodeConsistency` (#370/#945) | `resolver/resolve.ts:266`, called `:850`                                      | **ON**                        | Yes: `postcode_repicked` `:321`, `postcode_city_mismatch` + `coordinate_source` `:329` | Tree metadata only                          |
| `postcodeCountryCoherence` (#42/#1477) | `resolver/postcode-country-coherence.ts:277-290`, called `resolve.ts:792-815` | **ON** since 2026-08-05       | Yes: `postcode_country_scope`, `postcode_country_scope_km`                             | **Yes** — the only one that reaches the API |

**The normalize finding is the cheapest fix in this document.** `NormalizedInput` carries the full
transform list. `NormalizedInputLite` (`core/pipeline/types.ts:112`) declares only
`{raw, normalized, appliedLocale?}` — so the array is structurally still on `result.normalized` at
runtime (core never copies fields) and INVISIBLE at the type level; reading it needs an unsafe cast.
The geocode path discards it outright: `mailwoman/geocode-core.ts:560`, `:610` and `:628` are three
copies of `normalize(input, {expandAbbreviations: true, locale: "und"}).normalized`, so
`expand_abbreviation` entries with full `{from, to, at}` are generated and dropped on every
`geocodeAddress` call. Repo-wide, `.transforms` is read by four lines, all in the normalize
package's own tests.

The `postcodeCountryCoherence` row is the template the rest should follow. It is the one mechanism
whose provenance survives the whole way to the OpenAPI contract, and it got there because #42 needed
a firing receipt to be gradeable at all — the same reason a suggestion needs one to be auditable.

### A.4 The entity-snap tier — batch-shaped, and that is the gap

`@mailwoman/match` is three stages and every entry point takes a corpus:

- `block(records: readonly R[], keys, opts)` — `match/blocking.ts:136`
- `scorePair(model, a, b)` — `match/fellegi-sunter.ts:209`, the Fellegi-Sunter scorer
- `decide(score, {upper, lower})` — `match/fellegi-sunter.ts:251`
- `cluster(records, links, opts)` — `match/clustering.ts:112`
- Driver: `resolveEntities(records, config)` — `registry/resolve.ts:374`, which builds a
  term-frequency table over the whole input at `:378-385` before it can score anything
- Exact-match complement: `postalAddressID` / `addressIDBlockingKey` — `registry/address-key.ts:27`,
  `:40`. Still a blocking key, still batch

**There is no "match one record against an index" function**, confirmed by grep across `match/` and
`registry/`. That is the single new API this arc needs, and it is an addition rather than a change:
blocking key → candidate fetch → `scorePair` → `decide`. The term-frequency dependency is the part
that needs thought — `withTermFrequency` (`match/tf.ts:83`) is fitted on the corpus, so a
single-record path either ships a prebuilt table or drops the adjustment and says so.

### A.5 The negative material

| Board                       | Where                                                                      | Size      | What it grades today                                                                                       |
| --------------------------- | -------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| mailfail fixture            | `mailwoman/eval-harness/fixtures/mailfail.jsonl`                           | 105 rows  | **Nothing.** Zero code files reference it                                                                  |
| — bars                      | same                                                                       | 35/35/35  | `no-component` / `no-resolve` / `no-throw`                                                                 |
| — classes                   | same                                                                       | 7         | script 21, degenerate 18, adversarial 18, numeric 16, structured 15, symbolic 14, size 3                   |
| Gauntlet regression         | `mailwoman/eval-harness/gauntlet/cases/regression.ts:50`                   | 192 cases | Assembled coordinate + tier + asserted components. 90 `pass`, 101 `improvement_target`, 1 `known_fail`     |
| The 2026-08-05 operator set | `cases/regression.ts:2475-3506`, `source: "operator:2026-08-05"`           | 55        | Same                                                                                                       |
| Venue-year-as-postcode      | `cases/regression.ts:880-896`, `venue-bar-1802-pascal`                     | 1         | `improvement_target`. The pipeline emits `postcode="1802"` — the venue's YEAR                              |
| Degenerate duplicate venue  | `cases/regression.ts:3214-3224`, `us-op3-island-lake-duplicate-degenerate` | 1         | `improvement_target`, and its note records the schema gap: the table cannot express "expect no coordinate" |
| Metamorphic DIR             | `gauntlet/metamorphic.ts:420-434`, bases `:67-81`                          | **3**     | Dropping a 5-digit postcode must land within 5 km of the with-postcode anchor                              |

The mailfail fixture's own commit message says it was committed "so these cases can become a gate".
It never did — there is no `mailfail-board.ts` beside `digit-board.ts` / `fragment-board.ts` /
`poi-board.ts`. The only executable residue is `core/pipeline/runtime-pipeline.test.ts:803-882`,
which asserts the fault contract against synthetic throwing stubs and says nothing about the 105
rows.

The Gauntlet's shared runner has no seam for abstention either. `GauntletResult`
(`gauntlet/harness.ts:316-342`) carries resolved values only, `checkCase` has no must-not-resolve
predicate, and `faults` never reaches `runOne`. The `us-op3-island-lake-duplicate-degenerate` note
names this in its own text.

### A.6 What the inventory says about the sketch

- **The round trip is a seam with a missing half.** Parse, resolve and render all ship; the diff
  between the render and the input has never been computed once, anywhere.
- **The abstention signal exists and is upstream of everything.** Span confidence is on the node, in
  `[0, 1]`, on both backends. The gate that would read it (`minWinningScore`) reads the wrong field
  and no caller sets it.
- **Attribution is the hard part, and it is missing by one field in three places.** Of the eight
  answer-changing mechanisms in A.3, two stamp what they did and exactly one of those two reaches a
  caller. The other six either compute the evidence and throw it away (the fuzzy Jaccard at
  `candidate-lookup.ts:450`) or record it behind a flag nothing sets (`traceRepairs`).
- **The entity tier is corpus-shaped**, so the second suggestion tier needs one new function, not a
  new package.
- **The garbage board is committed and ungated**, which means the layer's most important bar can be
  written today against material that already exists.

## Part B — Measurements

Scripts in the session scratchpad under `scripts/diagnostic/suggestion/` (gitignored, per the
convention `docs/articles/reviews/2026-08-02-mailfail-robustness.md:402` established). Every number is
a run against the shipped weights (`model.onnx` md5 `c968c24a`, the candidate-table backend at
`$MAILWOMAN_DATA_ROOT/wof/candidate.db`), not an estimate.

### S-1: round-trip fidelity — the nudge inventory

`s1-roundtrip.ts`, over all 90 `status=pass` rows of `regression.db`. Each row is geocoded through
the Gauntlet deps, the assembled components are packed into a `ComponentDict`, rendered with
`formatAddress(dict, countryCode, {separator: ", "})`, and diffed against the raw input — byte
equality first, then equality under `normalizeAddressToken`, then a token multiset diff.

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

1. **Slightly under half the corpus round-trips byte-identical (43/90).** Those rows are the layer's
   inertness population: a suggestion layer that emits anything on them is broken, which makes them a
   free and cheap bar.
2. **`appendCountry` is a policy, not a fact, and neither default is right.** With it off, 13 rows
   lose only the country line the user typed. With it on, 50 rows gain a country line the user did
   not type. A suggestion layer must condition the flag on whether the input carried a country at
   all; grading either leg alone measures the flag.
3. **The canonicalization class is real and small (7 rows), and one of the seven is a parse defect
   the fold hid.** Six insert a comma the input omitted: five between locality and region
   (`4900 Airport Pkwy, Addison TX 75001` → `…, Addison, TX 75001`) and one between locality and
   postcode (`London SW1Y 4LH` → `London, SW1Y 4LH`). The seventh,
   `Derry/Londonderry, United Kingdom` → `Derry/Londonderry, United, Kingdom`, looks cosmetic and is
   not: `s1b-probe.ts` reads back `locality="Derry/Londonderry, United"` and `region="Kingdom"`. The
   render reproduces the input's tokens, so the case-and-punctuation fold classes it as cosmetic.
   **A token-level fold cannot be the diff's only lens** — B1-4's reversibility bar exists to catch
   exactly this row.
4. **The 26 "material" rows are mostly parse defects on rows the coordinate gate passes.**
   `s1b-probe.ts` dumps the components for six of them, and the result is the finding that justifies
   the whole diff:

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

Three of these carry `status=pass` and resolve to the correct rooftop. **The coordinate gate cannot
see a venue/locality slot swap, and one round-trip render exposes it in a single line.** The last row
is the opposite case and the reason attribution matters: `Park Slope` was parsed correctly and lost
in the RENDER, because `DEPENDENT_LOCALITY_SLOTS.postRender` (`formatter/format.ts:83`) covers ES and
its siblings and not the US. A layer that reports "we dropped Park Slope" without saying which stage
dropped it teaches the user to distrust their own input for a formatter gap.

### S-2: postcode-free viability, and the deletion-ablation runner's first cell

`s2-postcode-free.ts`. Every Gauntlet row whose asserted `expect_components.postcode` appears
verbatim in the input (139 of 192) is geocoded twice: once as written (the anchor), once with that
exact substring deleted and the separator debris cleaned up. A literal delete, not a regex — a
pattern-based stripper would delete house numbers on the 4-digit systems, which is the arc's M-1
finding in reverse.

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

> **Correction 2026-08-05 (ablation run, PR #1500):** the GB row below was measured WITHOUT the GB
> weight artifacts — the S-2 worktree carried no `pair-index-gb` and no `fst-en-gb`, so GB graded
> through the bare base package. The other locales reproduce byte-for-byte under the full
> environment; GB corrects to **26/47 (55.3%) within 5 km, 17/47 (36.2%) over 100 km, p50 1.97 km**.
> Finding 1's "roughly four times" becomes **roughly 2.5×** — direction unchanged, magnitude
> corrected. The table is left as measured; the ablation map's GB cells are the current numbers.

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

**Three findings, and the third is the one that gates the completion nudge.**

1. **The postcode's value is locale-shaped, by a factor of five.** Deleting a US ZIP leaves 81.8% of
   rows inside 5 km; deleting a GB postcode leaves 48.9%, and sends 42.6% more than 100 km away. On
   this board the postcode-completion nudge is worth roughly four times as much in GB as in the US.
   That is precisely the per-(component, locale) ranking the ablation map is supposed to produce, and
   S-2 is its first cell.
2. **The three rows carrying a contradicting `defaultCountry` all crater** (`fr-rivoli-us-scoped`
   6,494 km, `gb-downing-us-scoped` 6,240 km, `de-linden-us-scoped` 6,240 km, two of them dropping
   rooftop → admin). The postcode is the only evidence #42's coherence pass has to override a wrong
   country prior, so deleting it deletes the override. A completion nudge is therefore worth most
   exactly where the country prior is least trustworthy.
3. **Deleting a postcode does not yield "no postcode" — 16 of 139 rows emit a DIFFERENT token as the
   postcode, and 0 of 139 recover the deleted one.** The substitutes:

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
its cross-system exclusion population, measured statically. S-2 shows the parser does not merely
ACCEPT them as postcode-shaped — it EMITS them as the postcode the moment the real code is gone.
`venue-bar-1802-pascal` is the Gauntlet's own venue-year row reproduced by ablation.

**Consequence for the design:** a completion nudge stacked on today's behavior would frequently be
told the postcode slot is already filled — with a house number — and would abstain for the wrong
reason, or worse, confirm it. The completion mechanism has a hard prerequisite on the arc's
Mechanism 1 (shape exclusion) or on an equivalent guard, and its bar has to grade the substitution
rate, not only the fill rate.

### S-3: the abstention population — what a naive layer would say about garbage

`s3-garbage-suggestions.ts`, over all 105 committed mailfail rows. Each row is parsed
(`parseForGeocode`, capturing every span's confidence), geocoded, packed into a `ComponentDict` and
rendered. A row "suggests" when the render is non-empty — that is, when a layer that naively formats
the parse would hand a human a suggestion.

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

max span confidence cut, applied to the 76
  >= 0.5     66 survive
  >= 0.8     28 survive
  >= 0.9      8 survive
  >= 0.918    7 survive     (the 2026-08-04 characterization's cut)
  >= 0.95     1 survive
```

**Four findings.**

1. **Three quarters of the garbage board produces a suggestion today.** That is the population the
   guards exist to suppress, and it is the number the ZERO-suggestions bar is written against.
2. **A confidence cut alone cannot reach zero, and it fails in the most instructive direction.** At
   `>= 0.95` the single survivor is `+1 (555) 867-5309` → `"1, 867-5309"` at **0.964** — the same
   phone number the 2026-08-04 review found at the top of its violation set. It is the
   highest-confidence row in the entire garbage board, higher than any real address in it. The
   fullwidth `３５０ ５ｔｈ Ａｖｅ`, which the layer SHOULD nudge to `350 5th Ave`, sits at 0.923.
   Confidence orders these two backwards.
3. **Confidence AND corroboration together reach zero on the bars that matter.** 41 of the 76
   suggestions carry a `no-resolve` or `no-component` bar (the true violations). Under
   `maxSpanConfidence >= 0.918` alone, 1 survives. Under `componentCount >= 3` alone, 8 survive.
   Under **both, 0 of 41 survive** — and the three rows that clear the conjunction all carry the
   weakest bar (`no-throw`), two of them being `﻿350 5th Ave, New York, NY` (leading BOM) and
   `350 5th Ave⟨U+2028⟩New York⟨U+2029⟩NY`, which render correctly and are the layer working as
   designed on hostile-but-real input.
4. **The corroboration arm has a measured price, and it is the same price the 2026-08-04 review
   warned about.** 30 of the 90 Gauntlet `pass` rows carry fewer than 3 components — the bare
   localities (`Toronto, Canada`, `Sydney, Australia`, `Beirut, Lebanon`) that are the map-search
   register this product is aimed at. A `componentCount >= 3` rule deletes the nudge on a third of
   the real board. It also deletes the fullwidth-fold nudge, which is 2 components. So the guard is
   a stack with a stated cost, not a threshold, and the bare-locality carve-out has to be part of the
   design rather than discovered later.

## Part C — The design

Three mechanisms. Each states where it lives, what it needs, its D-rule posture, and pre-registered
bars. **No bar is renegotiable after results are seen.** All three ship opt-in.

### C.0 The surface

One mode, two tiers behind it. The library entry is `suggestAddress(raw, deps)` in a new
`@mailwoman/suggest` workspace; the HTTP entry is `POST /v1/suggest` beside `/v1/format`
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
	 * Never `"unknown"` — an unattributable change is a bug in the pass that made it, and B1-3 gates
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

`abstainReasons` is modeled on `PipelineResult.faults` deliberately, down to the always-present
array — same contract, same docstring discipline, and the same reason: an empty array is the layer
stating it checked.

### C.1 Mechanism 1 — the format nudge (free, offline)

**Lever shape.** Not a model change. Render-time only: `normalize` + parse + `formatAddress` +
`codex`. Zero GPU, zero retrain, and no gazetteer — this tier runs in a browser with the weights and
nothing else, which is what makes it the default tier.

**Where it lives.** `suggest/format-nudge.ts`, consuming `PipelineResult` and the formatter. It never
calls the resolver.

**What it does.** Renders the parse, diffs against the input by the S-1 method (byte equality →
`normalizeAddressToken` equality → token multiset), and emits `canonicalize` and `drop` ops only.
Concretely, the classes S-1 found: the missing locality/region comma (7 rows), the fullwidth and NBSP
and BOM folds, `Str.` → `Str`, `Av.` → `Avenue`, and the country-line decision — which is
conditioned on whether the input carried a country token, not on the formatter's default.

**Artifact.** None. Two contract changes it wants, both additive:

- `NormalizedInputLite` (`core/pipeline/types.ts:112`) gains `transforms`. The data already exists at
  runtime; this is a type widening and a stop to the three `.normalized` discards in
  `geocode-core.ts`. Without it, every `canonicalize` op has to be re-derived by string comparison
  from data the pipeline already computed and threw away.
- `PlaceCandidate` (`resolver-wof-sqlite/types.ts:48-93`) gains `matchType: "exact" | "alias" |
"postal_city" | "fuzzy"`. The value is already computed at
  `candidate-lookup.ts:450` (the Jaccard) and `:328` (the postal-city short-circuit) and discarded.
  `PostcodeAnchor` already carries exactly this field under exactly this name
  (`neural/postcode-anchor.ts:87`), so the naming is settled.

**D-rule.** Opt-in behind `suggest`, default-OFF. It changes no answer — it only reports — so the
promotion question is about the SUGGESTION's precision, not about resolution accuracy. That is a
different gate set and it gets its own record.

**Pre-registered bars.**

- **B1-1 (the garbage board — the bar this layer exists for).** All 105 mailfail rows.
  Bar: **zero non-null `canonicalForm` on the 70 rows carrying a `no-resolve` or `no-component`
  bar**, against the 41 S-3 measured today. The `no-throw` tier is explicitly allowed to produce a
  suggestion — `﻿350 5th Ave, New York, NY` SHOULD be nudged, and a bar that forbids it is asking the
  layer to fail on real input in awkward wrappers. Run first; it is the cheapest and it is the one
  that can kill the mechanism.
- **B1-2 (inertness on the clean population).** The 43 Gauntlet `pass` rows S-1 measured as
  byte-identical. Bar: **43/43 return an empty `diff` and a `canonicalForm` equal to the input.**
  A single op here means the diff is reporting the formatter's own defaults as user advice.
- **B1-3 (every change names its mechanism).** Across the Gauntlet and the mailfail board. Bar:
  **zero `Suggestion` entries with an unattributed `mechanism`**, and every distinct value maps to a
  `family:rule` that exists in the tree. This is what stops the diff from degenerating into "these
  strings differ".
- **B1-4 (the cosmetic ops are reversible).** For every `canonicalize` op, applying it to the input
  and re-parsing must yield the same `ComponentDict`. Bar: **100% on the 7 S-1 `canonical_only` rows
  plus the four mailfail folds** (BOM, fullwidth, NBSP, U+2028). A cosmetic change that moves the
  parse is not cosmetic, and this bar is the definition.
- **B1-5 (the bare-locality carve-out is measured, not assumed).** The 30 Gauntlet `pass` rows with
  fewer than 3 components. Bar: **report the suggestion rate on this stratum separately in every
  run**, and the corroboration guard must be declared per-stratum rather than globally. S-3 measured
  the cost at a third of the board; a design that discovers this after shipping has deleted map
  search.

**Kill condition.** B1-1 cannot reach zero without a rule that also fails B1-5 — that is, the only
guards that silence garbage also silence bare localities. Then the format nudge is not shippable as a
default-visible surface and the compliant outcome is advisory metadata behind a flag, the same
posture the 2026-08-04 review recommended for Design B.

### C.2 Mechanism 2 — the postcode-completion nudge

**Lever shape.** A retrieval-augmented prior at resolve time, reusing the postcode gazetteer already
loaded. It is the operator's constraint 1 turned into a mechanism: the layer's best move on an input
with no postcode is to supply one.

**Where it lives.** `suggest/postcode-completion.ts`, downstream of the resolve, reading the
resolved node's coordinate. Three sources in ascending order of what they can assert:

1. **Reverse lookup at the resolved point.** When the parse resolved a locality or a street and
   carries no postcode, look up the postcode covering that coordinate. Confidence is the code's own
   dispersion, which is exactly what the arc's PFX1 `radiusP95Km` ships
   (`2026-08-05-postcode-structure-arc.md`, Mechanism 3). A rooftop-tier resolve yields a unit code;
   an admin-tier resolve yields whatever the dispersion supports, and where that is a district it
   says district.
2. **The arc's B2 containment coherence**, for the case where a postcode IS present and disagrees
   with the street. That mechanism produces "the nearest consistent completion"; this layer renders
   it as a `replace` op with the disagreement as its evidence.
3. **PFX1 for a PARTIAL code.** `SW1A` with no unit, `BT9` with no unit. The completion is the
   ancestry, never a coordinate — M-2b's 80 BT districts have no coordinates and never will from a
   permissive source.

**Artifact.** None new. It consumes the postcode gazetteer, `postal-city-alias-us.db` where present,
and PFX1 once the arc's B3-1 lands. It does not build anything.

**D-rule.** Opt-in behind `postcodeCompletion`, default-OFF, and **blocked on the arc's Mechanism 1
or an equivalent shape guard.** S-2's finding 3 is the reason: on 16 of 139 rows the postcode slot is
already occupied by a house number, a venue year or a route number, so a completion mechanism that
tests "is the postcode slot empty" reads the wrong answer 11.5% of the time on this board.

**Pre-registered bars.**

- **B2-1 (completion accuracy on the S-2 population).** The 139 eligible rows, postcode deleted, the
  layer asked to complete it. Bar: **the completed code equals the deleted code on ≥ 60% of the rows
  whose postcode-free arm landed within 5 km of the anchor** (87 of 139 by S-2), against the 0/139
  the pipeline recovers today. Reported per locale, because S-2 measured a 33-point spread between
  GB and US and a single aggregate would hide it.
- **B2-2 (abstain on the unknown code — the #1480 bar, restated).** A board of NI addresses carrying
  a BT code the unit resolver abstains on. Bar: **zero unit-level completions, zero invented
  coordinates, and the district named where PFX1 has one.** A mechanism that completes `BT3 9QQ` to a
  Sheffield-adjacent unit has reproduced the exact defect #1480 fixed.
- **B2-3 (never worse than saying nothing).** Both arms on the same board: no completion, and
  completion. Bar: **zero rows where the completed code moves the assembled coordinate further from
  ground truth than the no-completion arm.** Abstaining is never worse than a wrong answer, so any
  regression here is a straight D-rule violation.
- **B2-4 (the slot is not already wrongly filled).** The 16 S-2 substitution rows. Bar: **the layer
  emits a `replace` op naming the substitution on ≥ 14 of 16, or abstains with
  `code: "ambiguous_completion"` — and in no case confirms the house number as a postcode.** This is
  the bar that couples this mechanism to the arc, and it is the one that fails if the shape guard is
  not in place first.
- **B2-5 (cost).** One coordinate-to-postcode lookup per suggestion on a resolve that already
  happened. Bar: **≤ 10% p95 latency increase** on the demo preset, measured rather than asserted.

**Kill condition.** B2-1 misses at every locale — the resolved coordinate does not localize a
postcode well enough to complete it, and the whole completion premise was a property of the
gazetteer's density rather than of postcodes. Record it as a negative next to the arc's own
kill conditions and stop.

### C.3 Mechanism 3 — the entity snap

**Lever shape.** The matcher applied to one record instead of a corpus. Highest cost, narrowest
scope, and last in the sequence.

**Where it lives.** A new `snapRecord(record, index, model)` in `@mailwoman/match` — blocking key →
candidate fetch → `scorePair` (`match/fellegi-sunter.ts:209`) → `decide` (`:251`). The suggestion
layer calls it only when Mechanism 1 has produced a `canonicalForm` and Mechanism 2 has either
completed or abstained; the snap either confirms the render against a known entity or declines.

**What it changes about the answer.** Nothing, by construction: a snap that clears `decide`'s upper
threshold becomes `replace` ops with `mechanism: "match:fellegi_sunter"`; a snap in the
`decide` grey band becomes an abstention with the score as evidence. It never overwrites silently.

**Artifact.** An index to snap against, which is a deployment question rather than a mechanism
question — the registry's own corpus, or a customer's. The term-frequency table
(`match/tf.ts:83`) is corpus-fitted, so the single-record path either ships a prebuilt table or drops
the adjustment and declares it in the result.

**D-rule.** Opt-in behind `entitySnap`, default-OFF, and gated behind Mechanism 1's bars — a snap on
top of a wrong render is a confident wrong answer, which is the failure mode the whole document
exists to avoid.

**Pre-registered bars.**

- **B3-1 (the degenerate duplicate).** `us-op3-island-lake-duplicate-degenerate`
  (`cases/regression.ts:3214`), the row whose correct output is a venue and no coordinate, and which
  today resolves confidently to Island Lake, Illinois, 950 km from its sibling. Bar: **the layer
  abstains with `code: "degenerate_repeat"` and emits no `canonicalForm`.** This single row is the
  clearest statement of the whole posture and it is already committed.
- **B3-2 (precision on the operator set).** The 55 `operator:2026-08-05` rows. Bar: **≥ 90% of
  emitted `replace` ops are correct against the case's asserted components, on the rows that assert
  any** — with the abstention rate reported beside it, because a layer that abstains on 54 of 55 and
  gets the last one right has not passed.
- **B3-3 (no new confident false positive).** The whole Gauntlet, snap ON vs OFF. Bar: **zero rows
  where the snap moves an assembled coordinate outside its existing tolerance.**

**Kill condition.** B3-2's precision cannot clear 90% without an abstention rate that makes the tier
pointless. Then the entity tier is a batch-only capability, `resolveEntities` already covers it, and
the single-record path is not worth the API surface.

### C.4 Diff attribution — the part that is not free

The three mechanisms above are cheap because parse, resolve and render all ship. Attribution is the
part that needs work, and S-1 finding 4 is why: `Park Slope` disappears from the render because the
US template has no slot, and `Nippes` disappears because the parse dropped it. Same visible symptom,
opposite cause, opposite advice to the user. A diff that cannot tell them apart trains people to
delete correct input.

Three changes, cheapest first, all additive:

1. **`NormalizedInputLite` gains `transforms`** (`core/pipeline/types.ts:112`) and
   `geocode-core.ts:560/610/628` stop discarding it. Zero new computation — the array is built on
   every call today.
2. **`PlaceCandidate` gains `matchType`** (`resolver-wof-sqlite/types.ts:48-93`). The fuzzy Jaccard
   (`candidate-lookup.ts:450`) and the postal-city short-circuit (`:328`) both know the answer and
   drop it. This is what lets the layer say "we read `Antioch` as `Nashville` because the postal-city
   index says they share 37013" instead of showing a name the user never typed.
3. **A render-side slot report from the formatter.** `formatAddress` knows which
   `toOpenCageComponents` slots it populated and which the template ignored; returning that set makes
   the "the template has no slot for this" case attributable instead of inferred. This is the only
   one of the three that adds computation, and it is a set difference over at most fifteen keys.

Each of the three closes one attribution class. None of them changes an answer.

### C.5 The ablation map — the dual of this layer

The operator filed the deletion-ablation runner the same day, and the two are duals: **the map ranks
WHICH completion is worth making, per locale.** Where deleting a component barely moves the
resolution, completing it is low-value advice; where deletion craters it, completion is the top
nudge. S-2 is the map's first row, measured for `postcode` across 18 locales, and it already
separates GB (36.2% of rows over 100 km without it — corrected, see the S-2 note) from US (9.1%).

The interface, which is the part this document owes that runner:

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

The suggester's rule: rank candidate completions by `brokenCount / support` in the query's locale,
skip any cell with `support: 0` rather than treating it as zero value, and refuse to emit a
completion for a component whose `substitutedCount / support` exceeds the mechanism's own guard —
which is B2-4 expressed as data instead of as a board.

Reading the map the other way is the ablation runner's own payoff and is out of scope here: a
component with high `support` and near-zero `brokenCount` in a locale is a component the resolver is
not using, which is either a correct redundancy or a dead channel, and the two are worth telling
apart.

### C.6 What needs a retrain

**None of it.** Every mechanism above is a render-time or resolve-time lever. The only model-side
dependency is span confidence, which the shipped model already emits on every node
(`core/decoder/types.ts:74`). The taxonomy in `CONTRIBUTING_MODEL_WORK.mdx` says a retrain is the
tool for open-vocab distributional tags; a diff between two strings is not one.

Two model-adjacent items are named here so they are not mistaken for part of this arc:

- The venue/locality slot swaps S-1b found (`MR & MRS CRAB` → locality `MR`) are parse defects. They
  make the diff noisier and they are a corpus question, not a suggestion-layer question.
- The `Calibrator` seam (`core/decoder/calibration.ts:9-49`) exists and nothing supplies a bin table.
  Every confidence threshold in this document is therefore a threshold on a RAW mean-of-softmax, and
  the 2026-08-04 review's caveat about the 0.918–0.945 band applies unchanged. Fitting a calibrator
  would make the thresholds portable across locales; not fitting one is why B1-1 and B1-5 are graded
  per board rather than at one global number.

## Part D — Sequencing

**Nothing here needs a GPU and nothing here depends on a training batch.** Order, cheapest first:

1. **B1-1** — build the mailfail board (`mailwoman/eval-harness/mailfail-board.ts`, beside
   `digit-board.ts`) and run the naive layer against it. The fixture is committed, the numbers are in
   S-3, and this is the bar that decides whether the layer is buildable at all. It is also worth
   doing whether or not the layer ships: 105 committed rows have graded nothing since 2026-08-02.
2. **The attribution triple (C.4)** — the `transforms` widening, `matchType`, the slot report. All
   three are additive, none changes an answer, and every later bar is ungradeable without them.
3. **B1-2 / B1-4** — inertness and reversibility, both against Gauntlet rows that already exist.
4. **B1-5** — the bare-locality stratum, which decides the guard's shape before the guard is written.
5. **The arc's Mechanism 1 shape exclusion**, which is a prerequisite for B2-4 and lives in
   [the postcode-structure arc](./2026-08-05-postcode-structure-arc.md), not here.
6. **B2-1 / B2-2 / B2-3** — the completion bars, after the shape guard.
7. **The ablation runner proper**, generalizing S-2 from `postcode` to every `ComponentTag`.
   S-2 is one column of it and the script generalizes by parameterizing the deleted tag.
8. **B3-\*** — the entity snap, last, and only if the format tier cleared its bars.

The coupling to the postcode arc is one-directional and worth stating plainly: **this layer consumes
the arc's mechanisms and blocks none of them.** The arc's B2 (containment coherence) is the engine
behind "your postcode and your street disagree"; the arc's PFX1 is what lets a partial code
contribute; the arc's Mechanism 1 is what stops a house number from occupying the postcode slot. If
the arc stalls, Mechanism 1 of THIS document still ships — the format nudge needs no gazetteer at
all.

## Explicitly out of scope

- **Any default-on promotion.** All three mechanisms are opt-in, and a promotion is a separate
  decision with its own evidence record, the way #1477 got one.
- **Fixing the parse defects S-1b found.** `MR & MRS CRAB` → locality `MR` is real and it is a corpus
  task. Named here so the diff's noise floor is understood, not claimed as this arc's work.
- **Calibrating span confidence.** The `Calibrator` seam is empty; filling it is its own
  preregistration with its own held-out set.
- **`formatter/README.md`'s wrong signatures.** Recorded in A.1 so they are not lost; they belong to
  whoever next touches that package.
- **The Gauntlet's missing "expect no coordinate" column.** `us-op3-island-lake-duplicate-degenerate`
  names the schema gap in its own note (`cases/regression.ts:3223`). B3-1 needs it; adding it is a
  runner change, not a mechanism.
- **A `suggestions` field on `GeocodeResult`.** The suggestion layer is a separate call. Threading it
  through the geocode result would put an advisory surface inside a resolution contract, and
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
