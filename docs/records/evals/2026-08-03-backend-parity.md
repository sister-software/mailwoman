# Resolver backend parity — FTS vs candidate table (2026-08-03)

**TL;DR.** The candidate-table backend is **at parity or ahead of FTS everywhere I measured**, and
the stale `46/51` in circulation is dead: on current main the POI board reads **FTS 51/51, candidate
50/51**. But the A/B that motivated this investigation measures the wrong thing. Selecting the
candidate backend also silently drops the locale-derived country filter, so
`12 Rue de Rivoli, 75001 Paris` resolving to Paris TX on FTS and Paris FR on candidate is **entirely
the country filter, not the backend** — FTS with `--default-country none` returns Paris FR, and
candidate with `--default-country US` returns Dallas TX. Isolating the two: on 40 gold rows the
country filter is worth **+10 cases**, the backend **+1**. At scale on 1050 real international
addresses the candidate backend fixes 66 gross errors and breaks 16 (net **+4.8pp** inside 25 km);
on 1200 US addresses it is better at every distance threshold with a **10× better p99** (259 km →
25.7 km) at identical locality-match. Across 2382 graded cases the candidate backend loses no
country, no placetype and no query shape — its only reproducible loss is a single POI-anchor case.
Defaulting candidate on is safe. Defaulting the country filter off is the larger,
riskier, separate decision — see the companion diagnosis in
[`2026-08-03-postcode-locality-scoping.md`](./2026-08-03-postcode-locality-scoping.md).

Run on `45dcf8da` (current main), shipped model `model-v401-base-step-060000-int8.onnx`, tokenizer
`v0.9.0-multisplice`.

## The confound, first

`mailwoman/commands/parse.tsx` `resolverDefaultCountry(options, candidateActive)` returns
`localeToCountry(options.locale)` for FTS and `undefined` for candidate. `--locale` defaults to
`en-US`. So the documented A/B —

```bash
node mailwoman/out/cli.js parse "…" --resolve --resolve-db $WOF               # FTS,       dc=US
MAILWOMAN_CANDIDATE_DB=… node mailwoman/out/cli.js parse "…" --resolve …      # candidate, dc=none
```

— changes two variables at once. Cross them and the effect lands on the filter, not the backend:

