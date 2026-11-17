---
title: County-designator fallback and Arabic letter fold, measured
description: Two resolver changes measured against 10.8.0 with and without each. Both stay opt-in.
---

# County-designator fallback and Arabic letter fold, measured

**Date:** 2026-11-17 · **Model:** en-US 10.8.0 (installed weights, `model.onnx` md5 `e711a725`) · **Database:**
`/mnt/mw/db/wof/candidate-global-2026-11-16.db` · **Decision:** both changes stay opt-in.

Both changes act in the resolver, after the parse. The held-out exact-parse grader
(`heldout/per/country.run.ts`) calls `NeuralAddressClassifier.parse` and never the resolver, so its paired outcomes
are identical for both arms of either change by construction (inferred from reading the code, without a run). `release/evaluate.run.ts`
therefore can't return a verdict that distinguishes the arms. The geocoded instruments below are where the arms
differ: the regression board (board-routed `runCompare`, the function `mwdev_compare` calls), the held-out rows of the
affected countries geocoded through the session (`runCompare` on a literal set, `single-config`), and probes. Each arm
pair changes one declared variable, and `runCompare` reported the isolation as `clean` on each.

## A. County-designator fallback

### What changed

The resolver switch `countyDesignatorFallback` (off by default) acts when a span tagged `locality` names no locality
known to be in its region and is written with its country's county designator. It then looks the value up as a WOF `county`
in that region: the whole value first, because WOF keys 2,856 of 3,143 US counties as `<name> county` too, and the
name without the designator second. A hit the backend admitted outside the region is refused. The region is the
resolved parent, or the exact-match regions the tree's written region names in the country. A hit retags the span
`subregion`, the tag the codex maps to `county`.

The designators are per-country data in `packages/codex/lib/county-designators.ts`. The table covers US (`county`,
`parish`, `borough`, `census area`, `city and borough`), CA (`county`) and IE (`County`, `Co.`, `Co` before the name,
and `county` after it). The census of WOF county and macrocounty keys that decided it:

| Country | County places | Keys with the designator                                           | In the table                                      |
| ------- | ------------: | ------------------------------------------------------------------ | ------------------------------------------------- |
| US      |         3,143 | 2,856 `… county`, 75 `… parish`, 16 `… borough`, 5 `… census area` | yes                                               |
| CA      |         1,796 | 63 `… county` (37 AB, 24 ON, 2 NS)                                 | yes                                               |
| IE      |            31 | 26 `county …`, 7 `co …`, 15 `… county`                             | yes, prefix order                                 |
| GB      |           460 | 22 `county …`, 10 `… borough`, 1 `… county`                        | no: proper names (`County Durham`) WOF keys whole |
| IR      |           748 | 481 `… county`                                                     | no: English rendering of shahrestan               |
| PL      |           543 | 314 `… county`                                                     | no: English rendering of powiat                   |
| KR      |           250 | 86 `… county`                                                      | no: English rendering of gun                      |
| EE      |            79 | 64 `… parish`                                                      | no: English rendering of vald                     |

Opt in with `--county-designator-fallback` (geocode), `--county-designator-fallback on` (eval gauntlet) or
`county_designator_fallback: "on"` (dev MCP and `runCompare`).

### Moved rows

| Instrument                                                             |  Rows | Differed | Graded result           |
| ---------------------------------------------------------------------- | ----: | -------: | ----------------------- |
| Regression board, board-routed                                         | 1,352 |        0 | 0 improved, 0 regressed |
| heldout-dev-v0.8.18 + heldout-confirm-v0.8.18 (v2) US rows, geocoded   | 3,109 |       43 | observed, listed below  |
| Lane W county probes (`/mnt/mw/audits/county/parse-probe-10.8.0.json`) |    12 |        2 | observed                |

The board holds no row whose locality is written with a county designator. Its US, CA and IE rows use the words only inside a
venue (`Allen County Country Club`) or a street (`County Rd CW`), or in a row's note, and the one IE row with `Co.`
expects `Co. Westmeath` as `region`.

**Held-out.** The 43 rows that moved are every US held-out row whose gold `locality` ends in a designator: 32
`CARTER COUNTY, OK` and 11 `JOHNSTON COUNTY, OK`, all from the `usgov-nad` source (21 development, 22 confirmation).
No other US row moved. On each, the coordinate and the tier are identical on both arms (38 at `address_point`, 5 at
`postcode`); the change is the label and the hierarchy:

| Input                                              | Gold                                                    | Off                                                        | On                                                                 |
| -------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `2368 foxden road, carter county, ok 73401`        | `locality=carter county`, `region=ok`, `postcode=73401` | `locality=Carter County`, top `region:Oklahoma` (85688585) | `subregion=Carter County`, top `subregion:Carter` (102083987)      |
| `7390 OK HWY 48A South, JOHNSTON COUNTY, OK 73450` | `locality=JOHNSTON COUNTY`                              | `locality=JOHNSTON COUNTY`, top `region:Oklahoma`          | `subregion=JOHNSTON COUNTY`, top `subregion:Johnston` (102083991)  |
| `105 VIKING Loop, CARTER COUNTY, Oklahoma 73401`   | `locality=CARTER COUNTY`, `region=Oklahoma`             | `locality=Oklahoma` (parse), top `locality:Oklahoma City`  | adds `subregion=CARTER COUNTY`; top stays `locality:Oklahoma City` |

