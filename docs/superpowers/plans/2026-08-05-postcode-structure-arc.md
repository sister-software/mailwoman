# Postcodes carry structure we never read — preregistration for three mechanisms

Opened 2026-08-05 from the operator's sketch. Three claims, in the operator's order:

1. We cannot enumerate every postcode, but we CAN enumerate their RULES per country. Shape validity
   builds confidence — and works as EXCLUSION: many things look like postcodes and are only
   postcodes when the other placetypes make sense relative to one another.
2. A postcode-looking token is confirmed BY the coherence of its sibling placetypes; in REVERSE, an
   ambiguous place-name token gains validity if the given postcode CONTAINS it.
3. Postcodes are hierarchically ENCODED. A partial or unknown code still encodes approximate admin
   ancestry and is usable as a prior.

This document is the inventory of what already implements each direction, the measurements that
size the remaining headroom, and three pre-registered mechanisms. **No mechanism is implemented
here.** Bars are fixed before results, per the PIX1 preregistration idiom.

## The house term the sketch was reaching for

The operator called it "placetype concordance validation". The project already has a name for it,
and it is not concordance.

- **`coherence`** is the mechanism name. Four passes carry it, all default-ON, all in
  `resolver/resolve.ts` or beside it: `applyAdminCoherence` (`resolver/resolve.ts:345`),
  `applyExplicitCountryCoherence` (`resolver/resolve.ts:547`), `applyRegionCountryCoherence`
  (`resolver/resolve.ts:636`), `findPostcodeCountryScope` (`resolver/postcode-country-coherence.ts:227`).