| arm                             | `12 Rue de Rivoli, 75001 Paris`       | verdict |
| ------------------------------- | ------------------------------------- | ------- |
| FTS + `dc=US` (today's default) | 33.668553, −95.544350 — Paris **TX**  | wrong   |
| FTS + `dc=none`                 | 48.856599, 2.342841 — Paris **FR**    | right   |
| candidate + `dc=US`             | 32.960001, −96.838499 — Dallas **TX** | wrong   |
| candidate + `dc=none`           | 48.856599, 2.342841 — Paris **FR**    | right   |

Every measurement below therefore runs the full 2×2 where the instrument allows it.

## Instrument A — `demo-cascade-smoke`, 40 rows, 2×2

`data/eval/external/demo-cascade-smoke.jsonl` is the only committed resolver-level gold set (WOF
place IDs, bare city names and full addresses, US/DE/FR/ES/VE). No committed FTS-vs-candidate
fixture exists, so I ran this one through a 2×2 in-process runner: model loaded once, both lookups
constructed in one process, tree re-parsed per arm (`resolveTree` mutates).

Graded on distance from the gold place's own WOF centroid (≤25 km), because gold IDs are not
comparable — "Paris" gold is `101751119` (locality) while both backends legitimately return
`1159322569` (localadmin), the same city.

**Positive control** — `Chicago, Illinois`, first row of every run: all four arms returned
`wof:85940195`, exact ID, **0.00 km**. The read path is confirmed live. (Resolved coordinates land
on `node.lat`/`node.lon`; `node.resolved.latitude` does not exist anywhere in the codebase and would
have produced a false clean sweep.)

| arm         | within 25 km | within 5 km | exact WOF ID | no hit |
| ----------- | -----------: | ----------: | -----------: | -----: |
| FTS + US    |    **28/40** |          27 |           25 |      2 |
| FTS + none  |    **38/40** |          37 |           33 |      0 |
| cand + US   |    **28/40** |          28 |           27 |      2 |
| cand + none |    **39/40** |          39 |           36 |      0 |

Distance counts are corrected +1 from the raw harness output for the stale Barcelona row (see
below); the exact-WOF-ID column is left raw, since that row's gold ID matches no arm and is itself
invalid.

**Country filter: +10 / +11 cases. Backend: +1 case.**

### Per-case

Format: `✅/❌ resolved-name/country distance-from-gold`.

| input                                           | gold                 | FTS+US                      | FTS+none                    | cand+US                     | cand+none                   |
| ----------------------------------------------- | -------------------- | --------------------------- | --------------------------- | --------------------------- | --------------------------- |
| New York City                                   | New York/US          | ✅ New York/US 0km          | ✅ New York/US 0km          | ✅ New York/US 0km          | ✅ New York/US 0km          |
| new york city                                   | New York/US          | ✅ New York/US 0km          | ✅ New York/US 0km          | ✅ New York/US 0km          | ✅ New York/US 0km          |
| Brooklyn                                        | Brooklyn/US          | ✅ Brooklyn/US 0km          | ✅ Brooklyn/US 0km          | ✅ Brooklyn/US 0km          | ✅ Brooklyn/US 0km          |
| brooklyn, new york, ny                          | Brooklyn/US          | ❌ New York/US 288km        | ❌ New York/US 288km        | ❌ New York/US 288km        | ❌ New York/US 288km        |
| Chicago                                         | Chicago/US           | ✅ Chicago/US 0km           | ✅ Chicago/US 0km           | ✅ Chicago/US 0km           | ✅ Chicago/US 0km           |
| Seattle                                         | Seattle/US           | ✅ Seattle/US 0km           | ✅ Seattle/US 0km           | ✅ Seattle/US 0km           | ✅ Seattle/US 0km           |
| San Francisco                                   | San Francisco/US     | ✅ San Francisco/US 0km     | ✅ San Francisco/US 0km     | ✅ San Francisco/US 0km     | ✅ San Francisco/US 0km     |
| Washington, DC                                  | Washington/US        | ✅ Washington/US 0km        | ✅ Washington/US 0km        | ✅ Washington/US 0km        | ✅ Washington/US 0km        |
| Saint Paul, MN                                  | St. Paul/US          | ✅ St. Paul/US 0km          | ✅ St. Paul/US 0km          | ✅ St. Paul/US 0km          | ✅ St. Paul/US 0km          |
| Springfield, IL                                 | Springfield/US       | ✅ Springfield/US 0km       | ✅ Springfield/US 0km       | ✅ Springfield/US 0km       | ✅ Springfield/US 0km       |
| Berlin                                          | Berlin/DE            | ❌ Berlin/US 6242km         | ✅ Berlin/DE 0km            | ❌ Berlin/US 6242km         | ✅ Berlin/DE 0km            |
| Paris                                           | Paris/FR             | ❌ Paris/US 7781km          | ✅ Paris/FR 0km             | ❌ Paris Township/US 6493km | ✅ Paris/FR 0km             |
| 1600 Pennsylvania Ave NW, Washington, DC 20500  | Washington/US        | ✅ Washington/US 0km        | ✅ Washington/US 0km        | ✅ Washington/US 0km        | ✅ Washington/US 0km        |
| 350 5th Ave, New York, NY 10118                 | New York/US          | ✅ New York/US 0km          | ✅ New York/US 0km          | ✅ New York/US 0km          | ✅ New York/US 0km          |
| Pier 39, San Francisco, CA 94133                | San Francisco/US     | ✅ San Francisco/US 0km     | ✅ San Francisco/US 0km     | ✅ San Francisco/US 0km     | ✅ San Francisco/US 0km     |
| 1060 W Addison St, Chicago, IL 60613            | Chicago/US           | ✅ Chicago/US 0km           | ✅ Chicago/US 0km           | ✅ Chicago/US 0km           | ✅ Chicago/US 0km           |
| 400 Broad St, Seattle, WA 98109                 | Seattle/US           | ✅ Seattle/US 0km           | ✅ Seattle/US 0km           | ✅ Seattle/US 0km           | ✅ Seattle/US 0km           |
| Straußstraße 27, 12623 Berlin                   | Berlin/DE            | ❌ Berlin/US 6242km         | ✅ Berlin/DE 0km            | ❌ Berlin/US 6242km         | ✅ Berlin/DE 0km            |
| 5 Hauptstraße, Berlin, Berlin 10115             | Berlin/DE            | ❌ Berlin/US 6242km         | ✅ Berlin/DE 0km            | ❌ Berlin/US 6376km         | ✅ Berlin/DE 0km            |
| 181 Rue du Chevaleret, Paris                    | Paris/FR             | ❌ Paris/US 7781km          | ✅ Paris/FR 0km             | ❌ Paris Township/US 6493km | ✅ Paris/FR 0km             |
| Los Angeles                                     | Los Angeles/US       | ✅ Los Angeles/US 0km       | ✅ Los Angeles/US 0km       | ✅ Los Angeles/US 0km       | ✅ Los Angeles/US 0km       |
| Houston                                         | Houston/US           | ✅ Houston/US 0km           | ✅ Houston/US 0km           | ✅ Houston/US 0km           | ✅ Houston/US 0km           |
| Philadelphia                                    | Philadelphia/US      | ✅ Philadelphia/US 0km      | ✅ Philadelphia/US 0km      | ✅ Philadelphia/US 0km      | ✅ Philadelphia/US 0km      |
| Denver                                          | Denver/US            | ✅ Denver/US 0km            | ✅ Denver/US 0km            | ✅ Denver/US 0km            | ✅ Denver/US 0km            |
| Austin, TX                                      | Austin/US            | ✅ Austin/US 0km            | ✅ Austin/US 0km            | ✅ Austin/US 0km            | ✅ Austin/US 0km            |
| Boston                                          | Boston/US            | ✅ Boston/US 6km            | ✅ Boston/US 6km            | ✅ Boston/US 0km            | ✅ Boston/US 0km            |
| Portland, OR                                    | Portland/US          | ✅ Portland/US 0km          | ✅ Portland/US 0km          | ✅ Portland/US 0km          | ✅ Portland/US 0km          |
| München                                         | München/DE           | ⚠ NO HIT                    | ✅ München/DE 0km           | ⚠ NO HIT                    | ✅ München/DE 0km           |
| **Munich**                                      | München/DE           | ❌ Munich/US 7344km         | ❌ Munich/US 7344km         | ❌ Munich/US 7344km         | ✅ **München/DE 0km**       |
| Hamburg                                         | Hamburg/DE           | ❌ Hamburg/US 6263km        | ✅ Hamburg/DE 0km           | ❌ Hamburg/US 6263km        | ✅ Hamburg/DE 0km           |
| Lyon                                            | Lyon/FR              | ❌ Lyon/US 6688km           | ✅ Lyon/FR 0km              | ❌ Lyon/US 6688km           | ✅ Lyon/FR 0km              |
| Marseille                                       | Marseille/FR         | ⚠ NO HIT                    | ✅ Marseille/FR 0km         | ⚠ NO HIT                    | ✅ Marseille/FR 0km         |
| 200 E Colfax Ave, Denver, CO 80203              | Denver/US            | ✅ Denver/US 0km            | ✅ Denver/US 0km            | ✅ Denver/US 0km            | ✅ Denver/US 0km            |
| 1600 Amphitheatre Pkwy, Mountain View, CA 94043 | Mountain View/US     | ✅ Mountain View/US 0km     | ✅ Mountain View/US 0km     | ✅ Mountain View/US 0km     | ✅ Mountain View/US 0km     |
| Frankfurt am Main                               | Frankfurt am Main/DE | ❌ Main/US 6334km           | ✅ Frankfurt am Main/DE 0km | ❌ Main/US 6334km           | ✅ Frankfurt am Main/DE 0km |
| Frankfurt, Germany                              | Frankfurt am Main/DE | ✅ Frankfurt am Main/DE 0km | ✅ Frankfurt am Main/DE 0km | ✅ Frankfurt am Main/DE 0km | ✅ Frankfurt am Main/DE 0km |
| Nashville, TN                                   | Nashville/US         | ✅ Nashville/US 0km         | ✅ Nashville/US 0km         | ✅ Nashville/US 0km         | ✅ Nashville/US 0km         |
| 1776 Independence Ave, Philadelphia, PA 19106   | Philadelphia/US      | ✅ Philadelphia/US 0km      | ✅ Philadelphia/US 0km      | ✅ Philadelphia/US 0km      | ✅ Philadelphia/US 0km      |
| Toledo, Spain                                   | Toledo/ES            | ✅ Toledo/ES 0km            | ✅ Toledo/ES 0km            | ✅ Toledo/ES 0km            | ✅ Toledo/ES 0km            |
| Barcelona, Venezuela                            | _(gold stale)_       | ✅ Barcelona/VE             | ✅ Barcelona/VE             | ✅ Barcelona/VE             | ✅ Barcelona/VE             |

Exactly **one** row separates the backends at `dc=none`: **Munich**, the English exonym. Candidate
returns München/DE; FTS falls to Munich, North Dakota. Candidate regressions against FTS at
`dc=none`: **zero**.

### Two defects the run surfaced

**The Barcelona gold row is rotted, and synthetic WOF IDs are not portable between the two
databases.** Gold expects `8000001092006`. In `admin-global-priority.db` that ID is now _Dolok
Merawan, Indonesia_; in `candidate-global-1026.db` it is _Skałówki, Poland_. Both backends returned
the correct place at the identical coordinate `10.1326, −64.6820` under _different_ IDs
(`8000000325637` FTS, `8000000473947` candidate), and each of those IDs points at a different place
in the other database. The Overture-derived `8000000000000+` range is reassigned on every gazetteer
build, so **ID-equality grading is invalid across backends and across builds** for that range. I
scored the row as a pass for all four arms.

**`brooklyn, new york, ny` fails on all four arms** — both backends return the New York _region_,
288 km out. Backend-independent; a parse/cascade defect, not in scope here.

## Instrument B — the POI board, 51 cases (the historical instrument)

The remembered `46/51` came from `mailwoman/eval-harness/fixtures/poi-board.jsonl` run twice, once
per backend, on 2026-07-20 (scratchpad only, never promoted). It went 46 → 48 after #1225. Re-run on
current main with `mailwoman eval poi-board`:

| backend   |   overall | abstain | address-guard | nearest-km p50 |  p95 |      max |
| --------- | --------: | ------: | ------------: | -------------: | ---: | -------: |
| FTS       | **51/51** |     8/8 |           6/6 |          0.579 | 6.52 |     9.73 |
| candidate | **50/51** |     8/8 |           6/6 |          0.579 | 7.58 | **1151** |

Both clear every pre-registered floor. On 36 of the 37 anchored cases the two are numerically
identical to 3 decimal places.

The single failure is `cat-ca-02`, `"gas station near Ottawa ON"` — candidate anchors on Ottawa,
**Illinois**, 1151 km out. It is a singleton, not a class:

| case          | query                         |         candidate |
| ------------- | ----------------------------- | ----------------: |
| cat-ca-01     | `restaurant near Toronto ON`  |        0.22 km ✅ |
| **cat-ca-02** | `gas station near Ottawa ON`  | **1150.98 km ❌** |
| cat-ca-03     | `hotel near Vancouver BC`     |        0.42 km ✅ |
| nm-03         | `atm, Toronto, ON`            |        0.05 km ✅ |
| **nm-05**     | `post office near Ottawa, ON` |    **0.03 km ✅** |
| brand-ca-01   | `Tim Hortons near Toronto ON` |        1.76 km ✅ |

`Ottawa ON` fails, `Ottawa, ON` passes — the comma is the whole difference, and every other
province-abbreviation anchor passes. It is not a gazetteer-content problem either: the candidate
table's own ranking already puts Ottawa CA on top (county 1,000,000 pop at `neg_rank` −6.000,
locality 934,243 at −5.970) with Ottawa IL sixth at 18,752. Plain `mailwoman parse "Ottawa ON"`
resolves correctly on **both** backends — the defect is confined to the POI anchor path. Worth its
own issue; it is the only reproducible candidate loss in this whole investigation.

