# Mask-regression check re-baselined to the formatted input mode (#2048)

**Date:** 2026-09-05 · **Model:** `@mailwoman/neural-weights-en-us` 9.1.0 (the installed package: `model.onnx`, `tokenizer.model`, `model-card.json`) · **Check:** `mailwoman eval mask-regression`, threshold 2.0pp, 2 locales × 16 tags · **Issue:** #2048

## What changed

The capability-manifest generator and the mask-regression check score the same certification rows through the shared `scoreConventionsMaskOffOn`, and until this change they differed in one parse option: the generator parsed with `inputMode: "formatted"` and the check parsed in the bare-library default (`fragmented`). The rows are formatted postal addresses; on those inputs the production pipeline derives `formatted` and runs the evidence-bundle channels OFF as a declared ablation. The check therefore graded a path production never takes on these rows. Operator decision (2026-09-05): both callers grade `formatted`; the manifest's published numbers are unchanged, the check's history breaks here.

**The model did not change.** Every difference in the table below is the parse mode. Numbers before this row grade `fragmented`; numbers from this row on grade `formatted`.

## Per-tag F1, mask OFF, both modes

| Locale | Tag                  | mask-OFF F1, fragmented | mask-OFF F1, formatted | Δ mask-OFF (fmt − frag) | mask-OFF − mask-ON, fragmented | mask-OFF − mask-ON, formatted |
| ------ | -------------------- | ----------------------: | ---------------------: | ----------------------: | -----------------------------: | ----------------------------: |
| us     | `street_prefix`      |                     0.9 |                    0.9 |                    +0.0 |                            0.0 |                           0.0 |
| us     | `street`             |                    26.9 |                   28.1 |                    +1.2 |                            0.0 |                           0.0 |
| us     | `street_suffix`      |                     0.3 |                    0.3 |                    +0.0 |                            0.0 |                           0.0 |
| us     | `house_number`       |                    97.0 |                   97.0 |                    +0.0 |                            0.0 |                           0.0 |
| us     | `locality`           |                    88.0 |                   87.4 |                    -0.6 |                            0.0 |                           0.0 |
| us     | `region`             |                    92.5 |                   92.1 |                    -0.4 |                            0.0 |                           0.0 |
| us     | `postcode`           |                    97.8 |                   97.7 |                    -0.1 |                            0.0 |                           0.0 |
| us     | `country`            |                    59.5 |                   60.3 |                    +0.8 |                            0.0 |                           0.0 |
| us     | `unit`               |                    10.8 |                   11.8 |                    +1.0 |                            0.0 |                           0.0 |
| us     | `intersection_a`     |                   100.0 |                  100.0 |                    +0.0 |                            0.0 |                           0.0 |
| us     | `intersection_b`     |                   100.0 |                  100.0 |                    +0.0 |                            0.0 |                           0.0 |
| us     | `po_box`             |                    71.7 |                   71.7 |                    +0.0 |                            0.0 |                           0.0 |
| us     | `venue`              |                    96.8 |                   96.9 |                    +0.1 |                            0.0 |                           0.0 |
| us     | `dependent_locality` |                     0.0 |                    0.0 |                    +0.0 |                            0.0 |                           0.0 |
| fr     | `street_prefix`      |                    90.0 |                   90.0 |                    +0.0 |                            0.0 |                           0.0 |
| fr     | `street`             |                    81.8 |                   81.8 |                    +0.0 |                            0.0 |                           0.0 |
| fr     | `house_number`       |                   100.0 |                  100.0 |                    +0.0 |                            0.0 |                           0.0 |
| fr     | `locality`           |                   100.0 |                  100.0 |                    +0.0 |                            0.0 |                           0.0 |
| fr     | `postcode`           |                   100.0 |                  100.0 |                    +0.0 |                            0.0 |                           0.0 |

In-scope cells whose mask-OFF F1 moved: 7 of 19, all US, every move under 1.3pp (`street` +1.2, `unit` +1.0, `country` +0.8, `locality` −0.6, `region` −0.4, `postcode` −0.1, `venue` +0.1). The mask-OFF − mask-ON delta is 0.0 on every cell in both modes: the conventions mask costs nothing on these rows under either mode, so the 2pp lock passes before and after. The FR cells are identical in both modes.

## Verdict

`✓ PASS — no tag regresses more than 2.0pp under the conventions mask (2 locale(s), 16 tags each)` in both modes.

No ledger row carries this re-baseline. `evals/scores-by-version.json` is one row per model version and its metrics are the battery's per-locale F1 cells, not the mask-off/mask-on table; the current spec (`v9.0.0-base`) declares no `requires_conventions`, so the promotion battery run on the same installed weights (PASS, out-dir kept in the session scratchpad) skipped the mask check entirely. The mask numbers live here and in every future promotion out-dir's `mask-regression.json` whose spec declares a mask.

## Receipts

- Baseline run (fragmented, compiled tree at 3f8b5212a): `mask-before.json` in the session scratchpad; the same numbers are what every earlier promotion out-dir's `mask-regression.json` carries.
- Re-baselined run (formatted): the promotion out-dir's `mask-regression.json` from the run above.
- Code: `packages/mailwoman/lib/eval-harness/mask-regression.ts` passes `{ inputMode: "formatted" }`; `MaskOffOnOptions.inputMode` in `per-tag-f1.ts` documents both callers.

https://claude.ai/code/session_019mAe7AK8EQYwGmnJcctW2N
