# The CJK weights package and its serving path — proposal

Status: steps 1–5 and the release wiring of step 7 landed on `main` 2026-09-06 (epic #2164; record
`docs/records/evals/2026-09-06-v8-cjk-shared-head.md`); the release-list move and the `ja-jp` / `zh-cn` overlays are
the operator's. Written 2026-09-05 after the operator's distribution decision on #2034 / #1176 ("a consumer can
choose to engage with CJK entirely"), measured on `main` at 1d23433e9.

## 1. The decision this serves

One CJK weights package a consumer installs as a unit. Japanese and Chinese ride one 49-label head
(`stage3-cjk` = `stage3-jp` + `locality_unit`), trained on the char path (#1177 Phase B: the CJK char model is the
second script-routed weights package beside the Latin SentencePiece model). A per-script Chinese model was refused
on supply: 126 labeled rows. Korean joins the same package when its corpus is built (6.17M juso rows are on disk).

## 2. What exists

| Piece                          | State                                                                                                                                                                                                                                     | Where                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| JP model, 47 labels, char path | trained; coordinate-acceptability 0.9928 on the 20,000-row held-out board                                                                                                                                                                 | `$MAILWOMAN_DATA_ROOT/models/v8-jp-full-s42/step-024000`, the 2026-08-05 v8-jp-full 24k record under `docs/records/evals/`    |
| CJK model, 49 labels           | trained (`v8-cjk-full`, app `ap-J0uaLu8mQutAWu4ZdtBNzZ`); 0.9653 on the JP board, 598 of its 664 failures on one held-out hiragana municipality; control run in flight                                                                    | `/data/output-v8-cjk-full-s42/step-024000` on the Modal volume, receipt on #1176                                              |
| Char encoder contract (D1)     | fixed by the trainer: one unit per character, `char_ids (S, W)` with S = 96 units, W = 7 (the unit plus 3 context characters each side), sealed vocabulary as a JSON `{character: id}` map with `<pad>` 0 and `<unk>` 1, code-point order | `corpus-python/src/mailwoman_train/char_tokenizer.py` (`encode_row_units`), `char-vocab-cjk.json` (2,335 entries)             |
| Label set                      | `stage3-cjk`, 49 BIO labels, every `stage3-jp` id unchanged                                                                                                                                                                               | `corpus-python/src/mailwoman_train/labels.py`; TypeScript `ComponentTag` already carries `locality_unit` and the JP fine tags |
| Decoder grammar                | containment for the JP ladder and `locality_unit`                                                                                                                                                                                         | `packages/core/lib/decoder/containment.ts`                                                                                    |
| Script detection               | `CharacterClass` includes `cjk` per token and per input                                                                                                                                                                                   | `packages/query-shape/lib/types.ts`                                                                                           |

## 3. What is missing — the package cannot be exported, resolved, or run today

1. **ONNX export.** `export_onnx.py` wraps the model behind inputs `input_ids` + `attention_mask` (plus the anchor,
   gazetteer and span variants). No wrapper takes `char_ids`. The char model's forward reads `char_ids (B, S, W)`
   and `attention_mask (B, S)` and ignores `input_ids`.
2. **Runtime encoder.** `@mailwoman/neural` has no character encoder: nothing in `packages/neural/lib` mentions
   `char_ids`. The TypeScript side needs `encodeRowUnits` with the same arithmetic as the Python one — a unit per
   character, the window, the vocabulary lookup, `<unk>` for a character outside the vocabulary, S-truncation.
3. **Runtime runner.** `onnx-runner.ts` and `web-onnx-runner.ts` build `input_ids` tensors. A char-mode session feeds
   `char_ids` int64 `(1, S, W)` and `attention_mask` int64 `(1, S)`, reads `logits (1, S, 49)`, and hands the per-unit
   argmax (or Viterbi over the same transition grammar) to the decoder with a character-granular token list.