## Instrument C — where the difference actually lives (41-case class probe)

Four query classes, gold coordinates taken from WOF itself, both backends at `dc=none`:

| class        | example                       |  FTS+none | cand+none |
| ------------ | ----------------------------- | --------: | --------: |
| `ca-abbrev`  | `Ottawa ON`, `London ON`      |      6/10 |      6/10 |
| `au-abbrev`  | `Sydney NSW`, `Perth WA`      |       4/5 |       4/5 |
| **`exonym`** | `Munich`, `Naples`, `Lisbon`  |  **4/13** | **10/13** |
| `endonym`    | `München`, `Napoli`, `Lisboa` |     11/13 |     11/13 |
| **total**    |                               | **25/41** | **31/41** |

The candidate advantage is **entirely the exonym class** and nothing else. Endonyms, province
abbreviations and state abbreviations are byte-identical — including identical _failures_
(`Winnipeg MB` no-hit on both, `Edmonton AB` → Alberta region on both, `London ON` → London GB on
both, `Perth WA` → Perth US on both). Those are shared defects of the resolution path, not backend
differences.

The exonym wins, each one FTS landing on a US homonym:

| input   | FTS+none             | cand+none          |
| ------- | -------------------- | ------------------ |
| Munich  | ❌ Munich/US 7344 km | ✅ München/DE 0 km |
| Cologne | ❌ Cologne/IT 636 km | ✅ Köln/DE 0 km    |
| Naples  | ❌ Naples/US 8614 km | ✅ Napoli/IT 0 km  |
| Lisbon  | ❌ Lisbon/US 6409 km | ✅ Lisboa/PT 0 km  |
| Athens  | ❌ Athens/US 9040 km | ✅ Αθήνα/GR 0 km   |
| Milan   | ❌ Milan/US 7799 km  | ✅ Milano/IT 0 km  |

