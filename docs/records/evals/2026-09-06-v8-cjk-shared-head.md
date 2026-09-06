# v8-cjk: one head for Japanese and Chinese, and the served path that reads it

**Date:** 2026-09-05/06 · **Runs:** `v8-cjk-full` (app `ap-J0uaLu8mQutAWu4ZdtBNzZ`), `v8-cjk-control` (`ap-XxMaxBMOhBYiCbP8bQ1c4U`), probe `v8-cjk-full-2k` (`ap-caJ1AN10iZOACLuFQrT7rG`) · **Arc:** #1176 / #2034 / #2164 · **Status:** the shared head is the CJK base candidate; the kana register run (#2165) is the next read.

The decision this records: one CJK weights package a consumer installs as a unit, Japanese and Chinese under one
49-label head (`stage3-cjk` = `stage3-jp` + `locality_unit`), trained on the char path from scratch. A per-script
Chinese model was refused on supply (126 labeled rows). Every number below is on the 20,000-row JP board the JP arc
registered (held-out municipalities, coordinate-acceptability at 15 km via the municipality centroid table), scored
with `corpus-python/scripts/score_jp_probe_board.py`.

## 1. The comparison arm was wrong, and the probe read against the corrected one

The 24k JP record carried a 2k-probe read of 0.2237 blended / 0.1847 municipality. Re-scored with the current scorer
the same checkpoint reads **0.9931 / 0.9947**: the probe had been read through the 33-label table (the record now
carries the correction). Against that arm the shared head's 2k probe read 0.9840 blended, every JP tag inside 1 pp,
municipality and district the closest; the full run launched on it.

## 2. The 24k reads, and what the control separated

| JP board, 20,000 rows                                     | v8-jp-full 24k, 47 labels | v8-cjk-control 24k, 49 labels, JP only | v8-cjk-full 24k, 49 labels, JP + CN |
| --------------------------------------------------------- | ------------------------- | -------------------------------------- | ----------------------------------- |
| coordinate-acceptability @15 km (row-weighted, the check) | 0.9928                    | 0.9737                                 | 0.9653                              |
| municipality macro (mean over 51 held-out municipalities) | 0.9833                    | 0.9762                                 | 0.9757                              |
| municipality span exact-match                             | 0.9943                    | 0.9752                                 | 0.9668                              |
| `かすみがうら市` failed rows, of 823                      | 2                         | 398                                    | 598                                 |
| `中新川郡上市町` failed rows, of 136                      | 112                       | 96                                     | 66                                  |
| failed rows on every other municipality                   | 0                         | 2                                      | 0                                   |

The row-weighted number moved 2.75 pp under the record and the pre-registration called that "the CN rows cost
something" — until the control, with no Chinese row in its mixture, dropped the trailing 市 on the same held-out
hiragana municipality in 398 of 823 rows. On the macro the shared head and the control are 0.05 pp apart. The
difference to the record is two names, and one of them carries 4.1% of the board's rows; #2165 carries the
per-municipality report (landed) and the kana-surface register (running).

