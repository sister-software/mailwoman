# Inferential resolution, falsifiers F1 and F2: negative evidence on the board's misses, naming families across 300 US localities

Date: 2026-09-03. Record for #1571, the first two falsifiers of the design record
`docs/superpowers/plans/2026-08-08-inferential-resolution.md` ("Falsifiers to run before building
anything"). Measurement only; no mechanism was built and nothing here proposes a runtime surface.
Pre-registration: the #1571 comment of 2026-09-03 (thresholds, denominators and source bases were
posted before any number was read). Point-in-time; numbers are not updated.

## Questions

- **F1.** An unknown street in a locality whose street set is held completely is known not to be
  any of them. On the board's missed rows, does that exclusion ever remove a wrong candidate while
  leaving the right one standing — and at what rate would it fire on a correct answer?
- **F2.** Do street-naming families (presidents, trees, numbered) exist at measurable rates across
  sampled localities, and are a family's streets spatially clustered rather than scattered?

## Inputs

| Input              | Artifact                                                                                                                                                                        | Rows in play                                                                              | Provenance                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Board              | `packages/mailwoman/lib/eval-harness/gauntlet/cases/<cc>/*.jsonl` at `80fb51f34`, loaded by `loadRegressionCases`                                                               | 651 rows (425 `pass` passing, 4 `pass` failing, 221 `improvement_target`, 1 `known_fail`) | the committed regression corpus; graded with `checkCase` through `buildGauntletDeps`, production pins                       |
| BAN streets (FR)   | `$MAILWOMAN_DATA_ROOT/ban/street-centroids-fr.db`, derived from `address-points-fr.db`                                                                                          | 2,195,655 streets across 32,539 communes                                                  | ban:fr release 2026-05-18, md5 `bc3873350f8746edb7dc0817450c89f1`, 26,041,013 points, 101 departements; Licence Ouverte 2.0 |
| TIGER streets (US) | `$MAILWOMAN_DATA_ROOT/interpolation/interpolation-us-<st>.db` × 52                                                                                                              | named street segments keyed by `county_fips` and `postcode`                               | source `tiger:edges`, release TIGER2023                                                                                     |
| NAD/OA points (US) | `$MAILWOMAN_DATA_ROOT/address-points/address-points-us-<st>.db` × 54 (52 used; `il-cook` is a subset of `il` — Chicago holds 598,283 points in both — and `vi` has no locality) | 28,733 localities with a `locality_norm`; 5,584 with ≥ 200 distinct streets               | release 2026-05-20.0, 124,928,159 points, of which 85,482,142 NAD                                                           |
| WOF ancestry       | `$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db`, tables `ancestors` + `concordances` (`uscensus:geoid`)                                                                     | the resolved locality's county ancestors                                                  | the shipped admin gazetteer                                                                                                 |

### What each source's completeness rests on

The layer vocabulary (`packages/core/lib/layers/schema.ts`: `designated`, `surveyed`,
`source_present`; `supportsExclusion`) admits an exclusion from the first two only.

- **BAN — designated.** The publisher declares BAN the national reference address base for every
  commune (Loi 3DS, art. 169). The designation is of the register; per-commune BAL certification is
  not a column in the extract, so a commune's street list is "designated complete" by mandate, not
  by audit. Treated as `designated` here. The Paris row below (a 2021 esplanade the register does
  not hold) is what that caveat costs.
- **TIGER EDGES — designated, with a caveat a reader may refuse.** MAF/TIGER is the Census Bureau's
  road inventory for every county, but this extract holds only edges carrying an address range. Read
  as `source_present`, no US source on the data root supports an exclusion and the US county arm is
  a counterfactual. Both readings lead to the same verdict below.
- **NAD/OA — source_present.** Voluntary state and local submissions plus a compilation. Cannot
  license an exclusion; measured only as the counterfactual "if locality-level completeness were
  designated".
- **`tiger.db` — unusable for either falsifier.** `tiger_streets` holds 3,995,987 segments in 9
  states with ZIP linkage only, and `tiger_places` holds 0 rows. No street-to-place linkage exists on
  the data root, and building one would be ingestion, which this task excluded.

