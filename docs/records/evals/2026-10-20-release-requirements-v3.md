# Release quality requirements, specification v3: decided values

Date: 2026-10-20. Issue #2763, the "operator registers numerical minima" item, delegated. Policy:
`scratchpad/2026/10/20/D_RULE_REDESIGN-confirmed.md`. Evaluator: `packages/mailwoman/tools/eval-harness/release/`
at `origin/main` 3b2000e24. This record is committed with `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v3.json`,
which holds the JSON in the last section verbatim. Paths under the session scratchpad name working files that were not committed.

Each claim is marked observed (measured here or read from the tree), inferred, decided, or unknown.

## The values

Artifact scope (decided): the Latin graph, `@mailwoman/neural-weights-en-us` `model.onnx`, with its data-only
overlays. The CJK graph (`neural-weights-cjk`) is a separate artifact and needs its own specification version.
Every value below applies to the Latin graph alone.

| Item                                                         | Value                                                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required countries (exact parse, address rows)               | US 0.60, FR 0.90, GB 0.80, DE 0.85, IN 0.50, ES 0.80, IT 0.80, AU 0.80, NZ 0.80                                                                      |
| Required capabilities (exact parse on named sources)         | `po_box_cedex` 0.85 with max loss 0.05; `venue_unit` 0.85; `country_token` 0.85                                                                      |
| Objective set C                                              | {US, FR, GB, DE, IN, ES, IT, AU, NZ}, address rows, equal weight                                                                                     |
| Required Q improvement                                       | 0 (lower bound and estimate of `Q_candidate - Q_published` both at least 0)                                                                          |
| Confidence level                                             | 0.95 simultaneous                                                                                                                                    |
| Multiple comparison                                          | Bonferroni over every check the specification declares (14 in v3: 9 + 3 + 1 max-loss + objective)                                                    |
| Sampling unit                                                | `group`; `rowsIndependent: false`                                                                                                                    |
| Required precision                                           | 0.08 half-width per deciding bound at the registered dataset quota                                                                                   |
| Admitted provenance                                          | `verified_unseen` only                                                                                                                               |
| Dataset quota (in the dataset manifest rather than the spec) | 1,000 address rows per country, or every available row when fewer                                                                                    |
| Published artifact                                           | 10.7.0 int8, sha256 `e90aeab4b07d03a5b599331c1e68aa70d37e96478151795bcdc6dabb82d9aca9` (md5 `5356ecba83e3774a5d9717277c051ac2`)                      |
| Retained-pending floors                                      | 15 replaced by the country and capability requirements, 3 retired to diagnostics, int8/fp32 cap retired, mask lock retained as a configuration check |

Consequence the operator should read first (inferred from the measurements below): under these values the
first release decision is `insufficient_evidence` until the evaluation collection holds `verified_unseen`
address rows for ES, IT, AU and NZ. The corpus test split holds none today (observed: ES 180 synthetic sub-venue
rows, IT 4, AU 32 and NZ 28 PO Box rows, 0 register rows), and the v0.8.0 split manifest adds holdouts for
none of them. The smallest work is in section 7. If the operator wants a v0.8.x release before that evidence
exists, the alternative is v3 without the ES, IT, AU and NZ rows (section 1 states what that gives up).

## 1. Required countries and capabilities

A country requirement checks the product claim made by a shipped locale package (`release.config.json`
`locales`: en-us, fr-fr, en-gb, de-de, en-in, es-es, it-it, en-nz, en-au, observed). A published overlay is
the repository's statement that the parser serves that country. Every shipped Latin overlay is therefore a
required country. No other country is required in v3: tier-2 and tier-3 claims (NL, PT, PL, AT, CZ, BE, CH,
HR, DK, FI, NO, SE) are coordinate-panel claims about the resolver rather than parser claims, and none ships an
overlay. They stay experimental and are reported per country by the coverage register.

FR, US, DE and GB get no requirement beyond the country minimum. The former per-tag floors (`us.postcode`,
`fr.house_number`, `de.native_locality`, …) express the same product need as whole-address exact parse on
those countries' rows, and a separate tag requirement would count the same rows twice under the correction.
The product need for the rooftop path (house number, street, postcode, locality all exact) is covered by the
country minimum because exact parse requires every span.