**Han unification did not cost what it was expected to.** Municipality names that contain a code point the CN rows
also label (102 of the CN slice's 166 Han characters are in the JP vocabulary) read **0.9947** on the shared head
against 0.9909 on the JP-only record; names with none read 0.9217 against 0.9997, and 598 of those 598 are
Kasumigaura. The cost shows on the Chinese side instead: two of the 14 CN board rows start the `locality_unit` one
character late, on a Han-unified numeral (四, 一) at the boundary with the dependent locality.

## 3. The served path reads the same numbers

The runtime could neither export, resolve nor run a char-path model before this arc (`export_onnx.py` had no
`char_ids` wrapper; `@mailwoman/neural` had no character encoder and required `tokenizer.model`). With #2164's steps
1–5 on main, the v8-cjk-full 24k graph (30.6 MB fp32, PyTorch↔ONNX max_abs_diff 5.7e-6 over 256 rows) served through
`NeuralAddressClassifier.loadFromWeights` reads:

| JP board, served TypeScript path vs PyTorch scorer | served                                    | PyTorch                   |
| -------------------------------------------------- | ----------------------------------------- | ------------------------- |
| coordinate-acceptability @15 km                    | 0.9633 (19,266 / 20,000)                  | 0.9653 (19,305 / 20,000)  |
| municipality / district / house_number             | 0.9648 / 0.9634 / 0.9921                  | 0.9668 / 0.9644 / 0.9924  |
| prefecture / block / postcode / building_number    | 1.0000                                    | 1.0000                    |
| CN board `locality_unit`, 14 rows                  | 12 / 14 (Viterbi over the same emissions) | 10 / 14 (per-unit argmax) |

12.5 ms per row after warm-up. One repair had to be switched off for the char path: the SentencePiece
word-consistency repair, which folds the pieces of one whitespace word onto one tag, folded a Japanese address —
no whitespace, so one "word" — into a single municipality span on the first served parse.

## 3b. The served path through the RESOLVER: 0 of 300 before, 1,823 of 2,000 after

Section 3 graded the parse. `mailwoman geocode 大阪府大阪市北区梅田3-1-1 --locale ja-JP` on that tree answered the parse
with no coordinate, and `〒885-0061 宮崎県都城市下長飯町1867-2` answered a wrong parse (prefecture `崎県都`, municipality
`城市`). Three separate causes, each measured on the same 300 board rows (seed 42, @15 km on the board's own point) with
`packages/mailwoman/lib/dev-tools/jp-served-resolve.run.ts`:

| Arm                                                                           | resolved | accepted @15 km |
| ----------------------------------------------------------------------------- | -------: | --------------: |
| shipped map + shipped ladder (the JP tags are never queried)                  |       15 |        0 (0.0%) |
| JP placetype map, JP ladder district-first, 〒 stripped by the normalizer     |      267 |     171 (57.0%) |
| JP placetype map, JP ladder district-first, 〒 kept                           |      300 |     202 (67.3%) |
| JP placetype map, JP ladder municipality-first, 〒 kept — **shipped**         |      300 |     271 (90.3%) |
| the same, with a compound municipality reduced to its trailing unit, unscoped |      300 |     251 (83.7%) |

1. **The placetype map.** `DEFAULT_PLACETYPE_MAP` carried no entry for `prefecture`, `municipality` or `district`, so the
   resolver's walk skipped them by design ("a different extract entirely", written when JP was postcode-route only). The
   candidate gazetteer keys them: 49,255 of 53,920 JP records (91.3%) carry a kanji or kana key, `大阪府` is a `region`,
   `大阪市` a `locality`, `北区` a `borough` (in the locality filter group), `知名町` a `locality`. The three entries are now
   in the default map; only the character-path model emits the tags, so no Latin parse reaches them.
2. **The admin ladder.** `extractGeocodeResult` reads the coordinate off `adminLadderFor`'s rungs, which named no JP
   tag, so a resolved municipality was never read. The JP rungs sit beside their Latin counterparts, `municipality`
   ABOVE `district`: a district resolves without its municipality as a parent more often than not, and the unscoped
   namesake it then picks can be another prefecture's (`千葉県市原市大作` → 921 km). District-first 202, municipality-first 271.
3. **The postal mark.** The normalizer strips `〒` for the SentencePiece tokenizer, where it is byte-fallback OOV. The
   character model was trained with the mark in front of every postcode and misreads the prefecture boundary without it.
   `NormalizeOpts.postalMark` keeps it when the classifier reports `encoder: "char"`, on both the geocode and the
   parse-only paths; the default stays `strip`, so every Latin caller is byte-identical.

The Korean side of the same register was read while looking: 46,178 of 52,894 KR candidate records (87.3%) carry a
Hangul key, stored NFD (conjoining jamo), which a precomposed-range glob misses — the first count read 0.

Shipped, over 2,000 rows (seed 42): **1,823 accepted @15 km (91.2%)**, 963 within 5 km, 26 beyond 50 km. By register:
arabic_chome 62/62, compact_folded 71/72, designator 410/454, native 1,280/1,412. What remains is one class: the
compound municipality. A county-town (`猿島郡五霞町`) or city-ward (`新潟市秋葉区`) value has no single key, the walk
falls to the prefecture centroid (25–52 km), and reducing the value to its trailing unit UNSCOPED loses more than it
gains (251 of 300) because a bare ward resolves a namesake in another city (`神戸市西区` → Fukuoka, 407 km). The design
that arm waits for is the scoped form: the city resolved first, the ward probed as its child. The result's named slots
(`locality`, `region`) also stay null for a JP tree; the coordinate is on the result and the components are in
`components`.

The Latin board did not move: `mwdev_compare` origin/main vs the working tree over the full regression board,
board-routed, reads 0 rows differed (the run id is in the #2164 comment).

**The scoped split (#2175).** The resolver walk now probes a compound municipality as a pair after the whole span
misses: the head (`神戸市`, `猿島郡`) under the node's own parent, then the tail (`西区`, `五霞町`) as the head's child with
the parent fallback OFF, so a namesake outside the head is never admissible; a county head with no key sends the town
under the prefecture the walk already holds. Same 300 rows: 282 accepted (94.0%). Same 2,000 rows: **1,889 (94.5%)**,
1,048 within 5 km, 4 beyond 50 km — all four `和歌山県日高郡美浜町`, where the scoped town probe missed (Wakayama's 美浜町
has no key) and the candidate backend's own region-scope fallback re-admitted Aichi's, 184 km away. The tail probe now
refuses a `regionScopeMiss` answer, and those rows fall to the prefecture centroid (27 km) instead. The remaining
15–19 km rows are municipality-centroid distances (`新潟市秋葉区`, `かすみがうら市`), the board tolerance's edge.

## 4. Artifacts of record

- `$MAILWOMAN_DATA_ROOT/models/v8-cjk-full-s42/{step-024000, served-package/, train_log.csv, jp-board-score.txt, cn-board-score.txt}`
- `$MAILWOMAN_DATA_ROOT/models/v8-cjk-control-s42/step-024000`
- `packages/mailwoman/lib/dev-tools/jp-served-resolve.run.ts` and its 300 / 2,000-row JSON reads on the lab scratchpad.
- `@mailwoman/neural-weights-cjk` 0.0.1 on npm (name reservation: card + vocabulary); `release.config.json` `charWeights.cjk` names the graph for the first functional release.
- Trainer defects this launch found and fixed on main: the char-mode eval guard (5ca3d6ca0) and the label-set CSV columns (6c44386da); the record's probe-read correction (2ed1a0c37).

## 5. What this does not decide

The `ja-jp` / `zh-cn` overlays and the release-list move (operator); the CN numeral boundary; Korean; the FST
autocomplete tier for CJK (#1493, built and staged, swap operator-approved).