Candidate carries alias `name_key` rows that map the English exonym onto the endonym place. FTS's
FTS5 index does not, so it takes the highest-ranked literal-string match, which in a US-heavy
gazetteer is the American namesake. `Florence` still fails on both; `Gothenburg` and `Antwerp`
no-hit on both.

## Instrument D — 1050 real international addresses (`mailwoman eval oa-resolver`, `dc=none`)

`oa-*-coord-150` for AT/CZ/FR/IT/LU/PL/PT, remapped into the oa-resolver row schema.

| metric                       |         FTS |   candidate |
| ---------------------------- | ----------: | ----------: |
| locality-match (by **name**) |   **94.7%** |       92.5% |
| resolved                     |       99.7% |  **100.0%** |
| within 1 km                  |   **36.6%** |       32.6% |
| within 5 km                  |   **76.2%** |       72.4% |
| within 25 km                 |       84.2% |   **89.0%** |
| within 100 km                |       87.2% |   **91.4%** |
| coord p50                    | **1.54 km** |     2.43 km |
| coord p90                    |    180.0 km | **46.6 km** |

**Gross-error swap at 25 km: candidate fixes 66 rows, breaks 16.** Net **+50 rows (+4.8pp)**, a 4:1
ratio.

The name-based `locality-match` metric disagrees with the coordinate metric, and the coordinate
metric is the one that matters. Per-country locality-match puts the candidate "loss" mostly in
PL (99.3% → 90.7%), PT (94.0 → 90.7) and CZ (73.3 → 70.7). Pulling the 13 PL rows apart:

- **12 of the 13 still land within 25 km** of the true address point, most within 1–7 km. Candidate
  returned a coarser or differently-named admin unit (the gmina rather than the locality) whose
  centroid is fine. Only `Zofiówka` is a genuine blow-out (0.5 km → 400.1 km).
- One row FTS scored as a locality-**match** was **424.9 km** from the true point (`Łagów`);
  candidate scored it a miss at **6.2 km**.

So `locality-match` penalises candidate for naming and rewards FTS for a 425 km error. This is
exactly the aggregate-hides-the-truth case: candidate trades a little fine precision (p50 1.5 → 2.4
km) for a large reduction in catastrophic error (p90 180 → 47 km).

## Instrument E — 1200 US addresses, full 2×2

The decision-critical leg, since `--locale` defaults to `en-US`.

| arm         | loc-match |     ≤1 km |     ≤5 km |    ≤25 km |    ≤100 km |      p50 |  p90 |   **p99** |    max |
| ----------- | --------: | --------: | --------: | --------: | ---------: | -------: | ---: | --------: | -----: |
| FTS + US    |     97.3% |     13.8% |     66.6% |     97.3% |      98.4% |     3.34 | 11.3 | **259.1** |   1358 |
| FTS + none  |     97.3% |     13.8% |     66.6% |     97.3% |      98.4% |     3.34 | 11.3 | **259.1** |   1358 |
| cand + US   |     97.3% | **17.9%** | **72.0%** | **98.8%** | **100.0%** | **2.47** | 11.4 |  **25.7** | **71** |
| cand + none |     97.3% | **17.9%** | **72.0%** | **98.8%** | **100.0%** | **2.47** | 11.4 |  **25.7** | **71** |