## Corrections to the pre-registration

Two counts in the pre-registration were wrong and are corrected here rather than silently.

1. **The board is 651 rows, not 930.** 930 was `wc -l` over every `.jsonl` under `cases/`, which
   includes `cases/generalization/` (279 rows) — a directory `loadRegressionCases` deliberately
   excludes (its country-directory filter is `^[a-z]{2}$`). The regression board the harness grades is
   651 rows, the same figure the 2026-09-03 decomposition comment on #1571 reports.
2. **F2's locality pool is drawn from 52 extracts, not 54.** `address-points-us-il-cook.db` duplicates
   `il` and `address-points-us-vi.db` carries no `locality_norm`.

Every threshold, denominator definition and outcome class is unchanged.

## Method

### F1

1. `scratchpad/1571/f1-run-board.ts` runs all 651 rows through the shipped pipeline the way
   `runRegressionLayer` does (`routeCountry` overlay routing, `defaultCountry`, locale fuzzy scope,
   production pins) and writes each row's `checkCase` issues, parsed spans and resolved hierarchy. A
   row is **missed** when `checkCase` returns any issue, regardless of its status column.
2. `scratchpad/1571/f1-negative-evidence.ts` keeps rows with `country ∈ {US, FR}`, a non-null parsed
   `street`, and a `locality` rung in the resolved hierarchy, then asks three arms whether the parsed
   street is held in the resolved unit and in the truth unit:
   - **FR commune** — unit `stripArrondissement(normalizeLocalityForKey(name))` in
     `street_centroid.locality_base`; street `normalizeStreetForKeyLocale(street, "fr")` against
     `street_norm`, with the `foldName` form against `name_key` as a second chance. Truth unit is the
     asserted locality; when only a coordinate is asserted, "the street is held within about 2 km of
     the truth point" (0.02° latitude, 0.03° longitude) stands in for the containing commune.
   - **US county** — every `county` ancestor of the resolved WOF locality, mapped through the
     `uscensus:geoid` concordance to `street_segment.county_fips`; street `normalizeStreetForKey`. A
     street present in any county ancestor counts as present. Truth unit is the county holding the
     street under the truth ZIP (`expectComponents.postcode`, else the ZIP in the input).
   - **US locality** (counterfactual) — `locality_norm` in the state's NAD/OA extract.
3. Outcomes per row: **silent** (street present in the resolved unit); **fires, truth survives**
   (absent from the resolved unit, present in the truth unit); **fires, truth absent**; **fires, no
   truth unit**. The same test on passing rows is the comparison arm: the false-fire rate.
4. Every firing row was re-probed by a second path (`LIKE` on the name body against the same unit)
   before it was reported, per the standing rule on measured absences.

### F2

1. `scratchpad/1571/f2-inventory.ts` builds the pool — every `(state, locality_norm)` with ≥ 200
   distinct `street_norm` — and draws 300 localities uniformly with `mulberry32(1571)` over the pool
   sorted by `(state, locality)`. The draw covers 41 states; the largest shares are CA 31, TX 19,
   FL 18, IL 16, OH 15. The sampled localities hold 227,822 distinct streets (median 432 per
   locality).
2. `scratchpad/1571/f2-affinity.ts` reads each locality's streets with their centroid (mean of the
   locality's address points on that street), derives the **core name** (edge directionals removed,
   one trailing USPS suffix word from `US_STREET_SUFFIX_LOOKUP` removed) and matches it against the
   committed lists in `scratchpad/1571/families.ts`, reproduced below.
3. For each (locality, family) with ≥ 3 members: observed statistic = mean pairwise haversine
   distance among the family's centroids; null = 500 draws (`mulberry32(1571 + localityIndex)`) of the
   same number of streets from the same locality; `p` = share of draws at or below the observed mean;
   **clustered** when `p < 0.05`. Under no clustering 5% of eligible pairs read clustered.

The word lists, verbatim:

- **presidents** (40): washington, adams, jefferson, madison, monroe, jackson, van buren, harrison,
  tyler, polk, taylor, fillmore, pierce, buchanan, lincoln, johnson, grant, hayes, garfield, arthur,
  cleveland, mckinley, roosevelt, taft, wilson, harding, coolidge, hoover, truman, eisenhower,
  kennedy, nixon, ford, carter, reagan, bush, clinton, obama, trump, biden.
- **trees** (50): oak, maple, elm, pine, cedar, birch, walnut, chestnut, hickory, spruce, willow,
  poplar, ash, cherry, magnolia, sycamore, dogwood, cypress, redwood, sequoia, aspen, beech, hemlock,
  juniper, laurel, linden, locust, mulberry, palm, pecan, fir, holly, hawthorn, cottonwood, alder,
  elder, hazel, apple, peach, pear, plum, olive, mesquite, palmetto, tamarack, larch, buckeye,
  catalpa, boxwood, ironwood.
- **numbered**: core matches `^\d+(st|nd|rd|th)?$`.

## Results — F1

### The board

651 rows graded; 220 missed (4 of 429 `pass` rows, 215 of 221 `improvement_target`, 1 of 1
`known_fail`). US and FR together: 155 rows, 26 missed (17 of 92 US, 9 of 63 FR). Of the 155, 31
carry no parsed street and a further 44 no resolved locality rung, which leaves 80 rows for the
arms (18 missed, 62 passing).

Of the 26 missed US/FR rows, 8 assert a truth locality. In 7 of those 8 the resolved locality names
the truth place (Tonopah is resolved by name and lands 91 km away — a same-named place, not a
different name); in 1 (`fr-cs-plougonvelin-trailing-region`) it names a different place. The other
18 assert no locality. By failure shape: 13 of the 26 land in the right locality and miss on
coordinate or tier alone (0.20 km off against a 150 m tolerance, `admin` instead of
`address_point`); 2 resolve no coordinate at all (the bare `3 Rue des Lyonnais` rows); 7 miss on a
venue or street span; 2 are identity misses (Plougonvelin by name, Tonopah by same name); 2 are an
`abstain` row that resolved and a wrong-continent row, neither carrying a parsed street.

### Per arm

| Arm                               | Missed rows with street + resolved locality | unit in source | silent | fires, truth survives | fires, truth absent | fires, no truth | Passing rows, unit in source | false fires on passing rows |
| --------------------------------- | ------------------------------------------: | -------------: | -----: | --------------------: | ------------------: | --------------: | ---------------------------: | --------------------------: |
| FR commune (BAN)                  |                                           5 |              5 |      2 |             **0 / 5** |                   3 |               0 |                           30 |          **3 / 30 (10.0%)** |
| US county (TIGER)                 |                                          13 |             11 |      7 |            **0 / 11** |                   3 |               1 |                           26 |          **6 / 26 (23.1%)** |
| US locality (NAD, counterfactual) |                                          13 |              6 |      4 |             **0 / 6** |                   0 |               2 |                           17 |          **4 / 17 (23.5%)** |

Two US missed rows fall outside the county source: Southington, CT (WOF carries the pre-2022 county,
TIGER2023 keys Connecticut by planning region) and the second Bristol row (no county ancestor with a
GEOID).

### Every firing row, re-probed

