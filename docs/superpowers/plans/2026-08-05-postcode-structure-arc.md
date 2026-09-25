# Postcodes carry structure we never read — preregistration for three mechanisms

This arc opened on 2026-08-05 from the operator's sketch, which makes three claims. In the
operator's order:

1. We cannot enumerate every postcode, but we can enumerate the rules for each country's postcodes.
   A valid shape builds confidence, and it also works as exclusion. Several things look like
   postcodes but are postcodes only when the other placetypes make sense relative to one another.
2. The coherence of its sibling placetypes confirms a postcode-looking token. In the reverse
   direction, an ambiguous place-name token gains validity if the given postcode contains it.
3. Postcodes encode a hierarchy. A partial or unknown code still encodes approximate admin ancestry
   and can serve as a prior.

This document inventories what already implements each direction, reports the measurements that
size the remaining headroom, and pre-registers three mechanisms. **It implements no mechanism.**
The bars are fixed before results, following the PIX1 preregistration practice.

## The house term the sketch was reaching for

The operator called it "placetype concordance validation". The project already has a name for this
idea, and the name is not concordance.

- **`coherence`** is the mechanism name. Four passes use it. All are default-on, and all live in
  `resolver/resolve.ts` or beside it: `applyAdminCoherence` (`resolver/resolve.ts:345`),
  `applyExplicitCountryCoherence` (`resolver/resolve.ts:547`), `applyRegionCountryCoherence`
  (`resolver/resolve.ts:636`), `findPostcodeCountryScope` (`resolver/postcode-country-coherence.ts:227`).