Two clean results:

1. **The country filter is a complete no-op on well-formed US addresses** — the rows are
   byte-identical between `dc=US` and `dc=none` on both backends, because the parse already carries
   its own region and postcode. The filter only bites on bare, country-less city names.
2. **The backend is a strict improvement on US data**: equal locality-match and region-match, better
   at every distance threshold, worst-case error 1358 km → 71 km, p99 10× better. Fixes 30 rows,
   breaks 12.

## Is a wrong answer distinguishable by score?

No. `node.metadata.resolver_score`, correct vs wrong, within each backend on Instrument A:

| backend     | correct                           | wrong                            |
| ----------- | --------------------------------- | -------------------------------- |
| FTS + none  | n=37, 18.85–40.92, mean **24.33** | n=3, 22.77–28.98, mean **25.67** |
| cand + none | n=38, 4.91–6.95, mean **6.07**    | n=2, 5.75–7.29, mean **6.52**    |

In both backends the wrong answers' range sits **inside** the correct answers' range and their mean
is **higher**. There is no threshold that gates errors without discarding correct answers, so a
score-based abstention or confidence surface cannot be built on this field as it stands.

The two scales are also not comparable to each other — FTS is bm25-derived (≈19–41), candidate is
population/`neg_rank`-derived (≈5–7). Any consumer switching backends must not carry a hardcoded
score threshold across.

## Structural note: the two databases hold different things

Distinct places, `admin-global-priority.db` `spr` vs `candidate-global-1026.db` (distinct `spr_id`):

| placetype      |       FTS |     candidate |              Δ |
| -------------- | --------: | ------------: | -------------: |
| locality       | 4,384,344 |     3,731,855 |       −652,489 |
| neighbourhood  |   349,708 |       158,846 |       −190,862 |
| localadmin     |   139,529 |       111,982 |        −27,547 |
| county         |    37,290 |        36,174 |         −1,116 |
| region         |     4,303 |         4,299 |             −4 |
| borough        |       289 |           210 |            −79 |
| country        |       237 |           237 |              0 |
| **postalcode** |     **0** | **3,661,017** | **+3,661,017** |

Candidate carries 3.66M postcodes the FTS shard has none of — which is why the candidate arm of the
Paris reproduction also resolves `75001` to `wof:421307175` while FTS leaves it bare — and drops
~873k admin places, mostly thin-tail localities and neighbourhoods. I did **not** determine whether
those dropped rows are deprecated/superseded WOF records (a cleanup) or real coverage loss. Nothing
in the measured sets tripped on it, but a thin-tail rural probe would be the way to close it.

## Verdict

**The candidate backend is ahead, not behind.** Consolidated, every case run at matched country
policy:

| instrument                             | cases |    FTS | candidate |
| -------------------------------------- | ----: | -----: | --------: |
| demo-cascade-smoke (`dc=none`, ≤25 km) |    40 |     38 |    **39** |
| POI board                              |    51 | **51** |        50 |
| class probe (`dc=none`, ≤25 km)        |    41 |     25 |    **31** |
| oa-resolver intl (`dc=none`, ≤25 km)   |  1050 |    882 |   **934** |
| oa-resolver US (≤25 km)                |  1200 |   1167 |  **1185** |