The fallback places each row in its correct county (WOF 102083987 Carter, 102083991 Johnston), where the off arm
placed it only in Oklahoma. It also removes the `locality` component the gold spans assign, because the register
writes the county as the postal community. Nine of the 43 are the `state-expand` augmentation, where 10.8.0 parses
`Oklahoma` as the locality on both arms.

**Probes.** 2 of 12 moved:

| Input                  | Off                                                                             | On                                                                       |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Harris County, TX`    | `venue=Harris County`, `locality=Harris County`, venue tier 29.76143, −95.35912 | `subregion=Harris County` → Harris 102081111, 29.850568, −95.454757      |
| `Jefferson County, KY` | `locality=Jefferson County`, top Kentucky 85688641, 37.696825, −84.924095       | `subregion=Jefferson County` → Jefferson 102084449, 38.198247, −85.61396 |

`Orange County, CA` and `Los Angeles County, CA` don't move: 10.8.0 tags `CA` as `country`, so no region is known and
the fallback stands down. `Orange County, California` and `Harris County, Texas` don't move: 10.8.0 tags the
county as `venue`, and the fallback reads only `locality` spans. Both are parse failures upstream of this change.

### Verdict

No release verdict distinguishes the arms (see the opening). The rule admits default-on with a `pass` or with no
differing rows, and 43 held-out rows differ, so the switch ships **off**. The 43 rows keep their coordinates and change their component labels
against the gold: the hierarchy gains the right county and the output loses the `locality` label the gold spans
assign. Default-on needs a decision on which reading of `CARTER COUNTY` the geocode output should report.

## B. Arabic letter fold

### What changed

`withArabicLetterVariantsFolded` drops tatweel, the short-vowel and shadda marks and the superscript alef. That leaves
a hamza-carrying alef bare. It also writes `ى` as `ي` and `ة` as `ه`. The function already lives in
`packages/resolver-wof-sqlite/lib/street/normalize.ts`, beside `normalizeLocalityForKey`, and
`packages/corpus/lib/build/region-names.ts` imports it from there. The one function serves both callers, so it didn't
move.

A fold inside `normalizeLocalityForKey` itself would re-key every artifact that calls it (address points, POI,
street keys, the browser index) and break every published one at once. The fold instead becomes a recorded fold of the
candidate artifact: `packages/resolver-wof-sqlite/lib/candidate/key-fold.ts` adds `applyCandidateKeyFold`, a
post-pass that rewrites every `candidate.name_key` the fold changes and records the fold in a `candidate_key_fold`
table, and `WOFCandidateTableLookup` reads that table once and folds every query key (the name, the stripped name,
the region-qualifier keys and the fuzzy-index hits) the same way. `buildCandidateTable` runs the pass under
`keyFolds: ["arabic-letter-variants"]`, off by default. An artifact without the table reads as before.

The measured arm is a copy of `candidate-global-2026-11-16.db` with the pass applied,
`/mnt/mw/audits/lane-y/candidate-global-2026-11-16-arabic-fold.db`: 296,243 rows rekeyed, 24,978 of them merged
into a row the place already had under the folded key, in 25 s. The live database wasn't touched.

### Moved rows

| Instrument                                                                       |  Rows | Differed |
| -------------------------------------------------------------------------------- | ----: | -------: |
| Regression board, board-routed                                                   | 1,352 |        0 |
| heldout-dev + heldout-confirm v0.8.18 (v2), 30 Arabic-script countries, geocoded | 8,082 |       20 |

The board holds 66 rows in Arabic-script countries and none written in Arabic script, so it can't exercise the fold.

**Held-out.** All 20 moved rows are in the development collection. Nineteen are `wof-admin` rows. Each row id holds
the id of the WOF record the text was rendered from, and that record is the truth. With the fold off, 16 of those 19 resolve to
their own record. With it on, none do:

| Fold-on outcome                                                          | Rows | Inputs                                                                                                    |
| ------------------------------------------------------------------------ | ---: | --------------------------------------------------------------------------------------------------------- |
| A duplicate record of the same place, 0.03–0.87 km from the truth record |   11 | `كَرْزَكَّان` ×3 (BH), `أَبُو صَيْبِع` ×2 (BH), `حاجی آباد ملّو` (IR), `الموالح الجنوبية` ×3 (OM), `أم خُنصر` ×2 (SA) |
| A different place, 30–7,553 km away                                      |    6 | listed below                                                                                              |
| Both arms miss the truth record                                          |    2 | `حسين احمد, العراق` (IQ, the pick moves 98 km), `خلف‌انصار` (IR, Calaf in Spain on both)                   |
| Same place and coordinate, another field differs                         |    1 | `13 جناح ایونیو, مجاہد پلازہ, اسلام آباد-44000` (PK, `osm-pk`)                                              |

The six that move to a different place:

| Input                          | Gold (WOF record)         | Off                                        | On                                       |
| ------------------------------ | ------------------------- | ------------------------------------------ | ---------------------------------------- |
| `الخيص`                        | `locality`, AE 1260192477 | Al Khis 1260192477, 23.008, 54.196         | Al Khayş 9000012028327 (YE), 1,400.5 km  |
| `عزبة الأترية أجا الدقهلية مصر` | `locality`, EG 1293603365 | `Izbat al Atariyah 1293603365              | region Ad Daqahliyah 85671017, 30.4 km   |
| `أُم  الكِلاب`                    | `locality`, PS 1175613225 | Umm al Kilab 1175613225                    | Umm al Kilab 1277162903 (QA), 1,748.4 km |
| `الوبرة`                       | `locality`, QA 1310693899 | Al Wabrah 1310693899                       | الوبره 8312031138017 (SA), 950.0 km      |
| `تِنْبَك`                         | `locality`, QA 1209887475 | Tinbak ash Sharqiyah al Qadimah 1209887475 | Tambac 890433885 (PH), 7,552.8 km        |
| `الفردش لحج اليمن`             | `locality`, YE 1293841307 | unresolved                                 | Alfred 101726561 (Texas, US)             |

