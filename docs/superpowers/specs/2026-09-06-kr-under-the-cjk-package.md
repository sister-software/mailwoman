# Korean under the CJK package — corpus, labels, board (proposal)

Status: the operator took the four decisions on 2026-09-06 (join the family package, the KOGL line in the card, the `subregion` route, spend the probe); the probe `v8-cjk-kr-probe` is running as Modal app `ap-XEyyoAOPaSJbGwRe5v0n0g`. Written 2026-09-06 after the JP served path resolved (#2164 step 6, #2175), so that
the Korean decision is taken on measured supply rather than the 2026-07 triage claim ("KR: no adopted open path",
`docs/engineering/SCOPE.mdx`). Every number below was read on the lab data root on this date.

## 1. The decision this serves

The operator's distribution decision on #2034 / #1176: one CJK weights package a consumer installs as a unit. The
package is named `@mailwoman/neural-weights-cjk` and today carries Japanese and Chinese under one 49-label head.
Korean is the K, and it is the cheapest of the three to add: the source is on disk, its surface is whitespace-separated,
and every component it carries maps onto a tag the head already has.

## 2. What is on disk

`$MAILWOMAN_DATA_ROOT/openaddresses/extracted/kr/<province>/provincewide.csv` — the OpenAddresses delivery of the
national road-name address register (도로명주소, entrance points), 734 MB, UTF-8, WGS84.

| Quantity                                                  |     Value |
| --------------------------------------------------------- | --------: |
| rows                                                      | 6,173,505 |
| REGION (시·도)                                            |        17 |
| CITY (시·군·구, compound `수원시 장안구` included)        |       227 |
| rows whose CITY is compound (city + 구)                   |   665,910 |
| rows whose CITY is empty (Sejong)                         |    25,400 |
| STREET (도로명), distinct                                 |   134,484 |
| POSTCODE, distinct (every row carries one)                |    34,160 |
| rows with a DISTRICT (읍면동; every row)                  | 6,173,505 |
| rows with a UNIT                                          |         0 |
| distinct characters in the admin + street + number fields |       866 |
| of which Hangul syllables (with count ≥ 100)              | 848 (671) |

License: KOGL (공공누리) Type 1 — attribution to 행정안전부 (Ministry of the Interior and Safety); commercial use,
derivatives and redistribution permitted. A fresh pull from `business.juso.go.kr` needs Korean identity verification,
so the on-disk delivery is the source of record until someone with that access refreshes it; counsel confirms the
exact KOGL rider before the card ships (the 2026-07-18 acquisition note flags the newer "Type AI" rider).

## 3. Labels: nothing new on the head

| juso field | ComponentTag         | WOF placetype the candidate gazetteer keys it under                                                                                                                  |
| ---------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REGION     | `region`             | `region` — 17 of 17 keyed                                                                                                                                            |
| CITY       | `subregion`          | `county` — the 시군구 are WOF counties; 220 of 227 keyed, the 7 misses are two-level compounds (`천안시 동남구`, `창원시 마산합포구`, `청주시 흥덕구`, 183,457 rows) |
| DISTRICT   | `dependent_locality` | `localadmin` / `neighbourhood` — 631 of a first 800 distinct keyed; 169 miss (619,482 of 3,534,120 sampled rows)                                                     |
| STREET     | `street`             | not in WOF; the extract tier's question, out of scope here                                                                                                           |
| NUMBER     | `house_number`       | —                                                                                                                                                                    |
| POSTCODE   | `postcode`           | no KR postcode extract exists; the tag still trains                                                                                                                  |

`subregion`, not `locality`, because the resolver's locality filter group is `locality / borough / localadmin` and
does not admit `county`; `subregion → county` is already in `DEFAULT_PLACETYPE_MAP`. The compound city + 구 is the
JP compound municipality again (`compoundMunicipality`, #2175): the same scoped pair with a `^(.+시)(.+구)$` shape,
head under the region, tail under the head. Hangul keys are stored NFD (conjoining jamo); the probe's normalizer
already writes the same form, and a precomposed-range glob reads 0 where 87.3% of KR records carry a Hangul key.

The label set stays `stage3-cjk` (49 labels). The character vocabulary grows from 2,335 to about 3,180: 848 Hangul
syllables plus the 18 punctuation and digit characters the fields carry.

## 4. Registers

The official form is whitespace-separated, large to small, with the legal 동 in parentheses after the number:

```
서울특별시 종로구 자하문로 94 (청운동)
03047 서울특별시 종로구 자하문로 94
경기도 수원시 장안구 정자로 21
```

| Register         | Weight | What it teaches                                                                         |
| ---------------- | -----: | --------------------------------------------------------------------------------------- |
| `official`       |   0.35 | the full form, 동 in parentheses (the register the source itself is)                    |
| `no_dong`        |   0.25 | the same without the parenthetical — how it is typed                                    |
| `postcode_first` |   0.15 | five-digit postcode leading, the delivery form                                          |
| `short_region`   |   0.15 | `서울시` / `서울` / `경기` for `서울특별시` / `경기도` — the spoken forms of the region |
| `unspaced`       |   0.10 | the components run together, the way a search box receives them                         |

Two-letter romanized forms and English mixed input are out of scope for the first board; the query-shape router
sends Latin input to the Latin model.

## 5. Board and probe

The board is 20,000 held-out rows stratified by region (all 17), each carrying the row's entrance point. The parse is
graded per tag as the JP board is (`score_jp_probe_board.py --label-set stage3-cjk`, a KR rendering of the same
scorer); the served read through the resolver is graded on the entrance point at 15 km, since the gazetteer answers a
읍면동 or 시군구 centroid and never the door. Held-out 시군구 are drawn by the same seed rule as the JP board's held-out
municipalities, so the KR read reports the per-시군구 macro the #2165 report added.

The probe is 2,000 steps on the mixed JP + CN + KR corpus from the current `v8-cjk` recipe, pre-registered in the
config header before launch:

- JP board blended coordinate-acceptability ≥ 0.9653 (the shipped read; KR rows must not cost JP a pp).
- CN `locality_unit` ≥ 12 of 14.
- KR board: `street` and `house_number` per-tag ≥ 0.99, `subregion` ≥ 0.97, `dependent_locality` ≥ 0.95 at 2k steps —
  whitespace-separated surfaces read higher than JP's at the same step in every prior run, and lower than that is the
  finding.

A passing probe earns the 24k run, exported into the same served package (one `model.onnx`, one `char-vocab.json`,
one card), with the KR attribution line in the card.

## 6. Decisions the operator takes

1. Korean joins `@mailwoman/neural-weights-cjk` (the name promises it) rather than a separate `ko-kr` package.
2. The KOGL attribution text in the card, and whether counsel's rider question blocks publish or only the refresh.
3. The `subregion` mapping for the 시군구 (the alternative, widening the locality group to `county`, changes every
   locality lookup in every country and is not proposed).
4. Whether to spend the probe now or after the kana read (#2165) settles the JP base.

## 7. What this does not decide

The KR postcode extract (34,160 codes with entrance points is a per-country postcode database waiting to be built);
the street tier for KR (the entrance points are rooftop-grade and would make an address-point database, licensed
KOGL); the FST autocomplete tier (`fst-ko-kr.bin` is built, #1493).

## 8. State

Built on the lab data root and staged to R2 (2026-09-06), so the probe is one command:

| Artifact                                                                        | Value                                                                                                                         |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `corpus/versioned/v8-kr-2026-09-06` (`build_kr_slice.py`, seed 42)              | 2,000,000 train / 20,000 val / 20,000 board rows; 27 held-out 시군구; 0 rows dropped of 6,173,505; BIO coverage 0.962; 132 MB |
| registers landed (train)                                                        | official 0.35, no_dong 0.25, short_region 0.15, postcode_first 0.15, unspaced 0.10 — every row renders every register         |
| `corpus/versioned/v8-cjk-kr-2026-09-06` (`build_cjk_overlay.py --extra-corpus`) | JP kana parts + CN parts + KR parts; vocabulary 3,165 (2,239 JP + 842 KR)                                                     |
| `kr-sigungu-centroids.json`                                                     | 250 (region, 시군구) centroids from every source row                                                                          |
| the untrained base (`v8-cjk-kana`) on the KR board                              | 0.0000 on every tag but `house_number` (0.0428); 0 of 20,000 @15 km                                                           |
| configs                                                                         | `v8-cjk-kr-probe.yaml` (2,000 steps), `v8-cjk-kr.yaml` (24,000), pre-registered in their headers                              |

```bash
modal run corpus-python/modal/train_remote.py::sync_v8cjk_kr
modal run -d corpus-python/modal/train_remote.py --config v8-cjk-kr-probe.yaml --resume auto
```

Two shapes the build measured that the plan did not name: the source's REGION strings predate the 2023 renames
(`강원도`, `전라북도`), so both spellings carry a short form; and 시군구 with a two-level compound (`천안시 동남구`) render
as two adjacent `subregion` spans, the shape the resolver's scoped pair (#2175) will read.