4. **Weights resolution.** `resolveWeights` fails a package that ships no `tokenizer.model`. A char package ships
   `model.onnx`, `char-vocab.json` and `model-card.json`, and no tokenizer. The card needs an `encoder` field
   (`"sentencepiece"` today, `"char"` here) with the vocabulary sibling and its window constants, and the resolver
   must require the tokenizer only for the SentencePiece encoder.
5. **Routing.** Production routes by locale hint; a CJK query with no hint must reach the CJK package. The rule from
   #1177 Phase B: a Unicode-block histogram in `@mailwoman/query-shape` (the `cjk` character class already exists)
   selects the CJK package when the input is mostly Han, kana or Hangul. The Latin model is untouched.
6. **Evaluation through the served path.** The board scorer in `corpus-python/scripts/score_jp_probe_board.py`
   runs PyTorch. The serving path needs the same read through TypeScript: the JP board rows through `mailwoman
geocode` with the CJK package, coordinate-acceptability at 15 km against the same centroid table. A parity test
   on the encoder (TypeScript `char_ids` equal to Python's for every board row) and on the runner (ONNX logits
   within tolerance of PyTorch logits on a fixed batch) is what makes the served number comparable to the record.

## 4. Package shape

`@mailwoman/neural-weights-cjk` (published, data-only, joins the release list and `SANCTIONED_RELEASE_ABSENCES`'s
arithmetic): `model.onnx`, `char-vocab.json`, `model-card.json` with `encoder: "char"`, `label_set: "stage3-cjk"`,
`char_ctx: 3`, `max_unit_width: 7`, `max_units: 96`, and `files_md5` for both binaries. Locale overlays
(`neural-weights-ja-jp`, `neural-weights-zh-cn`, later `ko-kr`) carry data siblings only, the way the Latin overlays
do over `en-us`. A consumer who wants CJK installs the base plus the overlays for the locales they serve.

## 5. Han unification, priced

Of the CJK corpus's 166 Han characters from the Chinese rows, 102 are code points the Japanese corpus already labels,
and every one of the 102 carries a different majority label in the two languages (一: JP `block` 68%, CN
`locality_unit` 89%). The 24k read split the JP board's municipality failures by whether the name contains a shared
character: names with one read 0.9947 on the shared head against 0.9909 on the JP-only model; names without one read
0.9217 against 0.9997, and 598 of those 598 are `かすみがうら市`. The shared code points did not cost the JP tags;
one held-out hiragana municipality did, and the control run says whether that is the mixture or run variance.

## 6. What this does not decide

- Korean: the corpus build over the juso rows and its label set (`stage3-cjk` plus any KR tags) is its own plan.
- Whether the aux locale head is switched on for CJK (`use_locale_conditioning`); off in every CJK run so far.
- The FST autocomplete tier for CJK (#1493: `fst-{ja-jp,zh-cn,ko-kr}.bin` have no builder).
- The browser bundle: the char runner has to exist in `web-onnx-runner.ts` too, under the same esbuild test the
  Latin path passes.

## 7. Order of work

1. Export: a `char_ids` wrapper in `export_onnx.py`, exported from the CJK (or JP-only) checkpoint, with `verify_parity`
   extended to the char inputs. Receipt: PyTorch vs ONNX logits on 256 board rows.
2. Encoder: `packages/neural/lib/char-encoder.ts`, `encodeRowUnits`, with a fixture test whose expected `char_ids`
   come from the Python encoder over 50 board rows.
3. Card + resolution: the `encoder` field, the vocabulary sibling, the tokenizer requirement scoped to SentencePiece.
4. Runner: char-mode session in `onnx-runner.ts`, then `web-onnx-runner.ts`; the decoder receives character units.
5. Routing: the query-shape rule and the locale-hint route to the CJK package.
6. The served read: the JP board through `mailwoman geocode`, compared against the PyTorch record.
7. Package: `mwops release scaffold-weights-overlay` for the base and the first overlay; release-list arithmetic.

Each step is a PR with its own receipt; step 6 is the one that says the package is real.