| Row                                                                                          | Arm                    | Parsed street → key                                        | Resolved unit                 | Second-path probe of the same unit                                                          | Cause                                                                                                                             |
| -------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `fr-op3-halle-o-lognes` (miss)                                                               | FR commune             | `Cr des Petites Écuries` → `cr des petites ecuries`        | Lognes                        | holds `cours des petites ecuries`                                                           | abbreviation `Cr` not expanded by the fold                                                                                        |
| `venue-bangkok-factory-boulogne` (miss)                                                      | FR commune             | `Bis Rte de la Reine` → `bis route de la reine`            | Boulogne-Billancourt          | holds `route de la reine`                                                                   | repetition indicator swallowed into the street span                                                                               |
| `fr-cs-plougonvelin-trailing-region` (miss)                                                  | FR commune             | `Rue de l'Église` → `rue de leglise`                       | Bretagne-de-Marsan (wrong)    | truth commune holds `place de leglise`, no `rue`; resolved commune holds no `eglise` street | absent from both units: the one wrong-locality miss, and the exclusion cannot tell the two apart                                  |
| `fr-street-centroid-accented-commune-sete` (pass)                                            | FR commune             | `Allée Pierre Barthas, Sète` → `allee pierre barthas sete` | Sète                          | holds `allee pierre barthas`                                                                | commune name swallowed into the street span                                                                                       |
| `venue-american-express-bercy` (pass)                                                        | FR commune             | `Espl. Johnny Hallyday` → `espl johnny hallyday`           | Paris                         | no `%johnny hallyday%` in Paris                                                             | register absence on a correct answer (a 2021 esplanade)                                                                           |
| `venue-cathedrale-strasbourg` (pass)                                                         | FR commune             | `Pl.` → `place`                                            | Strasbourg                    | —                                                                                           | junk span                                                                                                                         |
| `us-athens-ga-30601` (pass)                                                                  | US county              | `Broad St` → `broad street`                                | Clarke County 13059           | holds `east broad street`, `west broad street`, `old broad street`                          | directional variant                                                                                                               |
| `us-op3-gayway-corner-fruitland` (pass)                                                      | US county              | `Gayway Corner` → `gayway corner`                          | Payette County 16075          | no `%gayway%`                                                                               | a place name tagged as a street                                                                                                   |
| `us-op3-four-corners-monument` (miss)                                                        | US county              | `NM-597` → `nm-597`                                        | Apache County 04001           | no `%597%`                                                                                  | route designation absent from ranged edges                                                                                        |
| `us-op4-food-city` (miss)                                                                    | US county              | `Little Crk Xing` → `little crk crossing`                  | Bristol city 51520            | no `%little cr%`                                                                            | absent from the resolved unit and the truth ZIP's unit                                                                            |
| `us-op4-odnr-aquatic-visitors-center-avc` (miss)                                             | US county              | `OH-357` → `oh-357`                                        | Ottawa County 39123           | holds `sr-357`                                                                              | route-prefix convention (`OH-` vs `SR-`)                                                                                          |
| `us-op3-patio-town-square-white-house` (pass)                                                | US county              | `Portland Rd` → `portland road`                            | Robertson County 47147        | Sumner County 47165 holds `portland road`                                                   | WOF gives White House one county ancestor; the town straddles two — a fire on a correct answer                                    |
| `us-op3-island-lake-duplicate-degenerate` (miss)                                             | US county, US locality | `Island Lake Road Apartments`                              | Island Lake, IL               | —                                                                                           | venue tagged as street                                                                                                            |
| `us-r5-astoria-no-parent-unchanged` (pass)                                                   | US county              | `37 42nd St` → `37 42nd street`                            | Queens 36081                  | holds `42nd street` forms                                                                   | hyphenated Queens house number swallowed into the span                                                                            |
| `us-street-brooklyn-st-pauls` (pass)                                                         | US county              | `Saint Pauls PL St` → `saint pauls pl street`              | Kings 36047                   | —                                                                                           | doubled suffix in the span                                                                                                        |
| `us-street-name-madison-square-west` (pass)                                                  | US county              | `Madison Square West`                                      | Madison Square, NE 31115      | —                                                                                           | a bare street row resolved to a wrong locality the row never asserted; the exclusion fires correctly but no truth unit credits it |
| `us-op4-hartford-healthcare-center-for-healthy-aging` (miss)                                 | US locality            | `Queen St #101` → `queen street #101`                      | Southington, CT               | —                                                                                           | unit token swallowed into the span                                                                                                |
| `us-5th-ave-ny-rescore`, `us-athens-ga-30601`, `us-op3-patio-town-square-white-house` (pass) | US locality            | `5th Ave`, `Broad St`, `Portland Rd`                       | New York, Athens, White House | NAD holds directional or numbered variants                                                  | the same directional/variant class as the county arm                                                                              |
| `us-op4-donkey-s-place-downtown` (pass)                                                      | US locality            | `Washington St`                                            | Mount Holly, NC               | —                                                                                           | no truth unit                                                                                                                     |