The rows that leave their own record are single-word or short inputs written with the marks or `ة` the fold removes.
Their folded key now also reaches better-ranked namesakes in other countries.

### Fifty colliding keys

`scratchpad/2026/11/17/collisions.ts` groups the live database's Arabic-script keys by folded key, country and
placetype band (`region`, `county`, `locality`, `neighbourhood`). A group gains a place when the places its folded key
reaches outnumber those its largest unfolded spelling reached. 6,223 of 753,523 groups gain one. Lane S counted 8,480
newly ambiguous keys over its own grouping, a different statistic. A seeded draw of 50 (`mulberry32`,
seed 17) resolves the spelling the fold widens, the one that reached the fewest places, through `createWOFResolver`
over each database, and grades the fold-on pick against the fold-off pick by WOF identity and coordinate:

| Fold-on pick                                                                       | Rows |
| ---------------------------------------------------------------------------------- | ---: |
| The fold-off pick, the place WOF keys under that spelling                          |   23 |
| Another record of the same place, within 5 km (0.0–2.7 km)                         |    5 |
| A different place, 13.6–5,121.6 km away, that WOF keys only under another spelling |   22 |

The 22 include merges of distinct names as well as variant spellings of one name:

| Probe (country)  | Fold off                           | Fold on                                      |      Apart |
| ---------------- | ---------------------------------- | -------------------------------------------- | ---------: |
| `الیس` (US)      | Ellis, KS 85945223, keyed `الیس`   | Alice, TX 101723771, keyed `آلیس`            | 1,250.8 km |
| `تنگان` (IR)     | Tangan, Jiroft 1243118841          | Palangan, Kamyaran 1360067363, keyed `تَنگان` | 1,252.2 km |
| `آری` (AF)       | Saw, Kunar 1192972287              | Aray, Ghazni 1310686619, keyed `اری`         |   434.1 km |
| `بآلینگن` (DE)   | Bahlingen am Kaiserstuhl 101764169 | Balingen 101764313                           |    84.0 km |
| `الغندورية` (LB) | Ghandouriye, Bent Jbeil 1226039703 | El Ghandouriye, Chouf 1293199735             |    46.8 km |

One of the 22 runs the other way: `الخرابه` (YE) picks a record at 0.254, 0.780 with the fold off and Al Kharābah
890449261 in Al Bayda' with it on. Another (`راضية`, YE) moves onto such a record. The full sample, with every place's
coordinates, parents and keys, is `/mnt/mw/audits/lane-y/arabic-fold-collisions-sample.json`.

### Verdict

On the held-out rows the fold moves 20 of 8,082, improves none, and sends 6 to a different place 30–7,553 km
from the truth record. On the sample it changes the pick on 27 of 50 colliding keys, and on 22 of them the new pick is
a place WOF doesn't record under the spelling written. No release verdict distinguishes the arms, and rows differ, so
the fold stays **off**.

## Reproduce

The scripts and raw results are in `/mnt/mw/audits/lane-y/`. The scripts ran from `scratchpad/2026/11/17/` of a
checkout, and their relative imports assume that depth: `compare.ts` (both instruments), `heldout-inputs.ts` (the
held-out literal sets), `fold-copy.ts` (the folded copy), `collisions.ts`, `collisions-grade.ts` and `rows-print.ts`.
The raw results are `board-county.json`, `heldout-us-county.json`, `probes-county.json`, `board-arabic.json` and
`heldout-arab-fold.json`.