- **`joint-consistency`** is the doctrine name. All four docstrings use the phrase verbatim ("the
  joint-consistency resolve"), and the authority is
  `docs/engineering/design/2026-06-29-joint-consistency-resolution.mdx`, `status: active-decision`:
  "an address should resolve to wherever its spans are jointly consistent in the gazetteer's
  containment graph."
- **`concordance`** is the OLDER term for the same idea and is now double-booked. In code it names
  (a) the retired `jointReconcile` beam-search bonus (`core/pipeline/reconcile.ts:126`,
  `concordanceWeight`, default-OFF since #566 — `core/pipeline/runtime-pipeline.ts:479`) and (b) the
  unrelated WOF external-ID table (`resolver-wof-sqlite/unified-schema.ts`). The reader-facing
  definition at `docs/records/site-2026-08/understanding/the-problem/what-is-a-concordance.mdx:16` is
  still the operator's exact concept, which is why the word came to mind. Reusing it for a new
  mechanism collides twice.

**So: new work in this arc is named `*Coherence` and described as joint-consistency.** Naming a
mechanism `concordance` is a defect, not a preference.

## Part A — Inventory

Every row is something that already exists. The last column says which of the operator's three
directions it covers, so the design in Part C only proposes what is missing.

### A.1 Shape rules per country (direction 1)

| Thing                             | Where                                                     | Role                                                                                                                    | Direction |
| --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| Per-system postcode shape + brand | `codex/{us,de,fr,ca,gb,jp,au,nz,es,it}/`                  | 10 slices, each a `Tagged` brand + `*_PATTERN` + normalizer. `codex/us/zipcode.ts:169`, `codex/gb/postcode.ts:55`, etc. | 1         |
| `candidateSystemsForPostcode`     | `codex/postcode-systems.ts:59`                            | The shape oracle: which of 8 systems accept this string. `SYSTEM_ACCEPTS` at `:43` — `es`/`it` deliberately absent      | 1         |
| `ADDRESS_SYSTEM_CONVENTIONS`      | `codex/address-system-conventions.ts:43`                  | The only actual postcode RECORD type (`postcodePattern` + `forbiddenTags`). **2 entries**: `fr`, `gb`                   | 1         |
| `PATTERNS` (query-shape)          | `query-shape/known-formats.ts:31`                         | 11 rows, 9 `KnownFormat` members. Carries `nl_postcode`, which codex has no slice for                                   | 1         |
| `POSTCODE_PATTERNS` (neural)      | `neural/postcode-repair.ts:61`                            | 10 rows. Adds IE/NL/PT/PL — four systems with no codex slice                                                            | 1         |
| `postcode_shapes.py`              | `corpus-python/src/mailwoman_train/postcode_shapes.py:24` | 9 rows. Header claims to mirror `postcode-repair.ts` verbatim; **it is one row behind (IE missing)**                    | 1         |
| `scoreByPostcode`                 | `locale-gate/rules.ts:55`                                 | Format hit → locale candidate. Ambiguous 5-digit → en-US @0.5                                                           | 1         |
| `scorePostcodeOnly`               | `kind-classifier/classify.ts:38`, `rules.ts:22–54`        | The `postcode_only` kind, with a share threshold and a full-vs-fragment length rule                                     | 1         |

**Three divergent copies of the shape table exist** (query-shape, neural, corpus-python), which
`codex/postcode-systems.ts:11-15` explicitly anticipated and warned against. Each has a live reason —
NL/IE/PT/PL have no codex slice — so this is the AGENTS.md "a duplicate is a bug report about the
shared tool" pattern: the shared tool is missing four countries, not four authors failing to find it.

### A.2 Prefix → region structure (direction 3)

Enumerated by reading every codex slice. Only six countries carry any prefix→region structure at all.

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
| IT / AU / NZ / NL | —                                                               | AU and IT each warn against inferring a region from digits; NL has no slice                        | 0       |

Accessors: `departementOfCodePostal` (`codex/fr/code-postal.ts:82`), `regionForCodePostal` (`:114`),
`provinceOfPostalCode` (`codex/ca/postal-code.ts:109`), `leitzoneOf` (`codex/de/postleitzahl.ts:99`),
`countryOfPostcode` (`codex/gb/postcode-area.ts:103`), `outwardCode` (`codex/gb/postcode.ts:84`),
`firstDigitRegion` (`codex/jp/postal-code.ts:91`), `pluckStateZIPCode` (`codex/us/zipcode.ts:199`).

**FR is the only country with a fine-grained table** (101 départements, exact by
construction). Every other country ships a first-letter or first-digit table, which M-3 below shows
is close to useless as a spatial prior. The FR table is also the only one wired into a corpus recipe
(`corpus/src/extract-recipes/fr-admin-split.ts:85`).

### A.3 Runtime coherence changes (direction 2)

| Change                                      | Where                                                                        | What it does                                                                                                                                                                                                                                                                                                            | Default                            | Direction     |
| ------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------- |
| `applyPostcodeConsistency` (#370/#945)      | `resolver/resolve.ts:266-331`, called `:849`                                 | Post-walk, no backend queries. Finds the first resolved postcode's coordinate; for every `locality`/`dependent_locality` beyond `postcodeConsistencyGateKm` (50 km), re-picks from `node.alternatives`, else overwrites the node's lat/lon with the postcode's and stamps `postcode_city_mismatch`                      | **ON** (`!== false`)               | 2             |
| Postcode-country coherence (#42/#1477)      | `resolver/postcode-country-coherence.ts`, called `resolve.ts:790`            | The only PRE-walk pass and the only thing allowed to override `defaultCountry`. Geometric: postcode centroid vs exact-match locality centroid within 25 km (`:86`). Candidate set = `candidateSystemsForPostcode`. Abstains on 0 or ≥2 coherent countries (`:269`)                                                      | **ON**                             | 1 + 2         |
| `(name_key, postcode)` short-circuit (#741) | `resolver-wof-sqlite/candidate-lookup.ts:310-333`                            | On a locality-wanting query with a postcode, probes `postal_city_candidate` and returns a single synthetic candidate immediately — the whole ranking cascade below is never reached. This is direction 2's REVERSE arrow, already shipped, for one country                                                              | ON when the table exists (`:258`)  | **2 reverse** |
| Postcode abstention (#1480)                 | `resolver-wof-sqlite/candidate-lookup.ts:429-443`, `:300`                    | A `placetype: "postalcode"` query that misses exact + strip now skips the FTS trigram rung entirely instead of returning a trigram-nearest code. Cause: `BT3 9QQ` matched Sheffield's `S3 9QQ`, 200+ km wrong at full confidence                                                                                        | ON                                 | 1             |
| `LEADING_POSTCODE_COUNTRIES`                | `neural/placetype-pair-prior.ts:701`                                         | `{fr, de, es, it}`. Gates whether the leading-postcode strip runs. `en-IN` is absent on purpose — the PIN goes last                                                                                                                                                                                                     | ON where the index country matches | 3             |
| Segment postcode strip                      | `neural/placetype-pair-prior.ts:677-684`, `:725-756`, `:773-813`             | `SEGMENT_PARENT_POSTCODE_SHAPES` (6 countries, patterns imported from codex so they cannot drift). Strips ≤2 trailing (and, for the 4 leading countries, leading) postcode words from a segment before it becomes a pair-index key. Whole-edge went 96.3% → 0.0% on `fr-lieudit-golden.jsonl` without it (`:1126-1128`) | ON                                 | 3             |
| PCB1 anchor channel                         | `neural/postcode-binary-resolver.ts`, `neural/anchor-inference.ts`           | Per-piece feature vector: country posterior over `LOCALE_ORDER` (`anchor-inference.ts:24`) + quantized lat/lon. `ANCHOR_FEATURE_DIM = 11`                                                                                                                                                                               | Model-declared (`weights.ts:693`)  | 1 + 3         |
| **The GB hole in PCB1**                     | `docs/records/evals/2026-08-05-en-gb-anchor-off.md`                          | Every training config points at one `pilot-anchor-lookup.json` holding 67,708 keys, **zero letter-bearing**, covering US/DE/FR only. GB slot 4 never took a gradient. `postcode-gb.bin` fired on 106/120 gb-golden rows and cost exact postcode 318/318 → 294/318. Fixed #1467 by NOT shipping the artifact             | GB channel now resolves OFF        | —             |
| PCN1 census                                 | `neural/placetype-census.ts`, wired `neural/placetype-pair-prior.ts:836-859` | Per-parent child-tag distribution with per-tag lift. **Observability only — nothing reads it back**, and the header carries no `delta` until a calibration measures one                                                                                                                                                 | Opt-in, zero-cost when off         | 2             |
| Convention strategy weights                 | `resolver-wof-sqlite/convention.ts:63-67`                                    | Built-in default `["postcode_area_resolution", "fallback_fuzzy_name_match"]` at 0.6/0.3/0.1 (postcode/name/population)                                                                                                                                                                                                  | Effectively ON in the FTS backend  | 2             |
| `coincident-roles`                          | `resolver-wof-sqlite/coincident-roles.ts`                                    | **No postcode relationship at all** — build-time (admin, locality) same-name pairs, REGION tier, ~124 places. Listed here only to record that it is not part of this arc                                                                                                                                                | build-time                         | —             |

Two docstrings are stale and should be corrected by whoever touches these files next:
`resolver/resolve.ts:263` still says `postcodeConsistency` is default-off (promoted 2026-07-04,
commit `0010bb8c`), and `resolver/postcode-country-coherence.ts:71-72` still says its own flag is
opt-in. `docs/engineering/reference/runtime-flags.mdx:49` also lists `postcodeConsistency` under
default-OFF. All three are wrong.

**Grep trap, verified:** `neural/placetype-pair-prior.ts` is classified by `file(1)` as `data`, so
plain `grep` returns nothing on it. Use `grep -a`. Anyone auditing that file without the flag gets a
false negative.

### A.4 What the inventory says about the sketch

- **Direction 1 (shape as confidence and exclusion) is the best-covered.** The shape oracle exists,
  is pure, and is already the candidate set for the country-coherence pass.
- **Direction 2 forward (siblings confirm the postcode) exists once**, geometrically, in
  `findPostcodeCountryScope` — and only for the COUNTRY decision.
- **Direction 2 reverse (the postcode confirms an ambiguous name) exists once**, as the #741
  short-circuit, and only for US postal cities via a side-index table.
- **Direction 3 (partial codes encode ancestry) is not implemented anywhere.** The strip implementation
  DELETES the postcode from the pair key; nothing reads a prefix as a prior. The codex prefix tables
  are consumed by exactly one corpus recipe and nothing at runtime.

## Part B — Measurements

Scripts in the session scratchpad; each number below is a run, not an estimate.

### M-1: the exclusion population on the Gauntlet

`m1-shape-census.ts` / `m1b.ts`, over `mailwoman/eval-harness/gauntlet/cases/regression.ts` (192
cases). Candidate spans are 1-token and 2-token windows over the comma/whitespace split; a span is
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
  EXCLUSION (shape-positive, not a postcode)   6   (5.7% of shape-positive spans)
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

**Three findings, and two of them cut against the sketch.**

1. **Within-country, the exclusion problem is close to empty on this board.** All 6 exclusion spans
   are CROSS-system collisions: a US/PR/MX house number matching the AU/NZ 4-digit shape, or a
   `"15 07691"` two-token window matching the JP `NNN-NNNN` shape. Not one is a within-country
   confusion. An exclusion mechanism that runs after the country is known has 6 spans of headroom
   here, and the Gauntlet is a regression board whose pass rate is never a ship gauge — so this is a
   ceiling on what the board can SHOW, not proof the defect is rare in the wild.
2. **Shape alone cannot pin the system for half the codes.** 49 of 100 asserted codes are accepted
   by more than one system, and 10 by none (IE Eircode, SI, IM, and the other slice-less countries).
   Any mechanism that treats "shape validity" as evidence of a specific country is reading a
   coin-flip. This is exactly why `findPostcodeCountryScope` abstains on ≥2 coherent countries
   (`postcode-country-coherence.ts:269`) rather than picking.
3. **The 30-case Stratum B is the real gap in the board**, not in the mechanism. Those cases carry a
   postcode-shaped span and assert no postcode, so no eval can currently tell whether the parser got
   it right. Filling `expectComponents.postcode` on them is a corpus task worth doing before any
   exclusion bar is graded.

### M-2: does a GB outward code localize?

`m2-gb-outward.ts`, over `$MAILWOMAN_DATA_ROOT/wof/postalcode-gb-codepoint.db` (read-only). Group
every unit postcode by outward part (compact form minus the last 3 chars), take the group centroid,
report the great-circle radius distribution.

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

**An outward code localizes hard.** Median p95 radius 3.22 km — half of all outward codes hold 95% of
their units inside a 3.2 km circle. That is inside the 25 km country-coherence gate and inside the
50 km consistency gate by a wide margin, so an outward-only prior is strictly sharper than either
gate the resolver already trusts. The area letters are ~7× coarser (23 km median p95) but still bound
the answer to a metro.

The BT zero is not an artifact of my query. The database's own meta records it: `coverage_gap_northern_ireland`
= "ZERO Northern Ireland (BT) postcodes — measured, not assumed", and
`coverage_gap_northern_ireland_options` = BT centroids "CANNOT be filled from a free source" (ONSPD/NSPL
carry them from LPS Pointer but carve them out of OGL).

### M-2b: BT districts from the NI census file

The file at the session scratchpad, `ni-bt-postcodes.csv`, is readable: 12,327 rows, one unit
postcode per row, **no coordinates**.

```
raw rows                                    12,327
distinct BT unit postcodes                   4,758
distinct BT OUTWARD codes (districts)           80
districts present: BT1-BT49, BT51-BT57, BT60-BT71, BT74-BT82, BT92-BT94
gaps within the range: 50, 58, 59, 72, 73, 83-91
```

Note the parsing trap this measurement walked into first: a greedy `^(BT\d{1,2})` over the
whitespace-stripped compact form reads `BT4 1NY` as district `BT41`, which silently deletes BT1–BT9
from the census and invents nine members. The outward must be derived as "compact minus the last
three characters", the same rule M-2 uses.

**80 districts, no coordinates.** So the NI tier of any mechanism here is an ANCESTRY tier, not a
coordinate tier: a BT district can assert "Northern Ireland" and a named district, and must assert
nothing about where inside it. That is the shape mechanism 3's bar is written around.

### M-3: what the ZIP-prefix table buys

`m3-zip.ts` / `m3b-zip.ts` / `m3c-zip.ts`, over `codex/us/zipcode.ts` and
`$MAILWOMAN_DATA_ROOT/wof/postalcode-us.db` + `admin-global-priority.db` (both read-only). Ground
truth for a ZIP's state is the WOF region ancestor of its `spr.parent_id`.

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

**The shipped ZIP-prefix table is not a spatial prior.** A leading digit narrows a ZIP to a median of
12 states and a 696 km p95 radius. Compare M-2: a GB outward code gives 3.2 km. Three digits — the
USPS sectional-center level, which the codex does not carry — gets to 145 km p95 and pins one state
36% of the time. The useful US artifact is a 3-digit table, and it does not exist.

**The 7.9% disagreement is not noise, and it disqualifies the obvious build path.** Sampled:

```
60683 → gazetteer says MN (band 5), parent "Minneapolis"
67231 → gazetteer says OH (band 4), parent "Cincinnati"
90174 → gazetteer says UT (band 8), parent "Salt Lake City"
94096 → gazetteer says OH (band 4), parent "Toledo"
23280 → gazetteer says PA (band 1), parent "Philadelphia"
```

These are unique/firm ZIPs — codes assigned to one high-volume recipient whose mail is processed
somewhere other than the code's numbering range. Both answers are right about different questions:
the codex band describes the CODE's range, the gazetteer parent describes the ORGANIZATION. Two
corroborating counts: 13.2% of ZIPs share an exact coordinate with ≥5 other ZIPs (the tell for a
facility-assigned code collapsing onto one point), and only 979 of 42,319 rows carry a
`census-zcta-2024` centroid stamp — the rest are unstamped.

**Consequence for the design:** a prefix→region artifact must be built from the numbering authority
(USPS/Census ZCTA), NOT derived from the current postcode gazetteer's parentage. Deriving it from
`spr.parent_id` bakes ~8% of firm-ZIP misattribution straight into the prior.

## Part C — The design

Three mechanisms. Each states where it lives, what artifact it needs, its D-rule posture, and
pre-registered bars. **No bar is renegotiable after results are seen.** All three ship opt-in; a
default-on promotion is a separate decision with its own evidence record, as #1477 was for
postcode-country coherence.

### Mechanism 1 — `applyPostcodeShapeCoherence`: shape as exclusion, downstream of the siblings

**Change shape.** Not a model change. This is the "cross-locale grammar leakage" row of the taxonomy —
a conventions-plus-mask change — realized as a fifth member of the joint-consistency coherence family,
alongside the four in A.3. Zero GPU, no retrain.

**Where it lives.** `resolver/postcode-shape-coherence.ts`, called from `resolver/resolve.ts` in the
pre-walk block beside `findPostcodeCountryScope` (`resolve.ts:790-816`). It runs BEFORE the country
scope pass, because its output narrows that pass's candidate set.

**What it does.** For each span the parse tagged `postcode`, compute
`candidateSystemsForPostcode(span)`. Then intersect that set with the systems that are coherent with
the sibling placetypes already on the tree — the resolved country, the region, and (where present)
the locality's country. Three outcomes:

- **Intersection non-empty** — the span is confirmed. Stamp `postcode_shape_systems` for trace.
- **Intersection empty and the siblings are confident** — the span is EXCLUDED. Demote it: strip the
  `postcode` tag's contribution to the resolve, do not delete the span. M-1's six cases are exactly
  this shape (`"1200"` in a Longmont CO address is accepted only by `au|nz`, and the siblings say US).
- **Siblings absent or unconfident** — abstain. Same posture as
  `postcode-country-coherence.ts:269`.

**Artifact.** None. Everything it needs is `codex/postcode-systems.ts` plus the tree. The one codex
change it wants is filling the four missing slices (IE, NL, PT, PL) so
`candidateSystemsForPostcode` stops returning empty for 10 of 110 Gauntlet codes — and that fill
should collapse the three divergent shape tables (A.1) into the codex, since the only reason they
diverged is the missing slices.

**D-rule.** Opt-in behind `postcodeShapeCoherence`, default-OFF. It can only ever DEMOTE a postcode,
and demotion is the failure mode with teeth, so a default-on promotion needs the full gate set.

**Pre-registered bars.**

- **B1-1 (byte-stability where it must be inert).** The full Gauntlet plus the GB and NZ boards, flag
  ON vs OFF. Bar: **byte-identical output on every case whose postcode span has a non-empty
  intersection.** A single diff means the intersection logic is firing where it should abstain, and
  the design goes back before any positive result is graded. Cheapest bar; run first.
- **B1-2 (the exclusion excludes).** A board built from M-1's six spans plus a synthesized
  extension of the same shape — 4-digit house numbers in US/MX/PR addresses, 5-digit house numbers in
  DE/FR addresses. Bar: **≥90% of the shape-only-foreign spans lose the `postcode` tag, with the
  correct sibling tag surviving.**
- **B1-3 (the confound).** A board of addresses where the span IS a foreign postcode in a
  mixed-country string — an AU postcode in a `"Sydney NSW 2000, Australia"` line reached with a US
  `defaultCountry`, a GB code in a US-defaulted query. Bar: **≤2% false exclusions**, the shipped GB
  floor. This is the bar that can kill the mechanism: the whole point of
  `findPostcodeCountryScope` is that `defaultCountry` is sometimes wrong, and an exclusion pass that
  trusts it will delete the evidence the country pass needs.
- **B1-4 (the board can see it at all).** Before B1-2 is graded, the 30 Stratum-B Gauntlet cases must
  carry an asserted `expectComponents.postcode`. Bar: **30/30 filled.** Grading an exclusion
  mechanism on a board that cannot distinguish "right" from "not asserted" is not a measurement.

**Kill condition.** B1-3 fails at any exclusion δ, or B1-1 shows diffs that cannot be resolved
without a per-country carve-out. Then the verdict M-1 already recorded stands: the
within-country exclusion population is 6 spans on the curated board, and the mechanism is not worth a
default-on risk. Record it as a negative and stop.

### Mechanism 2 — `applyPostcodeContainmentCoherence`: the reverse arrow, generalized

**Change shape.** A retrieval-augmented prior in the resolver walk. Direction 2's REVERSE claim —
an ambiguous name gains validity when the postcode contains it.

**Where it lives.** The resolver walk, not the decoder. Concretely it generalizes the #741
short-circuit (`resolver-wof-sqlite/candidate-lookup.ts:310-333`) from "US postal cities via a
side-index table" to "any locality candidate, scored by whether the postcode's geometry contains or
neighbors it". The #741 path stays as the exact-match fast path; this is the scoring rung beneath it,
where today the population-ordered `neg_rank` fetch runs blind to the postcode (`:381-397`).

**What it does.** When a locality-wanting query carries a postcode and the exact `(name_key,
postcode)` probe misses, resolve the postcode's centroid once and re-rank the name candidates by
distance to it, bounded by the same 25 km gate the country pass uses. `Paris TX 75460` and
`Paris 75001` differ by which candidate the postcode is near, and the current ranking answers by
population. This is the same move `applyPostcodeConsistency` makes post-walk against
`node.alternatives` (`resolve.ts:298-305`), pulled EARLIER so the alternatives list is built correctly
in the first place rather than repaired afterward.

**Artifact.** None new. It reuses the postcode gazetteer already loaded. It does need the postal-city
side-index generalized past the US — `postal-city-alias-us.db` is the only one that exists.

**D-rule.** Opt-in behind `postcodeContainmentCoherence`. This one has a specific interaction to watch:
it partially SUBSUMES `applyPostcodeConsistency`. Running both default-on risks the re-pick happening
twice with different tie-breaks. The promotion decision must measure them jointly, and the compliant
outcome may be that mechanism 2 replaces #370 rather than joining it.

**Pre-registered bars.**

- **B2-1 (inert where the fast path already wins).** Every case where the #741 short-circuit fires
  today. Bar: **byte-identical.** The new rung must sit strictly beneath the exact probe.
- **B2-2 (the ambiguous-name board).** A board of homonym localities disambiguated only by the
  postcode: `Paris TX 75460` / `Paris 75001`, `Athens GA 30601` / `Athens 10431`, `Berlin NH 03570` /
  `Berlin 10117`, `Springfield` across its US instances, `Boulogne 92100`. Four of these are already
  Gauntlet cases. Bar: **≥85% correct locality at ≤5 km**, and — reported beside it — the rate with
  the postcode span removed from the input. If removing the postcode does not move the number, the
  mechanism is not doing what this document claims.
- **B2-3 (the double-repair confound).** The same board run with `postcodeConsistency` ON and OFF.
  Bar: **the two arms agree on ≥98% of cases.** Disagreement means the two passes are fighting, and
  the promotion question becomes replace-or-gate, not stack.
- **B2-4 (cost).** The rung adds one postcode lookup per locality query that misses the fast path.
  Bar: **≤15% p95 latency increase** on the demo preset. The candidate-table probe is the
  per-keystroke hot path (`core/resolver/types.ts`, the sync-by-interface carve-out); a prior that
  costs a lookup there needs a number, not an assurance.

**Kill condition.** B2-2 shows no gap between postcode-present and postcode-removed arms — the model
and the population ranking were already carrying it, and the rung is dead weight.

### Mechanism 3 — PFX1: the partial-code prior

**Change shape.** A new retrieval artifact plus a decode-time prior — the same recipe as the PIX1 pair
index and the PCB1 anchor, and the country-evidence-layer runbook applies.

**Where it lives.** Two consumers, in this order:

1. **The resolver**, as a coordinate/ancestry prior when the full code misses. This is the direct
   answer to #1480: today a BT code that misses abstains and contributes nothing. With PFX1 it
   abstains on the UNIT and still contributes its DISTRICT.
2. **The decoder**, later and only if step 1 clears — a soft prior on the country/region head keyed
   by the prefix, feeding the same seam `neural/postcode-anchor.ts` uses. Not in scope for the first
   bars; the GB hole (A.3) is the standing receipt for what happens when a channel is fed a value it
   was never trained on.

**Artifact spec — `PFX1`.** Following the PCN1 layout exactly (`neural/placetype-census.ts:25`,
`:114-165`): magic `"PFX1"` (4 bytes), `u32 headerLen`, `headerLen` bytes of UTF-8 JSON header, then
the node table. Per-country file, `postcode-prefix-<cc>.bin`, same naming as `postcode-<cc>.bin`.

```ts
interface PostcodePrefixHeader {
	/** ISO country code this index was built for. */
	country: string
	schemaVersion: 1
	/** Which prefix lengths the node table carries, e.g. [3] for US, ["outward"] for GB. */
	levels: readonly string[]
	/** MD5s of the source artifact(s), for provenance — same discipline as PCN1's sourceMD5s. */
	sourceMD5s: string[]
	/** The NUMBERING AUTHORITY the prefixes came from, not the gazetteer they were joined to. */
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

Three properties, each earned by a measurement above:

- **`radiusP95Km` is mandatory whenever a coordinate is present.** M-3 is the receipt: a 1-digit US
  band and a GB outward code are both "a prefix with a centroid" and they differ by 200×. An artifact
  that ships the coordinate without the radius invites the consumer to treat them alike.
- **The coordinate is OPTIONAL, and its absence is meaningful.** M-2b's 80 BT districts have no
  coordinates and never will from a permissive source. A node with `ancestors` and no `lat`/`lon` is
  the ancestry-only tier, and per the meaning-of-zero rule it must be representable as absence, never
  as `0,0`.
- **`source` names the NUMBERING AUTHORITY.** M-3's 7.9% firm-ZIP disagreement is the receipt: a US
  build joined against `spr.parent_id` bakes in misattribution for codes whose gazetteer parent is a
  mail recipient. US builds from USPS/Census ZCTA; GB builds from Code-Point Open, which is already
  in the data root and already carries the outward structure.

**First three builds, in cost order.** GB outward (2,863 nodes, coordinates + radius, straight off
the Code-Point Open DB — free, the data is loaded). NI BT district (80 nodes, ancestry-only, no
coordinates). US 3-digit (901 nodes, needs a ZCTA join, the only one with real acquisition work).

**D-rule.** Opt-in behind `postcodePrefixPrior`, default-OFF, and the first landing is DATA + LOADER +
OFFLINE PROBE with **no decode wiring** — the PCN1 posture (`neural/placetype-pair-prior.ts:287-296`:
"Nothing reads it back: no delta, no matrix write"). The header ships without `delta` until a
calibration measures one. Per-locale gate at promotion: GB and US are separate decisions with
separate evidence, because their radius profiles differ by 45×.

**Pre-registered bars.**

- **B3-1 (the artifact reproduces its own measurement).** Build `postcode-prefix-gb.bin` and read it
  back. Bar: **`radiusP95Km` matches M-2's per-outward p95 within 1%, and `unitCount` sums to
  1,746,976.** A round-trip that does not reproduce the number it was built from is a build bug, and
  this bar costs one command. Run first.
- **B3-2 (the prior beats the abstention it replaces).** A board of GB queries whose full unit
  postcode is absent from the gazetteer — synthesized by holding out units, plus the real
  never-covered set. Two arms: #1480's abstention (today), and abstain-on-unit-plus-prefix-prior.
  Bar: **≥60% of held-out units land within 10 km**, against the abstention arm's 0% by construction,
  with **zero cases worse than the abstention arm** — abstaining is never worse than a wrong answer,
  so any regression here is a straight D-rule violation.
- **B3-3 (the NI case — the bar this mechanism exists for).** The 80 BT districts from M-2b, with
  no coordinates anywhere in the pipeline. A board of NI addresses carrying a BT code the unit
  resolver abstains on. Bar: **≥95% receive a country scope of GB with a `NIR` constituent-country
  ancestry and the correct BT district named, and 0% receive a coordinate.** The second half is the
  half that decides the mechanism: this is the case where the correct output is ancestry with no
  point, and a mechanism that invents a BT centroid has reproduced the `BT3 9QQ` → Sheffield defect #1480 just
  fixed. Report the district-level accuracy against the 80/80 census, and report separately the count of
  inputs the prior fired on at all.
- **B3-4 (the US tier is not oversold).** Build `postcode-prefix-us.bin` at 3 digits from ZCTA and
  grade a US board the same way as B3-2. Bar: **≥40% within 100 km** — deliberately weak, because
  M-3 measured a 145 km median p95 and a bar tighter than the data cannot be met. If a reviewer wants
  a tighter US bar, the answer is a 5-digit artifact, which is a different artifact.
- **B3-5 (no channel is fed an untrained value).** Before ANY decode wiring, confirm that no shipped
  weights bundle declares a channel this artifact would populate. Bar: **the offline probe path
  touches zero model inputs.** The GB hole cost 24 exact postcodes on gb-golden by feeding slot 4 a
  value it was never trained on; that receipt is why this bar is written before the wiring exists,
  not after.

**Kill condition.** B3-2 misses at every prefix length — the prefix does not localize enough to beat
abstention, and the GB outward number was a property of Code-Point Open rather than of postcodes.
Or B3-3 shows the ancestry-only tier cannot be represented without a coordinate somewhere in the
pipeline defaulting to `0,0`, in which case the plumbing is fixed before the artifact ships.

## Part D — Sequencing

**Measurable with no retrain, and no training batch dependency (all of it):** mechanisms 1 and 2 are
resolver passes, and mechanism 3's first landing is data plus an offline probe. Nothing in Part C
requires a GPU. That is deliberate — every one of these is a decode-time or resolve-time change, and
the taxonomy says a retrain is the tool for open-vocab distributional tags, which postcodes are not.

**Order, cheapest-first:**

1. **B3-1** — one build, one read-back. Settles whether PFX1's format carries what it claims before
   anything consumes it.
2. **B1-4** — fill the 30 Stratum-B Gauntlet assertions. Pure corpus work, unblocks B1-2, and is
   worth doing whether or not mechanism 1 ships.
3. **B1-1 / B2-1** — the two byte-stability bars. Both are ON-vs-OFF diffs on boards that already
   exist.
4. **B3-3** — the NI bar. Needs the 80-district artifact and an NI board; no ZCTA acquisition.
5. **B2-2 / B2-3** — the ambiguous-name board and the double-repair check.
6. **B1-2 / B1-3** — the exclusion bars, last among the decode-time work because M-1 says the
   headroom is 6 spans and the confound is the risk.
7. **B3-4** — needs a ZCTA acquisition, the only real data work in the arc.

**What would ride a training batch, and is NOT in this document:** feeding a prefix prior into the
anchor channel (mechanism 3's second consumer). That requires a channel that has seen prefix-shaped
values during training, and the GB hole is the standing receipt for what shipping it untrained
costs. If a batch is being cut anyway, the cheap rider is extending
`pilot-anchor-lookup.json` past its US/DE/FR, zero-letter-bearing 67,708 keys so the letter-bearing
systems get a gradient at all — but that is a corpus decision with its own preregistration, and
stacking it into this arc violates one-variable-per-run.

## Explicitly out of scope

- **A default-on promotion for any of the three.** Each needs its own evidence record, the way #1477
  got one for postcode-country coherence.
- **The three divergent shape tables.** A.1 names them and the four missing codex slices that caused
  them. Collapsing them is the right fix and it is a codex task, not a mechanism.
- **Fixing the two stale docstrings** (`resolve.ts:263`, `postcode-country-coherence.ts:71-72`) and
  the `runtime-flags.mdx:49` row. Named here so they are not lost; they belong to whoever next
  touches those files.
- **`coincident-roles`.** Read and confirmed to have no postcode relationship at all.
- **A 5-digit US artifact.** M-3 shows 3 digits is where the prefix stops being free; 5 digits is the
  full code, which the gazetteer already carries.

## Reproduce the measurements

```bash
node <scratchpad>/m1b.ts          # M-1  exclusion population, stratified on ground truth
node <scratchpad>/m2-gb-outward.ts # M-2  GB outward dispersion + the BT zero
node <scratchpad>/m3c-zip.ts       # M-3  ZIP-prefix discriminative power + the firm-ZIP finding
```