Of the 18 distinct firing (row, arm) events across the FR and US county arms, 12 are the parsed
street keyed differently from the register (abbreviation, directional, route prefix, a span carrying
a commune, house number, unit or repetition indicator), 3 are a register absence or a place name in
the street slot on a correct answer, 1 is WOF county ancestry (one county for a two-county town), and
2 are absent from both units. **Zero** removed a wrong locality while the truth locality survived.

### Verdict against the pre-registered rules

- "Fires, truth survives" ≥ 10% of D1 with at least 5 rows: **0 of 5** (FR), **0 of 11** (US
  county), **0 of 6** (US locality counterfactual). Fails in every arm.
- False-fire rate on passing rows ≤ 2%: **10.0%** (3 of 30), **23.1%** (6 of 26), **23.5%** (4 of
  17). Fails in every arm, by 5× to 12×.

**F1 fails.** Negative evidence, as the plan states it, changes no answer on this board and would
have damaged one correct answer in ten (FR) to one in four (US).

## Results — F2

300 localities, 227,822 distinct streets. Under the null, 5% of eligible (locality, family) pairs
read clustered.

| Family     | Localities with ≥ 1 member | Localities with ≥ 3 members (eligible) | Clustered at p < 0.05, of eligible | Median share of a locality's streets | p90 share | Members / streets, pooled | Median observed ÷ null mean distance |
| ---------- | -------------------------: | -------------------------------------: | ---------------------------------: | -----------------------------------: | --------: | ------------------------: | -----------------------------------: |
| trees      |                 288 of 300 |                     275 of 300 (91.7%) |             **152 of 275 (55.3%)** |                            **2.70%** |     5.94% |    5,464 / 227,822 (2.4%) |                                 0.73 |
| presidents |                 270 of 300 |                     209 of 300 (69.7%) |                  94 of 209 (45.0%) |                                0.98% |     3.15% |    2,491 / 227,822 (1.1%) |                                 0.69 |
| numbered   |                 162 of 300 |                     144 of 300 (48.0%) |                  97 of 144 (67.4%) |                                0.30% |    17.72% |   10,906 / 227,822 (4.8%) |                                 0.48 |

Distribution of `p` among eligible pairs (bins `< 0.05`, `0.05–0.25`, `0.25–0.5`, `0.5–0.75`,
`≥ 0.75`): trees 152 / 52 / 29 / 22 / 20 of 275; presidents 94 / 51 / 28 / 17 / 19 of 209; numbered
97 / 9 / 10 / 6 / 22 of 144. A flat null would put 5% / 20% / 25% / 25% / 25% in those bins.

Worked examples (state, locality, members, observed vs null mean km, p): Andalusia, AL — 23 tree
streets, 5.89 vs 12.94 km, p = 0.000; Collinsville, AL — 4 tree streets, 0.47 vs 8.90 km, p = 0.000;
De Witt, AR — 19 president streets (Lincoln, Adams, Harrison, Jackson, Jefferson, Madison …),
p = 0.000; Bakersfield, CA — 55 president streets, p = 0.000. Not clustered: Albertville, AL — 4
president streets, p = 0.456; Elkmont, AL — 3, p = 0.572.

### Verdict against the pre-registered rules

A family is worth a mechanism only if ≥ 20% of sampled localities carry ≥ 3 members, ≥ 50% of those
pairs are clustered at p < 0.05, and the family's median share is ≥ 2%.

- **trees: 91.7% / 55.3% / 2.70% — passes all three.**
- presidents: 69.7% / 45.0% / 0.98% — fails the clustering bar by 5.0 points and the share bar.
- numbered: 48.0% / 67.4% / 0.30% — fails the share bar; and the pre-registration excluded it from
  carrying F2 alone.

**F2 passes, on trees.** Naming families are real and clustered at roughly eleven times the null
rate (55.3% vs 5%); the family's streets sit at 73% of the distance random streets of the same
locality would.

