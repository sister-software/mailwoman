# `postcodeConsistencyMaxMoveKm` against the population that carries #370's wins

Date: 2026-09-15. Record for #2301. Point-in-time; numbers are not updated.

## Question

#370's postcode-disambiguated locality selection was operator-promoted on a measured panel, and
#2301's tradeoff paragraph reads: _"A cap set below the distances that earned #370's promotion would
undo them."_ That is a claim about which of the pass's two steps produces its wins, and it had not
been measured.

The pass (`applyPostcodeConsistency`, `packages/resolver/lib/resolve/passes.ts`) does two separable
things to a locality that resolves farther than `postcodeConsistencyThresholdKm` from a resolved
sibling postcode, numbered here as its own docstring numbers them:

- **Step 2, the re-pick** — swap to the same-named candidate nearest the postcode, taking its id and
  its coordinate. Uncapped by design.
- **Step 3, the coordinate fallback** — when no same-named candidate reconciles, move the coordinate
  onto the postcode point while keeping the selected locality's id. This is the step
  `postcodeConsistencyMaxMoveKm` bounds, and the step that relocated `Nawāda, 744301` by 1,914 km.

A cap therefore costs a win only if that win came from step 3.

## Method

Four per-locale coordinate sets of real addresses published with their government point, run through
`mailwoman eval oa-resolver` against the candidate backend, one arm per configuration, with
`--out-rows` so every row's distance to truth is recorded individually.

| Arm            | Flag                                                |
| -------------- | --------------------------------------------------- |
| off            | `--postcode-consistency-off`                        |
| step 3 refused | `--postcode-max-move-km 0`                          |
| capped         | `--postcode-max-move-km 100 / 200 / 300 / 500`      |
| shipped        | none — the cap was unbounded when this was measured |

The `0` arm is what separates the two steps: it refuses every coordinate fallback (the guard is
`gapKm > maxMoveKm`, reached only when `gapKm` already exceeds the 50 km threshold) and leaves the
re-pick untouched. A row whose distance to truth differs between two arms is a row those arms
answered differently.

## Inputs

| Set |  Rows | Artifact                                   |
| --- | ----: | ------------------------------------------ |
| FR  | 3,000 | `$MAILWOMAN_DATA_ROOT/eval/coord/fr.jsonl` |
| US  | 2,000 | `$MAILWOMAN_DATA_ROOT/eval/coord/us.jsonl` |
| CZ  |   150 | `$MAILWOMAN_DATA_ROOT/eval/coord/cz.jsonl` |
| PL  |   150 | `$MAILWOMAN_DATA_ROOT/eval/coord/pl.jsonl` |

Each is a 2026-07 per-locale coordinate set from a scratch directory, renamed into the eval's own row
shape and republished under `eval/coord/` so this run reproduces without the rename. The rows are
unchanged: same addresses, same government points.

Read through `admin-global-priority.db` + `postcode-locality-intl.db` with
`--candidate-db candidate.db`, weights `weights/en-us` (npm 9.1.0). `--default-country none` for the
three European sets, `US` for the American one.

**FI and SI are absent, and they are two of the three locales #370's promotion named.** No FI or SI
coordinate set survives on disk; the four above are what does. FR is the substitute and is the locale
#370's motivating example came from (`06260 Saint-Pierre`, 617 km off).

## Result

| Set |     n | off p50 | off p90 | off p99 | shipped p50 | shipped p90 | shipped p99 | rows the pass changed | closer | farther |
| --- | ----: | ------: | ------: | ------: | ----------: | ----------: | ----------: | --------------------: | -----: | ------: |
| FR  | 3,000 |    0.99 |     4.3 |   511.6 |        0.94 |         3.4 |        12.8 |                   141 |    141 |       0 |
| US  | 2,000 |    3.30 |    10.4 |    74.1 |        3.29 |         9.9 |        22.3 |                    27 |     22 |       5 |
| CZ  |   150 |    1.86 |   190.0 |  1032.5 |        1.51 |         9.0 |      1032.5 |                    29 |     29 |       0 |
| PL  |   150 |    1.52 |   160.9 |   662.2 |        1.33 |         5.4 |       662.2 |                    16 |     16 |       0 |