**Defaulting the candidate backend on is safe.** It costs one known POI-anchor case (`Ottawa ON`
without a comma) and buys the exonym class plus a materially shorter error tail on both US and
international data. There is no country, no placetype, and no query shape where it loses
systematically — the one loss is a reproducible singleton with a clear owner, and the fine-precision
p50 cost (1.5 → 2.4 km international) is real but small next to the p90 gain (180 → 47 km).

**Two caveats on the way the flip is framed.** First, ship the backend flip _without_ also flipping
the country filter, or the change is untestable against these numbers — they are separate levers
with separate risk, and it is the filter, not the backend, that carries the +10 on bare
international city names. Second, `mailwoman/resolver-backend.ts` currently makes them one lever;
splitting `resolverDefaultCountry`'s `candidateActive` branch from the backend selection is a
prerequisite for shipping either independently.

## What I did not measure

- **Non-Latin scripts.** Zero JP/KR/CN/AR/TH coverage in any instrument. The exonym mechanism that
  drives the candidate win is an alias-table property, so CJK behaviour does not follow from these
  numbers.
- **GB, DE, ES, NL, the Nordics at scale.** The 1050-row international set is AT/CZ/FR/IT/LU/PL/PT.
  `oa-gb-coord-1k`, `oa-de/es/nl-*` and the `-1k` sets went unrun.
- **Latency and memory.** Candidate is 1.65 GB against FTS's 5.28 GB and did not appear slower, but
  I ran no benchmark and report no p50/p99 timings.
- **Postcode-only queries**, despite candidate holding 3.66M postcodes and FTS none. A likely large
  candidate win, entirely unquantified.
- **The rooftop / street tier.** Street-tier coordinates land in `street.metadata.address_point`,
  not `node.lat`; my walker reads admin-grade coordinates only. Nothing here speaks to
  address-point or interpolation resolution.
- **`node.interpretations[]`.** Dual-role places (city-states) carry a second resolved place there
  which my primary-node pick ignores. Berlin-class rows may hide a second answer.
- **Whether the dropped ~873k admin places are deprecated records or real coverage loss.**
- **Reproducibility of `candidate-global-1026.db` itself** — it is a 2026-07-07 artifact; I did not
  verify it rebuilds identically from current main.
- **Older candidate DBs.** I used `candidate-global-1026.db` throughout: newest (2026-07-07) and
  largest (12.16M rows / 7.71M distinct places, against 10.20M / 10.14M / 8.97M for
  `-920`, `-coverage-admin`, `-20j`). No cross-version comparison was run.

## Reproducing

Instruments B, D and E use shipped tooling:

```bash
WOF=$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db
CAND=$MAILWOMAN_DATA_ROOT/wof/candidate-global-1026.db

# Instrument B — POI board, one backend per run
node mailwoman/out/cli.js eval poi-board --resolve-db $WOF --json
node mailwoman/out/cli.js eval poi-board --resolve-db $WOF --candidate-db $CAND --json

# Instruments D/E — add --candidate-db for the candidate arm, vary --default-country
node mailwoman/out/cli.js eval oa-resolver --eval <rows.jsonl> --default-country none \
  --wof $WOF --model neural-weights-en-us/model.onnx \
  --tokenizer neural-weights-en-us/tokenizer.model \
  --model-card neural-weights-en-us/model-card.json --out-rows <dump.json>
```

Instruments A and C used a throwaway 2×2 runner (both lookups in one process, `createRuntimePipeline`

- `createWOFResolver`, re-parse per arm) that was not committed — the `scripts/` drawer is closed to
  one-offs. The essential contract to rebuild it: construct `WOFSqlitePlaceLookup({ databasePath })`
  and `WOFCandidateTableLookup({ databasePath })` directly rather than through `createResolverBackend`
  (which reads `$MAILWOMAN_CANDIDATE_DB` and can only yield one backend per call), pass
  `resolveOpts.defaultCountry` per arm, and read results off `node.lat` / `node.lon` /
  `node.placeID` / `node.metadata.resolver_{score,name,country}` — never `node.resolved.*`, which does
  not exist and silently yields `undefined`.