## Reading

Observation: the board's US/FR misses are precision and span misses, not identity misses. Thirteen
of 26 land in the right locality at the wrong tier or a few kilometers off and 7 more miss on a
venue or street span; one lands in a wrong locality by name, and the one wrong same-named place
(Tonopah, 91 km) carries `N Main St`, a street present in the wrong county too, so the exclusion is
silent there. Inference: a
locality-scoped street exclusion has no target on this board, and the class it exists for — the
wrong-continent, same-named place of the FIRST_PASS analysis — is exactly the class where a common
street name is held on both sides.

Observation: two thirds of the fires (12 of 18) are the parsed street keyed differently from the
register — `Cr` for cours, `Broad St` for `east broad street`, `OH-357` for `sr-357`, a span carrying
the commune or the house number. Inference: register membership tested on the parser's span with the
builder's fold is the wrong instrument. Any negative-evidence mechanism would first need a
membership test at least as forgiving as the resolver's own street lookup (directionals,
abbreviations, route prefixes, span trimming), and its false-fire rate should be re-measured with
that test before the mechanism is judged again. That is a precondition, not a re-run of this
falsifier.

Observation: one fire on a correct answer came from WOF ancestry (White House, TN has two counties
and one ancestor row), one from a register absence in a designated source (the Bercy esplanade).
Inference: `designated` is a claim about the register's mandate, not about a row, and the county unit
inherits every gap in the ancestry table. A per-locality completeness claim would need to be measured
(`surveyed`) before it could license an exclusion the resolver acts on.

Observation: naming families cluster. Trees are present in 288 of 300 localities and clustered in
152 of 275 eligible ones. Inference: the structural-affinity source is real at the rates the
pre-registration asked for, but small — 2.4% of streets pooled, 1.1% for presidents — and F1 shows
the board carries no row of the shape it would act on (an unknown street inside a known locality).
The phenomenon is established; the demand is not.

## Consequences

1. Stage 2 of the staged path on #1571 (negative evidence) is not earned by the board. It is not
   scheduled.
2. The coverage-register work #1672 asked for (a `basis` beside `completeness`) stays correct and
   stays independent of this result; nothing here changes the layer contract.
3. Structural affinity (constraint source 3) survives its falsifier on the trees family. No mechanism
   is built: with F1's D1 at zero useful rows there is nothing for it to act on. The finding is
   recorded as an input the support-surface design may draw on, and the trigger for revisiting it is
   board rows of the unknown-street-in-known-locality class, not more measurement.
4. Two defects surfaced as by-products and belong to their owners, not to this record: WOF's single
   county ancestor for a two-county locality (White House, TN), and Connecticut's county keying
   (WOF pre-2022 counties vs TIGER2023 planning regions), which makes every CT locality
   `unit_not_in_source` for a county-keyed lookup.
5. The four remaining falsifiers' status on #1571: F1 failed (this record), F2 passed (this record),
   F3 not run, F4 measured twice and failed (#1684 experiment 3; #1975 at 69.6% exact).

## Local calls made without asking

- Board denominator corrected from the pre-registered 930 to 651 (above).
- The truth unit for a US row on the county arm is the county holding the street under the truth
  ZIP; for an FR row with only a coordinate, a 2 km neighborhood stands in for the containing commune.
- A street present in any county ancestor of the resolved locality counts as present (conservative
  toward `silent`).
- `il-cook` excluded from the F2 pool as a duplicate of `il`.

## Reproduce

`MAILWOMAN_DATA_ROOT=… node scratchpad/1571/f1-run-board.ts > scratchpad/1571/board-results.jsonl`
(651 rows, about 4 minutes on the lab host), then `node scratchpad/1571/f1-negative-evidence.ts`;
`node scratchpad/1571/f2-inventory.ts` then `node scratchpad/1571/f2-affinity.ts` (about 3 minutes).
All scripts are git-ignored scratch under `scratchpad/1571/`; every database read is `node:sqlite`
read-only. Inputs as in the table above.