Distances in km. Locality-match is identical between the two arms on all four sets (FR 98.1%, US
98.0%, CZ 93.3%, PL 96.0%) — the pass changes which INSTANCE of a name answers rather than which name.

**Rows step 3 changed: 0 of 5,300.** Every arm from `--postcode-max-move-km 0` upward returns a
row-for-row identical answer to the unbounded one, on all four sets. All 213 changed rows come from
the re-pick.

Worked rows, off → shipped:

```
Piękna 22, 59-900 Łagów                          424.9 km → 0.4 km
21-500 Biała Podlaska, Stanisława Mikołajczyka 11 378.3 km → 2.0 km
27301 Lhota, Fr. Černého 64                      277.9 km → 2.1 km
Hřebeny 8, 35709 Josefov                         239.1 km → 2.6 km
Týn 8, 47201 Luka                                189.5 km → 0.9 km
Vysoká, 58001, Čistá č.ev. 11                    122.4 km → 7.4 km
```

Each is a re-pick: the same name, a different instance, and the cap does not reach it.

## What this settles and what it does not

**Settles**: a cap cannot undo #370's promotion on this population, because #370's wins on it do not
come from the step a cap bounds. The tradeoff paragraph's premise does not hold here.

**Does not settle**: this population prices no cap VALUE against another, because step 3 never fires
on it. That is the same limit the frozen same-data fixture has, reached from the other side — there
the fallback fires and never helps; here the pass helps and the fallback never fires. Neither holds a
row where the fallback is the thing that produced a win, and after 5,300 real addresses across four
countries no such row has been observed.

The two bounds that do carry a value are unchanged from #2301:

- The same-data sweep: contradictory wrong-area 67.0% uncapped → 19.0% at 300 km → 13.0% at 100 km,
  with selection accuracy flat at 71.7% across every arm.
- The GeoNames distance census — postcode to the settlement its own dump row names, admin1 agreeing,
  800,762 rows across 33 countries: p50 1.9 km, p90 17.3 km, p95 25.0 km, p99 153.3 km, p99.9 468.8
  km.

## Decision

`postcodeConsistencyMaxMoveKm` defaults to **300 km** as of this record;
`DEFAULT_POSTCODE_MAX_MOVE_KM` in `packages/resolver/lib/resolve/passes.ts` is the declaration, and
`Infinity` restores the previous unbounded behaviour.

300 km sits above the 99th percentile of agreeing (postcode, settlement) pairs, so it admits every
relocation a CORRECT postcode could require, and refuses the class the option was opened for — a
transposed, retired or metro-adjacent code carrying the answer hundreds of kilometers from the
locality whose id the result keeps. It costs nothing measurable on the 5,300 rows above, which
include two tier-1 locales at 3,000 and 2,000 rows, and it recovers 48 of the 54 available
wrong-area points on the same-data panel.

The residual is FI and SI: their #370 counts (231/0 and 37/6) cannot be re-run from surviving
artifacts, so if either locale's wins came from the coordinate fallback rather than the re-pick, this
default would reduce them. 300 km above a p99 of 153.3 km is the margin that bounds that risk; a
tighter value does not have it.

## Reproduction

```bash
mailwoman eval oa-resolver \
  --eval <rows.jsonl> \
  --model $MAILWOMAN_DATA_ROOT/weights/en-us/model.onnx \
  --tokenizer $MAILWOMAN_DATA_ROOT/weights/en-us/tokenizer.model \
  --model-card $MAILWOMAN_DATA_ROOT/weights/en-us/model-card.json \
  --default-country none \
  --candidate-db $MAILWOMAN_DATA_ROOT/wof/candidate.db \
  [--postcode-consistency-off | --postcode-max-move-km <n>] \
  --out-rows <arm>.json
```

The eval's rows are `{ input, lat, lon, expected, state, source }`. The 2026-07 sets carried the same
facts under `{ raw, components, country, lat, lon }`; the published artifacts above are already in
the eval's shape.

A refused move now reaches a caller: `GeocodeResult.unfollowed_components` carries the postcode, the
reason `postcode_move_refused`, and the distance following it would have moved the answer. It is
separate from `dropped_components`, which names a span the flat projection deleted — a refused
postcode is KEPT, and reads as if it had been honoured without this field.