| Country | Product reason (observed from the tree)                                                                                              | Rows the check reads                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| US      | Rooftop geocoding, the demo default, 487 M corpus rows, `postcode-us.bin`, `pair-index-us.bin`, 95 of 144 board rows                 | all US address rows (usgov-nad, tiger, usgov-nppes, invented-house-venue, spliced-sub-venue, …) |
| FR      | Rooftop geocoding over BAN, `fr-fr` overlay with the BAN lieu-dit pair index, 55 of 67 board rows                                    | all FR address rows (ban, rendered-fr-admin-split, invented-po-box-cedex, …)                    |
| GB      | `en-gb` overlay with `postcode-gb.bin`, the GB pair index and county-as-region rows (#2676), the largest checking board (131 of 190) | all GB address rows (rendered-gb-os-open, spliced-sub-venue, gleif-lei, cordis)                 |
| DE      | `de-de` overlay with the Ortsteil pair index and the de-order evidence cell                                                          | all DE address rows (rendered-de, spliced-affix, spliced-country, spliced-sub-venue, gleif-lei) |
| IN      | `en-in` overlay with the area-line pair index over the largest gazetteer (1.57 M places)                                             | all IN address rows (osm-in)                                                                    |
| ES, IT  | `es-es`, `it-it` overlays with pair indexes, tier 2 coordinate panels                                                                | address rows: none real today                                                                   |
| AU, NZ  | `en-au` (GNAF-trained), `en-nz` (LINZ pair index, 14 of 14 board rows)                                                               | address rows: none real today                                                                   |

Capabilities (decided). A capability is registered only where the corpus test split holds rows whose source
isolates the task, because the evaluator selects rows by source. The fixtures under `data/eval/external/` are
component-keyed rather than span-annotated, and cannot be read by the exact-parse scorer without an alignment step.

| id              | Task                                                                                        | Selector                                                                                              | Minimum              | Reason                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `po_box_cedex`  | A PO Box, locked bag or CEDEX designator read as its own component beside the locality line | `sources: ["invented-po-box-cedex"]`, address rows (test split: FR 78, CA 37, AU 32, NZ 28, observed) | 0.85, `maxLoss` 0.05 | PO Box is closed-vocabulary. It replaces the former `us.po_box_real` and `fr.cedex_real` floors. The max loss is registered because a closed-vocabulary slot that moves 5 pp has lost a surface form, which the country minima would absorb. |
| `venue_unit`    | A venue name and its unit designator recovered ahead of the street line                     | `sources: ["spliced-sub-venue"]` (DE 657, US 750, GB 235, ES 180, FR 114)                             | 0.85                 | The former `us.unit_real` floor (n=34) and the #1486 sub-venue structure. It is the one held-out source with a `unit` span in a controlled position.                                                                                         |
| `country_token` | A trailing country name tagged `country` rather than absorbed into the locality             | `sources: ["spliced-country"]` (DE 1,157, IT 1)                                                       | 0.85                 | The former `us.country_homograph_f1` floor (n=54) checked the country slot. The held-out source tests the slot without the homograph confound, which stays a diagnostic.                                                                     |

Limitation (observed): these three sources are synthetic recipes whose templates also feed training. The
overlap audit classes rows by identity and group, so a test row from the same generator as a training row is
`verified_unseen` although the template is shared. The minima therefore say "the slot still works", not "the
slot generalizes"; the minimum is set below the measured level to leave that question to the diagnostics.

## 2. The objective set C

Decided: C = the nine required countries, address rows only, equal weight.

Reasons. Q is the product's primary score, and the nine countries are the product's claimed coverage, so Q
measures the claim. Experimental countries stay out of C because the policy reports them separately and
because equal weighting would let a 200-row OSM country move Q as much as US. C is fixed for v3. Adding the
tier-2 countries when they hold rows is a v4 change with its own rationale.

Cost of this choice (inferred): Q cannot be computed until every member has admitted rows, so the same four
countries that block the minima block the objective. A C of {US, FR, GB, DE, IN} would be computable from the
current split and would have made the first decision possible, at the price of a Q that ignores four shipped
overlays. I judged that the wrong trade because the policy's reason for the objective is that losses are
accepted only against a gain the product claims.

## 3. Minima: behavior kept, precision, consequences

Precision is from `release/bounds.ts` (Clopper–Pearson on the effective count, per-side tail
0.05 / 14 / 2 = 0.00179). The shipped-model column is the one scoring pass made for this record (section 9):
10.7.0 int8 on `/mnt/mw/corpus/heldout-v0.7.10-test-200.jsonl`, read with the anchor channel off (section
9 states why that degrades the read). Treat those numbers as a lower-quality reading of the published model
rather than as the registered measurement.

| Check           | Minimum           | Behavior it keeps working                                                                                                                    | Shipped reading (observed, anchor-OFF)                                                      | Bound at those rows       | Rows needed at the reading                | Higher value would                                                                                                                                                             | Lower value would                                                                 |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| US              | 0.60              | House number, street with the corpus's prefix/suffix split, locality, region, ZIP, and the NPPES venue line, all exact on three rows in five | 124/196 = 63.3%                                                                             | [52.7, 73.0] insufficient | 2,289 at p=0.63, 578 at 0.66, 212 at 0.70 | 0.70 declares the published model non-compliant (its upper bound 73.0 crosses, and a 1,000-row read at 63% fails) and blocks every release until the affix split improves 7 pp | 0.50 passes at 1,000 rows and lets a candidate drop to one row in two still exact |
| FR              | 0.90              | BAN number + street + postcode + locality exact on nine rows in ten, the rooftop path                                                        | 190/196 = 96.9%                                                                             | [91.5, 99.4] pass         | 140 at 0.97, 287 at 0.95                  | 0.95 is still met by the reading but needs 1,000+ rows to show, and a 2 pp FR loss would block                                                                                 | 0.85 would admit a candidate losing 12 pp on the product's best country           |
| GB              | 0.80              | Number + street + locality + postcode exact on four rows in five, on OS Open Names renderings                                                | 3/11 = 27.3% on 10 rendered rows + 1 sub-venue                                              | [2.3, 73.5] fail at n=11  | 550 at 0.85, 133 at 0.90                  | —                                                                                                                                                                              | —                                                                                 |
| DE              | 0.85              | Street + number + PLZ + locality exact, both orders                                                                                          | 59/60 = 98.3%                                                                               | [86.6, 100] pass          | 56 at 0.98                                | 0.90 still passes the reading at 1,000 rows                                                                                                                                    | 0.80 would admit an 18 pp loss on an overlay country                              |
| IN              | 0.50              | OSM-style rows with area line, locality and PIN exact on half the rows                                                                       | 112/200 = 56.0%                                                                             | [45.5, 66.2] insufficient | 607 at 0.56, 223 at 0.60                  | 0.60 declares the published model non-compliant                                                                                                                                | 0.40 means the en-in overlay parses fewer than half the rows exactly              |
| ES, IT, AU, NZ  | 0.80              | Register rows exact on four in five, the same bar as GB and DE whose rows are canonical renderings                                           | 0 register rows (ES 174/180 synthetic sub-venue, IT 4/4, AU 30/32 and NZ 28/28 PO Box rows) | insufficient              | 550 at 0.85, 133 at 0.90                  | 0.90 is the FR bar and these overlays have no rooftop claim                                                                                                                    | 0.70 is below the level that separates a parser from a tokenizer                  |
| `po_box_cedex`  | 0.85, loss ≤ 0.05 | The designator is one span and the locality line still parses                                                                                | 95/97 = 97.9% (CA, AU, NZ rows)                                                             | [89.6, 99.9] pass         | 102 at 0.95 (175 available)               | 0.90 is insufficient at 175 rows even at 0.95 true                                                                                                                             | —                                                                                 |
| `venue_unit`    | 0.85              | Venue and unit each one span, street line intact                                                                                             | 176/182 = 96.7%                                                                             | [90.8, 99.3] pass         | 102 at 0.95                               | —                                                                                                                                                                              | —                                                                                 |
| `country_token` | 0.85              | Country span recovered, locality not absorbed                                                                                                | 6/6                                                                                         | [34.8, 100] insufficient  | 102 at 0.95 (1,158 available)             | —                                                                                                                                                                              | —                                                                                 |

The GB fail at n=11 is a reading of 10 rendered rows under the en-us package without the en-gb overlay's
postcode binary and pair index (section 9). It describes the base graph and leaves the served GB parse unmeasured. The next dataset
draws 1,000 of the 7,096 available GB address rows (observed availability).

The US value is at the published level. The policy says the published model's answers do not define the
minimum. This value sits at that level because every product reading of exact parse is at or below it, and
deference plays no part: the US rows are dominated by the corpus's street/suffix split convention, and the
missing/additional counts on NAD rows (0.71 missing and 0.38 additional per row, observed) are the signature
of one boundary moved per failing row. A US minimum above the published level is a decision that the affix
split is a release blocker. That is a v4 decision to take once the split is measured as its own capability
(section 7). A US candidate at parity will need about 2,300 admitted rows to pass this minimum. US has 1.79 M
test rows available, so the dataset quota is the value to raise, and the minimum stays as registered.

## 4. Required improvement

Decided: `minimumImprovement: 0`. A candidate passes the objective when the lower bound of
`Q_candidate - Q_published` is at least 0 and the estimate is at least 0.

Why not a positive margin. At the recommended quota (1,000 rows per country, 9 countries, discordance 0.08)
the Q bound's half-width is about 1.0 pp and a true +2 pp candidate passes 48.0% of evaluations at margin 0
and 35.5% at margin 0.01 (simulation, section 8). A margin adds 0 protection against repeated selection: the
inflation from choosing the best of 20 candidates on the evaluation rows showed as objective coverage 96.8%
and 0.0% erroneous approval at 1,000 rows (lower than the committed 300-row scenarios' 4.5% because the
candidates differ less at this size), and it disappears entirely on fresh confirmation rows. The policy's
defense against selection is procedural (a confirmation collection the development loop never reads), so the
margin should not be spent on it.

Why not a negative tolerance. A non-inferiority margin would let a candidate at parity ship, which contradicts
"improves the declared objective". The cost of 0 is real: a candidate at exact parity never passes (0.0% in
`v3-200-rows-parity` and `v3-heldout-sizes-parity`), and a release whose purpose is not quality (a rights
cleanup like 10.7.0) needs either a measurable gain somewhere in C or a v4 that registers a tolerance with
that reason.

## 5. Confidence, correction, precision, provenance

- Confidence 0.95 simultaneous (decided). The 2026-10-20 simulation record and the runs below put joint
  coverage at 95.0 to 98.8% across the grouped scenarios at this level. The alternative 0.90 raised the +2 pp
  pass rate from 48.0% to 63.5% and lowered joint coverage to 91.5% (section 8). That rise in pass rate is smaller than
  the rise the quota delivers (section 3), so the level stays at the validated value.
- Bonferroni (decided). Checks share rows (every country check shares rows with the objective), so Šidák's
  independence assumption does not hold. Bonferroni is valid under any dependence, and at m = 14 the per-side
  tail differs by 4% relative (0.001786 against 0.001831), which moves no bound in this record. The evaluator
  counts every declared check whether or not its threshold is registered, so m is fixed by the spec text.
- Required precision 0.08 (decided). It is the half-width the registered quota delivers for a country minimum
  at 1,000 rows and p ≥ 0.6 (4.6 pp at p = 0.60, 3.1 pp at 0.90, observed from `bounds.ts`), with headroom
  for a design effect of up to about 3 from augmentation groups. The Q bound is far inside it (1.0 pp). The
  field is reported against and does not decide. A bound wider than it identifies the country whose rows the
  next dataset version must add.
- Provenance (decided): `admitted: ["verified_unseen"]`. `known_overlap` rows favor the model that trained on
  them and `unknown` rows have no history. Both are reported per class by the verdict and the coverage
  register. The 10.7.0 card records `corpus_version: v0.7.10-gb-county` and no `init_from` (observed), so the
  overlap audit can admit `verified_unseen` once that corpus's train and val files are read.

## 6. The 18 retained-pending floors, the int8 cap and the mask lock

| Floor (`v9.0.0-base.json`)                                                                  | Decision                                                                             | Reason                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `us.postcode` 93.7, `us.micro` 82.9, `us.locality` 79.6, `us.region` 89.4, `us.street` 67.7 | replaced by the US country requirement (0.60)                                        | Each was the published model's golden-dev reading minus a Wilson margin on one tag. Exact parse on US rows requires every tag at once, and per-tag F1 stays a diagnostic reported by country and component.                                                                                                                                                                       |
| `us.street_prefix` 57.0 (n=25), `us.street_suffix` 69.9 (n=30)                              | retired as deciders, kept as a diagnostic                                            | At n=25 and 30 the floors sit 34 and 27 pp below the readings and can detect only collapse. The affix split is exercised by every NAD row in the US check, and a dedicated affix capability needs a span-annotated source (section 7).                                                                                                                                            |
| `us.unit_real` 73.0 (n=34)                                                                  | replaced by `venue_unit` 0.85                                                        | Same slot, 1,936 held-out rows instead of 34.                                                                                                                                                                                                                                                                                                                                     |
| `us.country_homograph_f1` 64.8 (n=54)                                                       | replaced by `country_token` 0.85, and the homograph fixture stays a diagnostic watch | A 22.7 pp margin floor can detect only collapse. The held-out source tests the slot. The homograph confound (a country name that is also a place name) has no held-out source and is kept as a watch.                                                                                                                                                                             |
| `fr.postcode` 98.8, `fr.house_number` 96.6, `fr.region` 36.7                                | replaced by the FR country requirement (0.90)                                        | `fr.region` 36.7 records a 2026-08 reading of a tag the corpus barely annotates. It was never a product need.                                                                                                                                                                                                                                                                     |
| `de.native_locality` 89.5                                                                   | replaced by the DE country requirement (0.85)                                        | The anchor-on de-order cell is one row order, and the DE rows hold both orders (observed in `rendered-de`).                                                                                                                                                                                                                                                                       |
| `us.po_box_real` 94.3 (n=2000), `fr.cedex_real` 92.4 (n=430)                                | replaced by `po_box_cedex` 0.85 with max loss 0.05                                   | The fixtures are component-keyed and outside the collection. The held-out source has 175 rows. The max loss keeps the ratchet these two floors applied. The fixtures stay diagnostics until aligned (section 7).                                                                                                                                                                  |
| `us.intersection_real` 80.7 (n=36)                                                          | retired as a decider, kept as a diagnostic                                           | No `intersection_a`/`intersection_b` span exists in the held-out collection (observed tag census), and n=36 cannot bound a rate.                                                                                                                                                                                                                                                  |
| `arena.perturb` 59.9 (n=398)                                                                | retired as a decider, kept as a diagnostic                                           | Whole-parse-strict on perturbed golden rows. The corpus's augmentation variants (`+double-space` and the like, observed in test `source_id`s) are already inside every country check through their groups. A perturbation capability needs a selector the evaluator lacks (by augmentation class rather than source).                                                             |
| `fr.bare_street_intact` 75.0 (designed, #949)                                               | retired as a decider, diagnostic leg kept                                            | A designed tolerance on a probe the collection does not hold (BAN rows all carry a number). The promotion battery keeps the leg and reports it as a diagnostic.                                                                                                                                                                                                                   |
| `int8_vs_fp32_max_delta_pp` 1.5                                                             | retired                                                                              | The verdict is tied to the int8 artifact's sha256 and every minimum is measured on it, so a quantization collapse fails the minima directly. fp32-to-fp32 comparison stays the development rule (iron rule 3).                                                                                                                                                                    |
| Mask-regression lock (#718, 2 pp per tag under the conventions mask)                        | retained as a configuration check, outside the spec                                  | It compares the candidate with and without the ship config's conventions mask and leaves the published model out of the comparison. It is a measurement-validity refusal of the same kind as the tokenizer-comparability refusal. It does not read the published model's answers, so the migration table's description of it is inaccurate and should be corrected when v3 lands. |

## 7. Missing evidence and the smallest work

Everything below blocks a `pass` under v3 today (observed unless marked).

1. No frozen dataset. `heldout-v0.7.10-test-200.jsonl` has no `source_id` or `base_source_id` column
   (observed: keys `raw, span_starts, span_ends, span_tags, country, source`), so `freeze.run.ts` and the
   grouping refuse it, and it is stale against the current test split (it holds 11 GB and 60 DE address rows
   where the split holds 7,096 and 13,006, and it holds 0 `invented-house-venue` rows where the split holds
   2,223). Work: run `freeze.run.ts` against the v0.7.10 manifest with `--per-country 1000` (the sampler
   draws per country and kind, and the scoring pass here ran at 120 rows/s, so a 30,000-row set costs about four
   minutes per arm). Every test row carries `source_id` and 2,465,713 of 3,180,659 carry `base_source_id`
   (observed), so groups exist.
2. The overlap audit has not run. Every row is therefore `unknown`, and no class is admitted. Work: `overlap.run.ts` over
   `v0.7.10-gb-county` and the candidate's corpus, naming both model cards. Rows the v0.8.0 split repair moved
   into test (FR Corse, Lozère and Creuse region rows, GB Cornwall, observed in `SPLIT_MANIFEST.json`) will be
   `known_overlap` for 10.7.0 and excluded. FR and GB keep their v0.7.10 postcode-prefix holdouts, so admitted
   rows remain.
3. No admitted rows for ES, IT, AU, NZ. The v0.8.0 split manifest declares holdouts for 23 countries and none
   of these four (observed). Two ways out, either of which is small:
   - `packages/corpus/lib/utils/split.ts` `defaultHoldouts()`: add one held-out place per country (ES a
     postcode prefix such as `35`/`38`, IT `11`, AU `08`, NZ `96`), effective at the next base rebuild
     (v0.8.1). Those rows are then in the candidate's test split but were in 10.7.0's training, so they are
     `known_overlap` and inadmissible under v3's global admission. The evaluator change that unblocks this is
     per-check admission: a minimum check reads rows unseen by the candidate, and only the objective and max-loss
     checks need rows unseen by both. That is a one-field change in `requirements.ts` (`provenance.admitted`
     becomes `{ minimum: [...], comparative: [...] }`) and a filter in `evaluate.ts`.
   - Or an evaluation-only source for each (a publisher no training corpus reads, built through the corpus
     aligner so the spans carry `corpus-alignment` provenance, declared `split: test`). It is admissible for
     both models at once and needs no evaluator change, but it needs four new source recipes.
     The first path also serves the tier-2 countries for v4's C.
4. No confirmation collection. Work: freeze two datasets from disjoint seeds (`heldoutSampleOrder(seed)`), name
   one `evaluations.development.id` and the other `evaluations.confirmation.id`, and record every read of the
   confirmation one in the spec's rationale of the next version.
5. The inference identity. `scoreHeldoutWeights` loads `en-US` for every row and passes the row's country as
   `localeHint` (observed in `heldout/per/country.ts`). GB, DE, IN, ES, IT, NZ and FR are served with their
   overlay's pair index and, for GB, `postcode-gb.bin`. The evaluator never loads them, so the GB and
   dependent-locality readings are of the base graph rather than the product. Work: the scorer loads the locale
   package for the row's country when one ships, falling back to `en-US`, and the spec's
   `identities.inference` names that rule. Until then the GB minimum is measured on a weaker configuration
   than the one shipped, which can only block, never admit.
6. The scorer degrades silently. The pass made here printed `running anchor-OFF for THIS package, parses
   degraded` and continued (observed). The policy requires refusing a missing required artifact. Work:
   `scoreHeldoutWeights` throws when the loader reports an unfed required channel.
7. `rowsIndependent` is `false` and the held-out rows carry groups once frozen, so no check is blocked by
   grouping. Item 1 is the only work this needs.

## 8. Simulation

Scenario file: `/tmp/claude-1000/-home-lab-Projects-mailwoman/fa269c16-8422-42f8-b944-7d4b32b5974f/scratchpad/v3-scenarios.json`.
Report: `/tmp/claude-1000/-home-lab-Projects-mailwoman/fa269c16-8422-42f8-b944-7d4b32b5974f/scratchpad/v3-simulation.json`.
Command: `node packages/mailwoman/tools/eval-harness/release/simulate.run.ts --scenarios <file> --repetitions 400 --seed 2763 --out <report>`
from the `origin/main` worktree. R = 400, seeds 2763 to 3162, 110.3 s on the lab host beside the corpus
build. Every rate in the file is a simulation parameter. The published rates are the anchor-OFF readings of
section 3 where one exists and the minimum plus 0.10 where none does. Four pseudo-countries CP1 to CP4
outside C carry the three capability minima and a stand-in for the max-loss check so that m = 14 as in v3.

| Scenario                                                                                                          | Rows  | Truth meets all | Pass              | Joint coverage    | Erroneous approval | Erroneous fail | Insufficient        |
| ----------------------------------------------------------------------------------------------------------------- | ----- | --------------- | ----------------- | ----------------- | ------------------ | -------------- | ------------------- |
| v3-heldout-sizes-parity (US 196, FR 196, GB 11, DE 60, IN 200, ES 180, IT 4, AU 32, NZ 28, candidate = published) | 3257  | yes             | 0.0 [0.0, 1.0]    | 97.8 [95.8, 98.8] | n/a                | 0.0 [0.0, 1.0] | 100.0 [99.0, 100.0] |
| v3-200-rows-parity                                                                                                | 4150  | yes             | 0.0 [0.0, 1.0]    | 98.3 [96.4, 99.1] | n/a                | 0.0 [0.0, 1.0] | 100.0 [99.0, 100.0] |
| v3-200-rows-plus2 (true Q +0.02)                                                                                  | 4150  | yes             | 0.8 [0.3, 2.2]    | 98.8 [97.1, 99.5] | n/a                | 0.0 [0.0, 1.0] | 99.3 [97.8, 99.7]   |
| v3-1000-rows-plus2                                                                                                | 11350 | yes             | 48.0 [43.1, 52.9] | 95.3 [92.7, 96.9] | n/a                | 0.0 [0.0, 1.0] | 52.0 [47.1, 56.9]   |
| v3-1000-rows-plus4 (true Q +0.04)                                                                                 | 11350 | yes             | 75.8 [71.3, 79.7] | 95.3 [92.7, 96.9] | n/a                | 0.0 [0.0, 1.0] | 24.3 [20.3, 28.7]   |
| v3-1000-rows-tradeoff (IN −5 pp to 0.51, others +3 pp, Q +0.021)                                                  | 11350 | yes             | 0.3 [0.0, 1.4]    | 95.0 [92.4, 96.7] | n/a                | 0.0 [0.0, 1.0] | 99.8 [98.6, 100.0]  |
| v3-1000-rows-gb-below-minimum (GB 0.72 vs 0.80, others +3 pp)                                                     | 11350 | no              | 0.0 [0.0, 1.0]    | 95.0 [92.4, 96.7] | 0.0 [0.0, 1.0]     | n/a            | 0.0 [0.0, 1.0]      |
| v3-1000-rows-us-just-below (US 0.58 vs 0.60, others +3 pp)                                                        | 11350 | no              | 0.0 [0.0, 1.0]    | 95.0 [92.4, 96.7] | 0.0 [0.0, 1.0]     | n/a            | 94.0 [91.2, 95.9]   |
| v3-1000-rows-grouped-plus2 (groups of 3, rho 0.6)                                                                 | 11350 | yes             | 9.5 [7.0, 12.8]   | 95.0 [92.4, 96.7] | n/a                | 0.0 [0.0, 1.0] | 90.5 [87.2, 93.0]   |
| v3-1000-rows-select-k20-same (true Q −0.005, best of 20 on the same rows)                                         | 11350 | no              | 0.0 [0.0, 1.0]    | 91.0 [87.8, 93.4] | 0.0 [0.0, 1.0]     | n/a            | 100.0 [99.0, 100.0] |
| v3-1000-rows-select-k20-fresh                                                                                     | 11350 | no              | 0.0 [0.0, 1.0]    | 95.8 [93.3, 97.3] | 0.0 [0.0, 1.0]     | n/a            | 85.8 [82.0, 88.8]   |
| v3-1000-rows-plus2-margin1 (alternative: required improvement 0.01)                                               | 11350 | yes             | 35.5 [31.0, 40.3] | 95.3 [92.7, 96.9] | n/a                | 0.0 [0.0, 1.0] | 64.5 [59.7, 69.0]   |
| v3-1000-rows-plus2-conf90 (alternative: confidence 0.90)                                                          | 11350 | yes             | 63.5 [58.7, 68.1] | 91.5 [88.4, 93.9] | n/a                | 0.0 [0.0, 1.0] | 36.5 [31.9, 41.3]   |

Readings (observed from the table, inferred where stated):

- Erroneous approval is 0 in every scenario (0 of 400 in each, with a Wilson upper bound of 1.0%). A country
  8 pp under its minimum fails in 100% of evaluations at 1,000 rows. One 2 pp under is insufficient in 94% and
  never passes.
- At the held-out sample's current sizes the pass rate is 0: GB (n=11), IT (4), AU (32) and NZ (28) cannot show a
  0.80 minimum. At 200 rows per country a true +2 pp candidate passes 0.8% of the time. The quota is what makes v3
  usable, and the thresholds alone do not, which is why 1,000 rows is registered with the dataset.
- The trade-off scenario (inferred mechanism) is blocked by the IN minimum: a country 1 pp above its
  minimum needs about 21,700 rows to show it. A loss that takes a country to within the sample's resolution of
  its minimum blocks the release even when the policy would accept it. Adding rows for that country resolves it,
  and IN has those rows (3,071 available).
- Grouped variants (3 per group, correlation 0.6) lowered the +2 pp pass rate from 48.0% to 9.5%. The effective
  count is what the quota must deliver, so the freeze should count groups rather than rows against 1,000.
- Best-of-20 on the same rows lowered joint coverage to 91.0% (objective 96.8%). Fresh rows restored 95.8%.

## 9. Measurements made for this record

- Held-out sample census (observed): 7,766 rows, 95 countries. 7,429 address rows and 337 gazetteer rows.
  22 countries at 200 address rows, 9 at 100 to 199, 21 at 30 to 99, 43 under 30. GB 11, DE 60, US 196,
  FR 196. No `source_id` column. One duplicated `raw` (two `spliced-affix` rows).
- Test-split availability, corpus `v0.7.10-gb-county`, 104 test files read through DuckDB (observed, script
  `scratchpad/availability.mjs`, output `availability-v0.7.10-test.json` in the session scratchpad): US
  1,789,571 address rows, FR 1,072,881, LV 27,466, DE 13,006, GB 7,096, IN 3,071, RU 1,964, ID 1,691, PK 1,012,
  ES 180 (all `spliced-sub-venue`), IT 4, AU 32 and NZ 28 (all `invented-po-box-cedex`), CA 37. Zero rows for
  NL, PT, PL, AT, CZ, BE, CH, HR, DK, FI, NO, SE, JP, KR, TW. GB's 7,096 are 6,668 `rendered-gb-os-open`
  renderings, 235 sub-venue, 168 GLEIF and 25 CORDIS rows: no real postal register row, because Price Paid Data
  was removed (#2682).
- One scoring pass (observed): 10.7.0 int8 (sha256 verified on three copies) over the 7,766 rows through
  `scoreHeldoutWeights` from `origin/main`, 65 s, cache
  `scratchpad/cache1070/node_modules/@mailwoman/neural-weights-en-us` symlinked to the repository package
  directory. The loader printed that `files.postcode_anchor = postcode-us.bin` was "NOT in the package" and
  ran anchor-OFF, although the file is in that directory (observed). Cause unknown. The distinguishing test
  is to stage the same package with `tools/dev-tools/stage-candidate-cache.run.ts` and compare the warning.
  Address rows exact: 5,909 of 7,429 (79.5%). Gold-recovered equals exact on every country but ID, so
  additional spans without a missing span are rare. Per-country rates are in section 3 and in
  `scratchpad/heldout-10.7.0-exact.json`. Notable experimental readings: CN 0/199 (Han script through the
  Latin graph, while the served path routes it to the CJK graph, which is why CN is outside this spec), UY 20.5%,
  TT 6.5%, IM 40.0%, VN 62.0%, EG 70.5%, PF 57.0%, and LV, MD, RS, AR, NC at 100%.
- Bounds (observed from `bounds.ts`, m = 14): section 3's table and the row counts needed per (rate, minimum).

## 10. Open risks

- The US minimum is at the published level under a degraded read. If the served configuration reads US
  materially higher, 0.60 is loose. If the affix split is the whole gap, a v4 that measures the split as a
  capability should raise it. Unknown until the first registered run.
- GB and DE evidence is renderings of registers rather than postal records. ES, IT, AU and NZ have 0 register
  rows. A minimum met on renderings says the model reads the register's canonical form, and leaves what users
  type unmeasured.
- Synthetic capability sources share templates with training, so `verified_unseen` is true by identity and
  weaker in substance.
- The CJK graph has no specification. JP, KR, TW and CN releases of `neural-weights-cjk` are ungoverned until
  a v3-cjk exists.
- The evaluator admits one provenance class for every check, so a newly held-out country is unmeasurable for
  one release cycle unless item 3 of section 7 lands.
- Simulation rates are constant within a country. Heterogeneity across sources (NAD at 63.9%, NPPES at 26.3%,
  TIGER at 90.9% inside US, observed) is not modelled, and a candidate that shifts the source mix of its
  failures moves the design effect the simulation did not draw.

## The v3 specification to commit

```json
{
	"schemaVersion": 2,
	"specVersion": "3",
	"rationale": "Version 3 registers the numerical requirements decided on 2026-10-20 (scratchpad/2026/10/20/RELEASE_THRESHOLDS-fable.md, issue #2763) for the Latin graph, @mailwoman/neural-weights-en-us model.onnx and its data-only overlays. Required countries are the shipped Latin locale packages. Capabilities are registered where the corpus test split holds a source that isolates the task. The objective set is the required countries. The published identity is 10.7.0 int8. Dataset, candidate and evaluation ids are registered when frozen; until then every evaluation is insufficient evidence.",
	"requirements": [
		{
			"id": "country-US",
			"kind": "country",
			"country": "US",
			"reason": "Shipped en-us graph: rooftop geocoding, the demo default, postcode-us.bin and pair-index-us.bin. Exact parse of house number, street with the corpus affix split, locality, region and ZIP on three rows in five.",
			"minimum": 0.6,
			"select": { "kinds": ["address"] }
		},
		{
			"id": "country-FR",
			"kind": "country",
			"country": "FR",
			"reason": "Shipped fr-fr overlay: rooftop geocoding over BAN and the lieu-dit pair index. Number, street, postcode and locality exact on nine rows in ten.",
			"minimum": 0.9,
			"select": { "kinds": ["address"] }
		},
		{
			"id": "country-GB",
			"kind": "country",
			"country": "GB",
			"reason": "Shipped en-gb overlay: postcode-gb.bin, the GB pair index and county-as-region rows. Number, street, locality and postcode exact on four rows in five.",
			"minimum": 0.8,
			"select": { "kinds": ["address"] }
		},
		{
			"id": "country-DE",
			"kind": "country",
			"country": "DE",
			"reason": "Shipped de-de overlay with the Ortsteil pair index. Street, number, PLZ and locality exact in either order on seventeen rows in twenty.",
			"minimum": 0.85,
			"select": { "kinds": ["address"] }
		},
		{
			"id": "country-IN",
			"kind": "country",
			"country": "IN",
			"reason": "Shipped en-in overlay with the area-line pair index. Area line, locality and PIN exact on half the OSM-style rows.",
			"minimum": 0.5,
			"select": { "kinds": ["address"] }
		},
		{
			"id": "country-ES",
			"kind": "country",
			"country": "ES",
			"reason": "Shipped es-es overlay with a pair index; tier-2 claim. Register rows exact on four in five.",
			"minimum": 0.8,
			"select": { "kinds": ["address"] }
		},
		{
			"id": "country-IT",
			"kind": "country",
			"country": "IT",
			"reason": "Shipped it-it overlay with a pair index; tier-2 claim. Register rows exact on four in five.",
			"minimum": 0.8,
			"select": { "kinds": ["address"] }
		},
		{
			"id": "country-AU",
			"kind": "country",
			"country": "AU",
			"reason": "Shipped en-au overlay, GNAF-trained; tier-2 claim. Register rows exact on four in five.",
			"minimum": 0.8,
			"select": { "kinds": ["address"] }
		},
		{
			"id": "country-NZ",
			"kind": "country",
			"country": "NZ",
			"reason": "Shipped en-nz overlay with the LINZ pair index. Register rows exact on four in five.",
			"minimum": 0.8,
			"select": { "kinds": ["address"] }
		},
		{
			"id": "po_box_cedex",
			"kind": "capability",
			"task": "Reading a PO Box, locked bag or CEDEX designator as one component beside an intact locality line",
			"metric": "exact_parse",
			"reason": "Closed-vocabulary slot behind the former us.po_box_real and fr.cedex_real floors.",
			"minimum": 0.85,
			"maxLoss": 0.05,
			"maxLossReason": "A closed-vocabulary slot that moves 5 pp has lost a surface form; the country minima would absorb a loss this size.",
			"select": { "kinds": ["address"], "sources": ["invented-po-box-cedex"] }
		},
		{
			"id": "venue_unit",
			"kind": "capability",
			"task": "Recovering a venue name and its unit designator ahead of the street line",
			"metric": "exact_parse",
			"reason": "The former us.unit_real floor (n=34) on the one held-out source with a controlled unit span (1,936 rows).",
			"minimum": 0.85,
			"select": { "kinds": ["address"], "sources": ["spliced-sub-venue"] }
		},
		{
			"id": "country_token",
			"kind": "capability",
			"task": "A trailing country name tagged country rather than absorbed into the locality",
			"metric": "exact_parse",
			"reason": "The former us.country_homograph_f1 floor (n=54) protected the country slot; the homograph confound stays a diagnostic.",
			"minimum": 0.85,
			"select": { "kinds": ["address"], "sources": ["spliced-country"] }
		}
	],
	"objective": {
		"countries": ["US", "FR", "GB", "DE", "IN", "ES", "IT", "AU", "NZ"],
		"select": { "kinds": ["address"] },
		"minimumImprovement": 0
	},
	"identities": {
		"dataset": { "id": null, "sha256": null },
		"scorer": { "id": "packages/mailwoman/tools/eval-harness/score/exact-parse.ts", "revision": "02fec0af5" },
		"inference": {
			"description": "NeuralAddressClassifier.parse with the row's country as localeHint, as scoreHeldoutWeights calls it; the en-US package for every row. Section 7 item 5 of the decision record asks for the served locale package instead.",
			"options": { "postcodeRepair": true, "localeHint": "row.country" }
		},
		"published": {
			"description": "@mailwoman/neural-weights-en-us 10.7.0 model.onnx (int8, md5 5356ecba83e3774a5d9717277c051ac2)",
			"sha256": "e90aeab4b07d03a5b599331c1e68aa70d37e96478151795bcdc6dabb82d9aca9"
		},
		"candidate": { "description": "The exact release artifact's model.onnx", "sha256": null }
	},
	"statistics": {
		"confidenceLevel": 0.95,
		"multipleComparison": "bonferroni",
		"samplingUnit": "group",
		"rowsIndependent": false,
		"groupingAssumption": "A row's independent unit is its group within its country: base_source_id when derived, else source_id. Rows are not declared independent, so a check that reads an ungrouped row is insufficient evidence. Limitation: structure shared across groups (one source's conventions, one place's many addresses) is not modelled. The dataset quota counts groups, not rows, against 1,000 per country.",
		"requiredPrecision": 0.08
	},
	"provenance": { "admitted": ["verified_unseen"] },
	"evaluations": {
		"development": {
			"id": null,
			"description": "Unregistered: freeze heldout-<corpus>-dev with one seed; used for recipe, checkpoint and seed selection."
		},
		"confirmation": {
			"id": null,
			"description": "Unregistered: freeze heldout-<corpus>-confirm with a disjoint seed; read only for the release decision, every read recorded in the next spec version's rationale."
		}
	}
}
```
