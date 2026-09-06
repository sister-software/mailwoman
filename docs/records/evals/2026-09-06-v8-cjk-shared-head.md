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

## 4. Artifacts of record

- `$MAILWOMAN_DATA_ROOT/models/v8-cjk-full-s42/{step-024000, served-package/, train_log.csv, jp-board-score.txt, cn-board-score.txt}`
- `$MAILWOMAN_DATA_ROOT/models/v8-cjk-control-s42/step-024000`
- `@mailwoman/neural-weights-cjk` 0.0.1 on npm (name reservation: card + vocabulary); `release.config.json` `charWeights.cjk` names the graph for the first functional release.
- Trainer defects this launch found and fixed on main: the char-mode eval guard (5ca3d6ca0) and the label-set CSV columns (6c44386da); the record's probe-read correction (2ed1a0c37).

## 5. What this does not decide

The `ja-jp` / `zh-cn` overlays and the release-list move (operator); the CN numeral boundary; Korean; the FST
autocomplete tier for CJK (#1493, built and staged, swap operator-approved).