- **`joint-consistency`** is the doctrine name. All four docstrings use the phrase verbatim ("the
  joint-consistency resolve"), and the authority is
  `docs/engineering/design/2026-06-29-joint-consistency-resolution.mdx`, `status: active-decision`:
  "an address should resolve to wherever its spans are jointly consistent in the gazetteer's
  containment graph."
- **`concordance`** is the older term for the same idea, and the code already uses it for two other
  things. It refers to (a) the retired `jointReconcile` beam-search bonus
  (`core/pipeline/reconcile.ts:126`, `concordanceWeight`, default-off since #566, see
  `core/pipeline/runtime-pipeline.ts:479`) and (b) the unrelated WOF external-ID table
  (`resolver-wof-sqlite/unified-schema.ts`). The reader-facing definition at
  `docs/records/site-2026-08/understanding/the-problem/what-is-a-concordance.mdx:16` still describes
  the operator's concept exactly, which is why the word came to mind. A new mechanism with this name
  would collide with both existing uses.

**New work in this arc is therefore named `*Coherence` and described as joint-consistency.** Naming
a mechanism `concordance` counts as a defect.

## Part A — Inventory

Every row describes something that already exists. The last column gives the operator direction it
covers, so the design in Part C proposes only what is missing.

### A.1 Shape rules per country (direction 1)

| Thing                             | Where                                                     | Role                                                                                                                     | Direction |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------- |
| Per-system postcode shape + brand | `codex/{us,de,fr,ca,gb,jp,au,nz,es,it}/`                  | 10 modules, each a `Tagged` brand + `*_PATTERN` + normalizer. `codex/us/zipcode.ts:169`, `codex/gb/postcode.ts:55`, etc. | 1         |
| `candidateSystemsForPostcode`     | `codex/postcode-systems.ts:59`                            | The shape oracle: which of 8 systems accept this string. `SYSTEM_ACCEPTS` at `:43` — `es`/`it` deliberately absent       | 1         |
| `ADDRESS_SYSTEM_CONVENTIONS`      | `codex/address-system-conventions.ts:43`                  | The only actual postcode RECORD type (`postcodePattern` + `forbiddenTags`). **2 entries**: `fr`, `gb`                    | 1         |
| `PATTERNS` (query-shape)          | `query-shape/known-formats.ts:31`                         | 11 rows, 9 `KnownFormat` members. Carries `nl_postcode`, which codex has no module for                                   | 1         |
| `POSTCODE_PATTERNS` (neural)      | `neural/postcode-repair.ts:61`                            | 10 rows. Adds IE/NL/PT/PL — four systems with no codex module                                                            | 1         |
| `postcode_shapes.py`              | `corpus-python/src/mailwoman_train/postcode_shapes.py:24` | 9 rows. Header claims to mirror `postcode-repair.ts` verbatim; **it is one row behind (IE missing)**                     | 1         |
| `scoreByPostcode`                 | `locale-hint/rules.ts:55`                                 | Format hit → locale candidate. Ambiguous 5-digit → en-US @0.5                                                            | 1         |
| `scorePostcodeOnly`               | `kind-classifier/classify.ts:38`, `rules.ts:22–54`        | The `postcode_only` kind, with a share threshold and a full-vs-fragment length rule                                      | 1         |

**Three divergent copies of the shape table exist** (query-shape, neural, corpus-python), which
`codex/postcode-systems.ts:11-15` explicitly anticipated and warned against. Each copy exists for a
real reason, since NL/IE/PT/PL have no codex module. This matches the AGENTS.md pattern "a duplicate
is a bug report about the shared tool". The copies exist because the shared tool is missing four
countries.

### A.2 Prefix → region structure (direction 3)

This table comes from reading every codex module. Only six countries carry any prefix→region
structure.

| Country           | Export                                                          | Shape                                                                                              | Entries |
| ----------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------- |
| US                | `codex/us/zipcode.ts:92` `StateAbbreviationZipCodePrefixRecord` | state → **leading digit**                                                                          | 56      |
| US                | `codex/us/zipcode.ts:154` `ZipCodePrefixAbbreviationMap`        | digit → states (inverted at `:156`)                                                                | 10 keys |
| GB                | `codex/gb/postcode-area.ts:73` `GB_POSTCODE_AREA_COUNTRY`       | area letters → constituent country                                                                 | 23      |
| CA                | `codex/ca/postal-code.ts:83` `FSA_LETTER_TO_PROVINCE`           | FSA first letter → province                                                                        | 18      |
| DE                | `codex/de/postleitzahl.ts:79` `PLZ_LEITZONEN`                   | first digit → Leitzone info                                                                        | 10      |
| FR                | `codex/fr/departement.ts:37` `FR_DEPARTEMENTS`                  | 2-digit code → département + region                                                                | 101     |
| JP                | `codex/jp/postal-code.ts:74` `JP_FIRST_DIGIT_REGION`            | first digit → routing region                                                                       | 10      |
| ES                | —                                                               | `codigoPostalProvincePrefix` returns the raw prefix; the module ships no province table on purpose | 0       |
| IT / AU / NZ / NL | —                                                               | AU and IT each warn against inferring a region from digits; NL has no codex module                 | 0       |

Accessors: `departementOfCodePostal` (`codex/fr/code-postal.ts:82`), `regionForCodePostal` (`:114`),
`provinceOfPostalCode` (`codex/ca/postal-code.ts:109`), `leitzoneOf` (`codex/de/postleitzahl.ts:99`),
`countryOfPostcode` (`codex/gb/postcode-area.ts:103`), `outwardCode` (`codex/gb/postcode.ts:84`),
`firstDigitRegion` (`codex/jp/postal-code.ts:91`), `pluckStateZIPCode` (`codex/us/zipcode.ts:199`).

**FR is the only country with a fine-grained table** (101 départements, exact by
construction). Every other country ships a first-letter or first-digit table, and M-3 below shows
that such a table is close to useless as a spatial prior. The FR table is also the only one wired into a corpus recipe
(`corpus/src/extract-recipes/fr-admin-split.ts:85`).

### A.3 Runtime coherence changes (direction 2)

| Change                                      | Where                                                                        | What it does                                                                                                                                                                                                                                                                                                            | Default                            | Direction     |
| ------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------- |
| `applyPostcodeConsistency` (#370/#945)      | `resolver/resolve.ts:266-331`, called `:849`                                 | Runs post-walk without backend queries. Finds the first resolved postcode's coordinate; for every `locality`/`dependent_locality` beyond `postcodeConsistencyThresholdKm` (50 km), re-picks from `node.alternatives`, else overwrites the node's lat/lon with the postcode's and stamps `postcode_city_mismatch`        | **ON** (`!== false`)               | 2             |
| Postcode-country coherence (#42/#1477)      | `resolver/postcode-country-coherence.ts`, called `resolve.ts:790`            | The only PRE-walk pass and the only thing allowed to override `defaultCountry`. Geometric: postcode centroid vs exact-match locality centroid within 25 km (`:86`). Candidate set = `candidateSystemsForPostcode`. Abstains on 0 or ≥2 coherent countries (`:269`)                                                      | **ON**                             | 1 + 2         |
| `(name_key, postcode)` short-circuit (#741) | `resolver-wof-sqlite/candidate-lookup.ts:310-333`                            | On a locality-wanting query with a postcode, probes `postal_city_candidate` and returns a single synthetic candidate immediately. The whole ranking cascade below is never reached. This is direction 2's REVERSE arrow, already shipped, for one country                                                               | on when the table exists (`:258`)  | **2 reverse** |
| Postcode abstention (#1480)                 | `resolver-wof-sqlite/candidate-lookup.ts:429-443`, `:300`                    | A `placetype: "postalcode"` query that misses exact + strip now skips the FTS trigram rung entirely instead of returning a trigram-nearest code. Cause: `BT3 9QQ` matched Sheffield's `S3 9QQ`, 200+ km wrong at full confidence                                                                                        | ON                                 | 1             |
| `LEADING_POSTCODE_COUNTRIES`                | `neural/placetype-pair-prior.ts:701`                                         | `{fr, de, es, it}`. Checks whether the leading-postcode strip runs. `en-IN` is absent on purpose, because the PIN goes last                                                                                                                                                                                             | on where the index country matches | 3             |
| Segment postcode strip                      | `neural/placetype-pair-prior.ts:677-684`, `:725-756`, `:773-813`             | `SEGMENT_PARENT_POSTCODE_SHAPES` (6 countries, patterns imported from codex so they cannot drift). Strips ≤2 trailing (and, for the 4 leading countries, leading) postcode words from a segment before it becomes a pair-index key. Whole-edge went 96.3% → 0.0% on `fr-lieudit-golden.jsonl` without it (`:1126-1128`) | ON                                 | 3             |
| PCB1 anchor channel                         | `neural/postcode-binary-resolver.ts`, `neural/anchor-inference.ts`           | Per-piece feature vector: country posterior over `LOCALE_ORDER` (`anchor-inference.ts:24`) + quantized lat/lon. `ANCHOR_FEATURE_DIM = 11`                                                                                                                                                                               | Model-declared (`weights.ts:693`)  | 1 + 3         |
| **The GB hole in PCB1**                     | `docs/records/evals/2026-08-05-en-gb-anchor-off.md`                          | Every training config points at one `pilot-anchor-lookup.json` holding 67,708 keys, **zero letter-containing**, covering US/DE/FR only. GB slot 4 never took a gradient. `postcode-gb.bin` fired on 106/120 gb-golden rows and cost exact postcode 318/318 → 294/318. Fixed #1467 by not shipping the artifact          | GB channel now resolves OFF        | —             |
| PCN1 census                                 | `neural/placetype-census.ts`, wired `neural/placetype-pair-prior.ts:836-859` | Per-parent child-tag distribution with per-tag lift. **Observability only — nothing reads it back**, and the header carries no `delta` until a calibration measures one                                                                                                                                                 | Opt-in, zero-cost when off         | 2             |
| Convention strategy weights                 | `resolver-wof-sqlite/convention.ts:63-67`                                    | Built-in default `["postcode_area_resolution", "fallback_fuzzy_name_match"]` at 0.6/0.3/0.1 (postcode/name/population)                                                                                                                                                                                                  | Effectively on in the FTS backend  | 2             |
| `coincident-roles`                          | `resolver-wof-sqlite/coincident-roles.ts`                                    | **No postcode relationship at all** — build-time (admin, locality) same-name pairs, REGION tier, ~124 places. Listed here only to record that it is not part of this arc                                                                                                                                                | build-time                         | —             |

Two docstrings are stale, and whoever touches these files next should correct them.
`resolver/resolve.ts:263` still says `postcodeConsistency` is default-off, although it was promoted
on 2026-07-04 in commit `0010bb8c`. `resolver/postcode-country-coherence.ts:71-72` still says its
own flag is opt-in. `docs/engineering/reference/runtime-flags.mdx:49` also lists
`postcodeConsistency` as default-off. All three statements are wrong.

**Verified grep pitfall:** `file(1)` classifies `neural/placetype-pair-prior.ts` as `data`, so plain
`grep` returns nothing on it. Use `grep -a`. An audit of that file without the flag gets a false
negative.

### A.4 What the inventory says about the sketch

- **Direction 1 (shape as confidence and exclusion) has the most coverage.** The shape oracle
  exists, is pure, and already supplies the candidate set for the country-coherence pass.
- **Direction 2 forward (siblings confirm the postcode) exists once**, geometrically, in
  `findPostcodeCountryScope`, and only for the country decision.
- **Direction 2 reverse (the postcode confirms an ambiguous name) exists once**, as the #741
  short-circuit, and only for US postal cities through a side-index table.
- **Direction 3 (partial codes encode ancestry) is not implemented anywhere.** The strip
  implementation deletes the postcode from the pair key, and nothing reads a prefix as a prior. One
  corpus recipe consumes the codex prefix tables, and nothing reads them at runtime.

## Part B — Measurements

The scripts are in the session scratchpad. Each number below comes from a run.

### M-1: the exclusion population on the Gauntlet

`m1-shape-census.ts` / `m1b.ts`, over `mailwoman/eval-harness/gauntlet/cases/regression.ts` (192
cases). Candidate spans are 1-token and 2-token windows over the comma/whitespace split. A span is
shape-positive when `candidateSystemsForPostcode` returns a non-empty set. Ground truth is
`expectComponents.postcode`, so only the 110 cases that assert one can classify a span.

```
cases total                                  192
cases asserting expectComponents.postcode    110
cases with >=1 shape-positive span           130
shape-positive spans (deduped)               141

STRATUM A — the 110 cases with ground truth
  shape-positive spans                       106
  TRUE postcodes                             100
  EXCLUSION (shape-positive rather than a postcode)   6   (5.7% of shape-positive spans)
  shape-collision profile:  au|nz 5,  jp 1

  every exclusion span:
    US  "1600"      au|nz   Building 43, Googleplex, 1600 Amphitheatre Parkway, Mountain View, CA 94043
    ES  "15 07691"  jp      Southeast, Carrer Passeig d'es Port, 15, 07691 Portopetro, Illes Balears, Spain
    PR  "3499"      au|nz   The Place at the Sea, 3499 Av. Los Meros, Ponce, 00716, Puerto Rico
    MX  "2000"      au|nz   one Villahermosa 2000, Av. Paseo La Choca No. 112, Col. Tabasco 2000, 86035 Villahermosa
    US  "3080"      au|nz   Carmel Mission Basilica, 3080 Rio Rd, Carmel-By-The-Sea, CA 93921
    US  "1200"      au|nz   Twin Peaks Golf Course, 1200 Cornell Dr, Longmont, CO 80503

STRATUM B — shape-positive, no asserted postcode (unclassifiable)   30 cases

shape alone vs the system, on the 110 asserted codes
  accepted by exactly ONE system              51
  accepted by >1 system (shape cannot pin it) 49
  accepted by NO codex system                 10
```

**There are three findings, and two of them count against the sketch.**

1. **On this board, almost no exclusion cases occur within a country.** All 6 exclusion spans are
   cross-system collisions. Each is either a US/PR/MX house number that matches the AU/NZ 4-digit
   shape or the `"15 07691"` two-token window that matches the JP `NNN-NNNN` shape. None is a
   within-country confusion. An exclusion mechanism that runs after the country is known has 6 spans
   of headroom here. The Gauntlet is a regression board, and its pass rate is never a ship gauge. The
   count is therefore a ceiling on what the board can show. It does not measure the rate of the
   defect in real input.
2. **Shape alone cannot identify the system for half the codes.** More than one system accepts 49
   of the 100 asserted codes, and no system accepts 10 of them (IE Eircode, SI, IM, and the other
   countries with no codex module). A mechanism that treats a valid shape as evidence of a specific
   country is guessing on those codes. This is why `findPostcodeCountryScope` abstains on ≥2
   coherent countries (`postcode-country-coherence.ts:269`) instead of picking one.
3. **The 30 Stratum B cases are a gap in the board.** Those cases contain a
   postcode-shaped span but assert no postcode, so no eval can currently tell whether the parser got
   them right. Filling `expectComponents.postcode` on them is a corpus task worth doing before any
   exclusion bar is graded.

### M-2: does a GB outward code localize?

`m2-gb-outward.ts` runs over `$MAILWOMAN_DATA_ROOT/db/wof/postalcode-gb-codepoint.db` (read-only).
It groups every unit postcode by its outward part (the compact form minus the last 3 characters),
takes each group's centroid, and reports the distribution of great-circle radii.

```
source: OS Code-Point Open, release 2026-05, OS CODE-POINT_03.02, OGL v3
spr rows                          1,746,976   (placetype postalcode, 100%)
distinct outward codes                2,863
units per outward  p50/p95/max      593 / 1,297 / 2,789

per-outward radius to its own centroid, in km, ACROSS the 2,863 outwards:
  p50 radius   median 1.34   p90 4.21    max 29.92
  p95 radius   median 3.22   p90 9.78    max 53.71
  max radius   median 5.08   p90 13.49   max 113.68

distinct postcode AREAS                 120
  area p95 radius  median 23.13 km   p90 49.87 km   max 113.18 km

BT (Northern Ireland) outward codes        0
BT unit postcodes                          0
```

**An outward code localizes tightly.** The median p95 radius is 3.22 km, so half of all outward
codes hold 95% of their units inside a 3.2 km circle. That is well inside both the 25 km
country-coherence check and the 50 km consistency check, so an outward-only prior is sharper than
either check the resolver already trusts. The area letters are about 7× coarser (23 km median p95)
but still limit the answer to one metro area.

The BT zero is not an artifact of the query. The database's own metadata records it: `coverage_gap_northern_ireland`
= "ZERO Northern Ireland (BT) postcodes — measured rather than assumed", and
`coverage_gap_northern_ireland_options` = BT centroids "CANNOT be filled from a free source" (ONSPD/NSPL
carry them from LPS Pointer but carve them out of OGL).

### M-2b: BT districts from the NI census file

The file `ni-bt-postcodes.csv` in the session scratchpad is readable. It has 12,327 rows with one
unit postcode per row, and it **has no coordinates**.

```
raw rows                                    12,327
distinct BT unit postcodes                   4,758
distinct BT OUTWARD codes (districts)           80
districts present: BT1-BT49, BT51-BT57, BT60-BT71, BT74-BT82, BT92-BT94
gaps within the range: 50, 58, 59, 72, 73, 83-91
```

The first attempt at this measurement hit a parsing error. A greedy `^(BT\d{1,2})` over the
whitespace-stripped compact form reads `BT4 1NY` as district `BT41`. That drops BT1–BT9 from the
census without any error and invents nine districts. The outward part must be derived as the compact
form minus the last three characters, the same rule M-2 uses.

**The file gives 80 districts without coordinates.** The NI tier of any mechanism here is therefore
an ancestry tier rather than a coordinate tier. A BT district can assert "Northern Ireland" and a
named district, and it must assert nothing about the location inside that district. Mechanism 3's
bar is written around this constraint.

### M-3: what the ZIP-prefix table buys

`m3-zip.ts` / `m3b-zip.ts` / `m3c-zip.ts` run over `codex/us/zipcode.ts` and
`$MAILWOMAN_DATA_ROOT/db/wof/postalcode-us.db` + `admin-global-priority.db` (both read-only). The
ground truth for a ZIP's state is the WOF region ancestor of its `spr.parent_id`.

```
the codex table itself
  states/territories mapped     56
  distinct prefixes (bands)     10        band sizes 3-9 states
  band 0: CT ME MA NH NJ RI VT PR VI      band 5: IA MN MT ND SD WI
  band 1: DE NY PA                        band 6: IL KS MO NE
  band 2: DC MD NC SC VA WV               band 7: AR LA OK TX
  band 3: AL FL GA MS TN                  band 8: AZ CO ID NV NM UT WY
  band 4: IN KY MI OH                     band 9: AK CA HI OR WA GU MP AS

gazetteer  42,319 spr rows;  2,679 zero-coordinate;  39,639 5-digit with a real coordinate
           38,816 with a resolvable state;  CONUS subset 38,870

states reachable from a prefix (CONUS)
  1-digit:  10 prefixes   states/prefix p50 12  p95 17  max 17   pins ONE state:   0/10  ( 0.0%)
  2-digit:  98 prefixes   states/prefix p50  4  p95  7  max  8   pins ONE state:   3/98  ( 3.1%)
  3-digit: 901 prefixes   states/prefix p50  2  p95  3  max  5   pins ONE state: 324/901 (36.0%)

CONUS centroid dispersion per prefix
  1-digit:  p50 radius median 369.8 km   p95 radius median 695.8 km
  2-digit:  p50 radius median 145.4 km   p95 radius median 491.1 km
  3-digit:  p50 radius median  60.0 km   p95 radius median 145.5 km

codex band vs the gazetteer's state (CONUS)
  checked 38,229   agree 35,193 (92.1%)
```

**The shipped ZIP-prefix table does not work as a spatial prior.** A leading digit narrows a ZIP to
a median of 12 states and a 696 km p95 radius. By comparison, M-2 shows that a GB outward code gives
3.2 km. Three digits, the USPS sectional-center level that the codex does not carry, reach a 145 km
p95 radius and identify one state 36% of the time. The useful US artifact would be a 3-digit table,
and that table does not exist.

**The 7.9% disagreement is not noise, and it rules out the obvious build path.** A sample:

```
60683 → gazetteer says MN (band 5), parent "Minneapolis"
67231 → gazetteer says OH (band 4), parent "Cincinnati"
90174 → gazetteer says UT (band 8), parent "Salt Lake City"
94096 → gazetteer says OH (band 4), parent "Toledo"
23280 → gazetteer says PA (band 1), parent "Philadelphia"
```

These are unique or firm ZIPs. Each code is assigned to one high-volume recipient whose mail is
processed somewhere outside the code's numbering range. The two sources answer different questions
correctly. The codex band describes the code's range, and the gazetteer parent describes the
organization. Two counts support this reading. 13.2% of ZIPs share an exact coordinate with ≥5 other
ZIPs, which is the pattern expected when facility-assigned codes collapse onto one point. Only 979 of
42,319 rows carry a `census-zcta-2024` centroid stamp, and the rest have none.

**Consequence for the design:** a prefix→region artifact must be built from the numbering authority
(USPS/Census ZCTA) rather than derived from the current postcode gazetteer's parentage. Deriving it
from `spr.parent_id` would put about 8% firm-ZIP misattribution directly into the prior.

## Part C — The design

This part describes three mechanisms. Each one states where it lives, what artifact it needs, its
D-rule posture, and its pre-registered bars. **No bar may be changed after results are seen.** All
three ship opt-in. A default-on promotion is a separate decision with its own evidence record, as
#1477 was for postcode-country coherence.

### Mechanism 1 — `applyPostcodeShapeCoherence`: shape as exclusion, downstream of the siblings

**Change shape.** This is not a model change. It falls under the "cross-locale grammar leakage" row
of the taxonomy, which calls for a conventions-plus-mask change. It is implemented as a fifth member
of the joint-consistency coherence family, alongside the four in A.3. It needs no GPU and no
retrain.

**Where it lives.** `resolver/postcode-shape-coherence.ts`, called from `resolver/resolve.ts` in the
pre-walk block beside `findPostcodeCountryScope` (`resolve.ts:790-816`). It runs before the country
scope pass, because its output narrows that pass's candidate set.

**What it does.** For each span the parse tagged `postcode`, compute
`candidateSystemsForPostcode(span)`. Then intersect that set with the systems that are coherent with
the sibling placetypes already on the tree: the resolved country, the region, and the locality's
country where present. There are three outcomes:

- **The intersection is non-empty.** The span is confirmed. Stamp `postcode_shape_systems` for the
  trace.
- **The intersection is empty and the siblings are confident.** The span is excluded. Demote it by
  removing the `postcode` tag's contribution to the resolve, and keep the span itself. M-1's six
  cases all look like this. `"1200"` in a Longmont CO address is accepted only by `au|nz`, and the
  siblings say US.
- **The siblings are absent or not confident.** Abstain, as `postcode-country-coherence.ts:269`
  does.

**Artifact.** None. The mechanism needs only `codex/postcode-systems.ts` and the tree. The one codex
change it needs is adding the four missing codex modules (IE, NL, PT, PL), so that
`candidateSystemsForPostcode` stops returning an empty set for 10 of 110 Gauntlet codes. Adding them
should also merge the three divergent shape tables (A.1) into the codex, since the missing modules
are the only reason the tables diverged.

**D-rule.** The mechanism is opt-in behind `postcodeShapeCoherence` and default-off. It can only
demote a postcode, and a wrong demotion is the costly failure, so a default-on promotion needs the
full check set.

**Pre-registered bars.**

- **B1-1 (byte-stability where it must be inert).** Run the full Gauntlet plus the GB and NZ boards
  with the flag on and off. Bar: **byte-identical output on every case whose postcode span has a
  non-empty intersection.** A single diff means the intersection logic fires where it should
  abstain, and the design must be revised before any positive result is graded. This is the
  cheapest bar, so run it first.
- **B1-2 (the exclusion works).** Use a board built from M-1's six spans plus synthesized cases of
  the same kind: 4-digit house numbers in US/MX/PR addresses and 5-digit house numbers in DE/FR
  addresses. Bar: **≥90% of the spans whose shape matches only a foreign system lose the `postcode`
  tag, and the correct sibling tag survives.**
- **B1-3 (the confound).** Use a board of addresses where the span is a foreign postcode in a
  mixed-country string, such as an AU postcode in a `"Sydney NSW 2000, Australia"` line queried with
  a US `defaultCountry`, or a GB code in a US-defaulted query. Bar: **≤2% false exclusions**, the
  shipped GB floor. This bar can kill the mechanism. `findPostcodeCountryScope` exists because
  `defaultCountry` is sometimes wrong, and an exclusion pass that trusts `defaultCountry` will delete
  the evidence the country pass needs.
- **B1-4 (the board can detect the effect).** Before B1-2 is graded, the 30 Stratum-B Gauntlet cases
  must carry an asserted `expectComponents.postcode`. Bar: **30/30 filled.** A board that cannot
  distinguish "right" from "not asserted" cannot measure an exclusion mechanism.

**Kill condition.** The mechanism is killed if B1-3 fails at every exclusion δ, or if B1-1 shows
diffs that cannot be resolved without a per-country exception. In that case the M-1 verdict stands:
the curated board has only 6 within-country exclusion spans, and the mechanism is not worth the risk
of turning it on by default. Record the result as a negative and stop.

### Mechanism 2 — `applyPostcodeContainmentCoherence`: the reverse arrow, generalized

**Change shape.** A retrieval-augmented prior in the resolver walk. It implements direction 2's
reverse claim, that an ambiguous name gains validity when the postcode contains it.

**Where it lives.** It lives in the resolver walk. It generalizes the #741
short-circuit (`resolver-wof-sqlite/candidate-lookup.ts:310-333`) from "US postal cities via a
side-index table" to "any locality candidate, scored by whether the postcode's geometry contains or
neighbors it". The #741 path stays as the exact-match fast path. This mechanism is the scoring rung
beneath it, where the population-ordered `neg_rank` fetch currently ignores the postcode
(`:381-397`).

**What it does.** When a locality-wanting query carries a postcode and the exact `(name_key,
postcode)` probe misses, the mechanism resolves the postcode's centroid once. It then re-ranks the
name candidates by distance to that centroid, within the same 25 km limit the country pass uses.
`Paris TX 75460` and `Paris 75001` differ in which candidate the postcode is near, but the current
ranking chooses by population. `applyPostcodeConsistency` makes the same correction post-walk
against `node.alternatives` (`resolve.ts:298-305`). This mechanism moves it earlier, so the
alternatives list is built correctly in the first place instead of repaired afterward.

**Artifact.** Nothing new. It reuses the postcode gazetteer that is already loaded. It does need the
postal-city side-index extended beyond the US, since `postal-city-alias-us.db` is the only one that
exists.

**D-rule.** The mechanism is opt-in behind `postcodeContainmentCoherence`. One interaction needs
watching: it partly overlaps `applyPostcodeConsistency`. If both run by default, the re-pick may
happen twice with different tie-breaks. The promotion decision must measure them together, and the
outcome may be that mechanism 2 replaces #370 instead of running alongside it.

**Pre-registered bars.**

- **B2-1 (inert where the fast path already wins).** Use every case where the #741 short-circuit
  fires today. Bar: **byte-identical output.** The new rung must sit strictly beneath the exact
  probe.
- **B2-2 (the ambiguous-name board).** Use a board of homonym localities that only the postcode
  disambiguates: `Paris TX 75460` / `Paris 75001`, `Athens GA 30601` / `Athens 10431`,
  `Berlin NH 03570` / `Berlin 10117`, `Springfield` across its US instances, and `Boulogne 92100`.
  Four of these are already Gauntlet cases. Bar: **≥85% correct locality at ≤5 km**. Report beside it
  the rate with the postcode span removed from the input. If removing the postcode does not change
  the number, the mechanism is not doing what this document claims.
- **B2-3 (the double-repair confound).** Run the same board with `postcodeConsistency` on and off.
  Bar: **the two arms agree on ≥98% of cases.** Disagreement means the two passes conflict, and the
  promotion question becomes whether mechanism 2 replaces #370 or only checks it.
- **B2-4 (cost).** The rung adds one postcode lookup per locality query that misses the fast path.
  Bar: **≤15% p95 latency increase** on the demo preset. The candidate-table probe is the
  per-keystroke hot path (`core/resolver/types.ts`, the sync-by-interface exception), so a prior
  that adds a lookup there needs a measured cost.

**Kill condition.** B2-2 shows no gap between the postcode-present and postcode-removed arms. That
would mean the model and the population ranking already handle these cases, and the rung adds cost
without benefit.

### Mechanism 3 — PFX1: the partial-code prior

**Change shape.** A new retrieval artifact plus a decode-time prior. This follows the same recipe as
the PIX1 pair index and the PCB1 anchor, and the country-evidence-layer runbook applies.

**Where it lives.** It has two consumers, in this order:

1. **The resolver**, as a coordinate/ancestry prior when the full code misses. This answers #1480
   directly. Today a BT code that misses abstains and contributes nothing. With PFX1 it abstains on
   the unit and still contributes its district.
2. **The decoder**, later and only if step 1 clears its bars. This would be a soft prior on the
   country/region head keyed by the prefix, feeding the same boundary `neural/postcode-anchor.ts`
   uses. It is out of scope for the first bars. The GB hole (A.3) shows what happens when a channel
   receives a value it was never trained on.

**Artifact spec — `PFX1`.** The format follows the PCN1 layout exactly (`neural/placetype-census.ts:25`,
`:114-165`): magic `"PFX1"` (4 bytes), `u32 headerLen`, `headerLen` bytes of UTF-8 JSON header, then
the node table. Each country gets its own file, `postcode-prefix-<cc>.bin`, named like
`postcode-<cc>.bin`.

```ts
interface PostcodePrefixHeader {
	/** ISO country code this index was built for. */
	country: string
	schemaVersion: 1
	/** Which prefix lengths the node table carries, e.g. [3] for US, ["outward"] for GB. */
	levels: readonly string[]
	/** MD5s of the source artifact(s), for provenance — same discipline as PCN1's sourceMD5s. */
	sourceMD5s: string[]
	/** The NUMBERING AUTHORITY the prefixes came from rather than the gazetteer they were joined to. */
	source: string
	buildDate: string
	/**
	 * OPTIONAL soft-prior bias magnitude. ABSENT until a calibration task measures one — a defaulted
	 * number here would let an uncalibrated bias reach the decoder unnoticed (PCN1's rule, verbatim).
	 */
	delta?: number
}

interface PostcodePrefixNode {
	/** The prefix, in the sanitized-query token shape (#920) — e.g. "941", "SW1A", "BT9". */
	prefix: string
	/** Admin ancestry the prefix asserts, coarsest-first. Empty when the prefix asserts none. */
	ancestors: readonly { placetype: string; wofID: number; name: string }[]
	/** Centroid, quantized i16 as in PCB1. ABSENT for an ancestry-only tier (NI). */
	lat?: number
	lon?: number
	/**
	 * The measured p95 radius in km of the units under this prefix — the prior's own confidence,
	 * shipped rather than assumed. A consumer that reads a coordinate without reading this one is
	 * treating a 696 km band like a 3 km outward code.
	 */
	radiusP95Km?: number
	/** Units observed under this prefix at build time — the denominator behind radiusP95Km. */
	unitCount: number
}
```

Three properties follow from the measurements above:

- **`radiusP95Km` is required whenever a coordinate is present.** M-3 shows why. A 1-digit US band
  and a GB outward code are both "a prefix with a centroid", but their radii differ by 200×. An
  artifact that ships the coordinate without the radius invites the consumer to treat them alike.
- **The coordinate is optional, and its absence carries meaning.** M-2b's 80 BT districts have no
  coordinates, and no permissively licensed source will supply them. A node with `ancestors` and no
  `lat`/`lon` belongs to the ancestry-only tier. Under the meaning-of-zero rule it must be stored as
  absent, never as `0,0`.
- **`source` records the numbering authority.** M-3's 7.9% firm-ZIP disagreement shows why. A US
  build joined against `spr.parent_id` misattributes codes whose gazetteer parent is a mail
  recipient. The US build uses USPS/Census ZCTA. The GB build uses Code-Point Open, which is already
  in the data root and already carries the outward structure.

**First three builds, in cost order:**

1. GB outward: 2,863 nodes with coordinates and radius, taken directly from the Code-Point Open DB.
   It costs nothing because the data is already loaded.
2. NI BT district: 80 nodes, ancestry-only, without coordinates.
3. US 3-digit: 901 nodes. It needs a ZCTA join and is the only build that requires acquiring data.

**D-rule.** The mechanism is opt-in behind `postcodePrefixPrior` and default-off. The first landing
is data, a loader and an offline probe, with **no decode wiring**. This matches the PCN1 posture in
`neural/placetype-pair-prior.ts:287-296`, where nothing reads the census back, and the code sets no
delta and writes nothing to the matrix. The
header ships without `delta` until a calibration measures one. Promotion is checked per locale. GB
and US are separate decisions with separate evidence, because their radius profiles differ by 45×.

**Pre-registered bars.**

- **B3-1 (the artifact reproduces its own measurement).** Build `postcode-prefix-gb.bin` and read it
  back. Bar: **`radiusP95Km` matches M-2's per-outward p95 within 1%, and `unitCount` sums to
  1,746,976.** A round trip that does not reproduce the number it was built from indicates a build
  bug. This bar costs one command, so run it first.
- **B3-2 (the prior beats the abstention it replaces).** Use a board of GB queries whose full unit
  postcode is absent from the gazetteer, built by holding out units and adding the real set of codes
  the gazetteer never covered. Compare two arms: #1480's abstention (current behavior), and
  abstaining on the unit while applying the prefix prior. Bar: **≥60% of held-out units land within
  10 km**, against the abstention arm's 0% by construction, with **zero cases worse than the
  abstention arm**. Abstaining is never worse than a wrong answer, so any regression here directly
  violates the D-rule.
- **B3-3 (the NI case, which is the reason this mechanism exists).** Use the 80 BT districts from
  M-2b, with no coordinates anywhere in the pipeline, and a board of NI addresses whose BT code the
  unit resolver abstains on. Bar: **≥95% receive a country scope of GB with a `NIR`
  constituent-country ancestry and the correct BT district named, and 0% receive a coordinate.** The
  second condition decides the mechanism. Here the correct output is ancestry without a point. A
  mechanism that invents a BT centroid reproduces the `BT3 9QQ` → Sheffield defect that #1480 just
  fixed. Report the district-level accuracy against the 80/80 census, and separately report the number
  of inputs the prior fired on.
- **B3-4 (the US tier is not oversold).** Build `postcode-prefix-us.bin` at 3 digits from ZCTA and
  grade a US board the same way as B3-2. Bar: **≥40% within 100 km**. The bar is deliberately weak,
  because M-3 measured a 145 km median p95, and a bar tighter than the data allows cannot be met. A
  tighter US bar would require a 5-digit artifact, which is a different artifact.
- **B3-5 (no channel receives an untrained value).** Before any decode wiring, confirm that no
  shipped weights bundle declares a channel this artifact would populate. Bar: **the offline probe
  path touches zero model inputs.** The GB hole cost 24 exact postcodes on gb-golden because slot 4
  received a value it was never trained on. That is why this bar is written before the wiring exists.

**Kill condition.** The mechanism is killed if B3-2 misses at every prefix length. That would mean
the prefix does not localize well enough to beat abstention, and the GB outward number reflected
Code-Point Open rather than postcodes in general. It is also stopped if B3-3 shows that the
ancestry-only tier cannot be represented without some part of the pipeline defaulting a coordinate
to `0,0`. In that case, fix the plumbing before the artifact ships.

## Part D — Sequencing

**None of this work needs a retrain or depends on a training batch.** Mechanisms 1 and 2 are
resolver passes, and mechanism 3's first landing is data plus an offline probe. Nothing in Part C
requires a GPU, by design. Every mechanism is a decode-time or resolve-time change. The taxonomy
reserves retraining for open-vocabulary distributional tags, and postcodes are not one.

**Order, cheapest first:**

1. **B3-1:** one build and one read-back. It confirms that PFX1's format carries what it claims
   before anything consumes it.
2. **B1-4:** fill the 30 Stratum-B Gauntlet assertions. This is corpus work only. It unblocks B1-2
   and is worth doing whether or not mechanism 1 ships.
3. **B1-1 / B2-1:** the two byte-stability bars. Both are on-versus-off diffs on boards that already
   exist.
4. **B3-3:** the NI bar. It needs the 80-district artifact and an NI board, and no ZCTA acquisition.
5. **B2-2 / B2-3:** the ambiguous-name board and the double-repair check.
6. **B1-2 / B1-3:** the exclusion bars. They come last among the decode-time work because M-1 shows
   only 6 spans of headroom, and the confound is the main risk.
7. **B3-4:** needs a ZCTA acquisition, which is the only real data work in the arc.

**Work that would need a training batch, which this document excludes:** feeding a prefix prior into
the anchor channel (mechanism 3's second consumer). That requires a channel that saw prefix-shaped
values during training, and the GB hole shows the cost of shipping it untrained. If a batch is
being prepared anyway, a cheap addition would extend `pilot-anchor-lookup.json` beyond its 67,708
US/DE/FR keys, none of which contain letters, so the letter-containing systems get a gradient at
all. That is a corpus decision with its own preregistration, and adding it to this arc would break
the one-variable-per-run rule.

## Explicitly out of scope

- **A default-on promotion for any of the three.** Each needs its own evidence record, as #1477 had
  for postcode-country coherence.
- **The three divergent shape tables.** A.1 lists them and the four missing codex modules that
  caused them. Merging them is the right fix, and it is a codex task rather than a mechanism.
- **Fixing the two stale docstrings** (`resolve.ts:263`, `postcode-country-coherence.ts:71-72`) and
  the `runtime-flags.mdx:49` row. They are listed here so they are not lost. Whoever next touches
  those files should fix them.
- **`coincident-roles`.** It was read and has no postcode relationship.
- **A 5-digit US artifact.** M-3 shows that 3 digits is the longest prefix that still generalizes.
  5 digits is the full code, which the gazetteer already carries.

## Reproduce the measurements

```bash
node <scratchpad>/m1b.ts          # M-1  exclusion population, stratified on ground truth
node <scratchpad>/m2-gb-outward.ts # M-2  GB outward dispersion + the BT zero
node <scratchpad>/m3c-zip.ts       # M-3  ZIP-prefix discriminative power + the firm-ZIP finding
```
