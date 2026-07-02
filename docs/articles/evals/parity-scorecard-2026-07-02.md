# Parity Scorecard — 2026-07-02 (the #885 measurement re-anchor: full re-score of the shipped 5.0.0 line)

Supersedes [2026-06-11](./parity-scorecard-2026-06-11.md) — the first complete per-tag scorecard
since it. Same two lenses, same rules: arena head-to-head is whole-parse-strict (honest,
understates per-tag wins); per-tag F1 is what the campaigns move; real-OOD columns are the truth
for campaign tags. Self-emitted from `scripts/eval/promotion-gate.ts` (the #479 battery:
`per-locale-f1.ts` + `score-affix.ts` + `score-country-homograph.ts` + `de-order-eval.ts` +
`external-arenas.ts`), gate spec `scripts/eval/gates/v4.15.0-boundary.json` — do not hand-edit.

**What this is:** [#885](https://github.com/sister-software/mailwoman/issues/885)'s answer to R1
of the [2026-07-01 trajectory review](https://github.com/sister-software/mailwoman/blob/main/docs/articles/reviews/2026-07-01-claude-trajectory-review.md). Since
the north-star moved to the assembled coordinate, five label-F1 regressions shipped as
"coordinate-invisible" with per-case justification but no periodic backstop. This re-score is the
backstop: it re-measures every v4.4.0-gate slice against the currently shipped bytes and asks
whether the deferred label debt stayed bounded. **Verdict: it did — 17/17 floors PASS
(`verdict.json`), and most of the ledger moved the other way.** Two unsigned drifts surface and
go on the record: `fr.cedex_real` 96.1 → 89.4 (still 19pp above floor) and the unfloored
libpostal clean-canonical arena 36 → 30%.

**Graded artifacts (explicit paths, md5-pinned — never the dev symlink, #259):**

- int8 (the shipped bytes): `model-v193a3-step-80000-int8.onnx`, md5
  `4dec4f460a934949580d8e7b43adae7e` — **verified byte-identical to `model.onnx` inside the
  published `@mailwoman/neural-weights-en-us@5.0.0` npm tarball** (5.0.0 was the acronym-casing
  code major; the weights are the v4.15.0 line unchanged).
- fp32 (delta reference): `model-v193a3-step-80000-fp32.onnx`, md5
  `0ae5ad20313607f31d4dfd3c649cf923` (Modal `output-v193a3-anchor-absorption-s42`).
- tokenizer `v0.6.0-a0`, ship config = anchor + gazetteer lexicon + `conventions:"auto"` +
  span bridge (`requires_bridge`), per the gate spec.

> gate (config `v4.15.0-boundary.json`, which clones the v4.4.0 floors verbatim EXCEPT two
> operator-approved revisions marked `*`): us.postcode ≥ 95\*, fr.postcode ≥ 99.3\*, us.micro ≥
> 81.6, us.locality ≥ 62.2, us.region ≥ 80.1, us.street ≥ 74, street_prefix/suffix ≥ 78/67,
> unit_real ≥ 88, country_homograph ≥ 83.3, fr.house_number ≥ 91, fr.region ≥ 16.2,
> de.native_locality ≥ 83.8, arena.perturb ≥ 71, po_box_real/cedex_real ≥ 70, intersection_real
> ≥ 50.
>
> \* v4.15.0 gate revision (2026-06-25, operator-approved, stated coordinate justification —
> see the spec's `$revision_2026_06_25`): us.postcode 97 → 95, fr.postcode 99.5 → 99.3.

## Lens 2 — per-tag truth (int8 = the shipped bytes, gaz+anchor+conventions+bridge fed)

Columns v4.3.0/v4.4.0 from their ship gates; v5.0.0 is this re-score. Δ is v5.0.0 − v4.4.0 (the
last full baseline).

| tag                | eval                    |  floor | v4.3.0 | v4.4.0 | **v5.0.0** |      Δ | vs floor            |
| ------------------ | ----------------------- | -----: | -----: | -----: | ---------: | -----: | ------------------- |
| street_prefix      | real-affix (32-row)     |     78 |   93.6 |   93.6 |   **98.0** |   +4.4 | PASS                |
| street_suffix      | real-affix (32-row)     |     67 |   96.6 |   96.6 |   **94.9** |   −1.7 | PASS                |
| street_prefix      | NAD-native v2 (193-row) |      — |   92.2 |      — |   **95.7** |      — | (watch)             |
| street_suffix      | NAD-native v2 (193-row) |      — |   90.3 |      — |   **91.6** |      — | (watch)             |
| unit               | real-designators        |     88 |   92.1 |   92.1 |   **97.0** |   +4.9 | PASS                |
| country            | homograph-real          |   83.3 |   85.1 |   89.8 |   **87.5** |   −2.3 | PASS                |
| us.po_box          | po-box-cedex-val        |     70 |      — |   89.1 |   **91.4** |   +2.3 | PASS                |
| fr.cedex           | po-box-cedex-val        |     70 |      — |   96.1 |   **89.4** | −6.7 ⚠ | PASS                |
| us.intersection    | intersection-real       |     50 |      0 |    100 |    **100** |      0 | PASS                |
| us.street (folded) | golden dev              |     74 |   75.5 |   77.9 |   **82.3** |   +4.4 | PASS                |
| us.locality        | golden dev              |   62.2 |   74.4 |   75.7 |   **76.7** |   +1.0 | PASS                |
| us.region          | golden dev              |   80.1 |   89.1 |   90.3 |   **88.6** |   −1.7 | PASS                |
| us.postcode        | golden dev              |   95\* |   97.8 |   98.3 |   **95.0** | −3.3 † | PASS (0.005 margin) |
| us.micro           | golden dev              |   81.6 |   85.1 |   86.1 |   **85.7** |   −0.4 | PASS                |
| fr.postcode        | golden dev              | 99.3\* |   99.7 |   99.6 |   **99.3** | −0.3 † | PASS (0.04 margin)  |
| fr.house_number    | golden dev              |     91 |   97.7 |   97.2 |   **98.1** |   +0.9 | PASS                |
| fr.region          | golden dev              |   16.2 |   16.2 |   25.6 |   **48.4** |  +22.8 | PASS                |
| de.native_locality | de-order (anchor on)    |   83.8 |   90.1 |   91.0 |   **91.1** |   +0.1 | PASS                |
| arena.perturb      | perturb arena           |     71 |     64 |     72 |     **78** |     +6 | PASS                |

† The two documented v4.15.0 gate revisions — the drop is the priced-in #723 trade, not new
drift. Note both now sit **exactly at their revised floors** (us.postcode 95.005/95.0,
fr.postcode 99.341/99.3): the floors have zero slack left, which is the correct design (the floor
IS the shipped level) but means any future hair of postcode loss fails the gate loudly.

⚠ `fr.cedex_real` 96.1 → 89.4 is the one >2pp real-OOD move with no written justification in any
promotion doc between v4.4.0 and v4.15.0 — the exact pattern #885 exists to catch. It remains
19.4pp above its floor, so nothing gates on it today; it is now on the record as accumulated
drift, not silently absorbed. (Plausible source: the multi-locale/AU/anchor retrains between
06-11 and 06-25 rebalancing FR postal-format mass; diagnosing is a follow-up, not this doc's job.)

fp32 ↔ int8: max per-tag delta 0.8pp, on fr.region (cap 1.5) — quantization is not distorting
any floor.

## Lens 1 — capability arenas (int8, TRUE ship config, whole-parse-strict)

| arena                       |   n |  v0 | v4.3.0 | **v5.0.0** |
| --------------------------- | --: | --: | -----: | ---------: |
| libpostal (clean/canonical) |  69 | 29% |    36% |    **30%** |
| perturb (noisy/degraded)    | 398 | 39% |    64% |    **78%** |
| postal (edge formats)       |  38 | 26% |    13% |    **24%** |

The perturb arena — floored at 71 since v4.4.0 because the v4.3.0 dip was a real regression —
clears its floor by 7pp (64 → 78 since v4.3.0). The postal (edge-format) arena nearly doubled
(13 → 24%): the po_box/cedex/intersection shards reach whole-parse strictness too. **The
libpostal (clean/canonical) arena dipped 36 → 30%** — the neural parser now edges v0 there
(30 vs 29) but the whole-parse-strict rate on canonical inputs drifted down across the
multi-locale releases. Unfloored, flagged-not-gated (the same hygiene as the 06-11 perturb note):
if a future release wants to gate it, this is the baseline to floor.

## The assembled coordinate (the north star, for anchor)

Label-F1 above is the drift backstop, not the verdict. The shipped line's coordinate record,
measured this week on the same artifact (see `#884` and the [day eval](https://github.com/sister-software/mailwoman/blob/feat/825-v196-slavic-anchor/docs/articles/evals/2026-07-01-day-825-tokenizer-fix.md)):
US-2k coord p50 3.31 km / resolve 1.000 / region 0.999; CZ-1k resolved-p50 3.29 km / resolve
0.968; PL-1k 2.07 km / 0.985 (the CZ/PL wrong-city defect is #884's fix, promote-pending).

## What this re-score settles (and what it leaves for the operator)

1. **The "coordinate-invisible debt" is bounded and mostly positive.** Of the five deferred
   label regressions, the two postcode floors are priced-in revisions sitting exactly at floor;
   us.region −1.7 and street_suffix −1.7 are inside noise-and-floor margins; and the same period
   bought street +4.4, unit +4.9, prefix +4.4, po_box +2.3, fr.region +22.8, and +6 on the gated
   arena. The pattern (grade the coordinate, document label trades) is vindicated — with two
   uncaptured drifts now recorded: `fr.cedex_real` −6.7 and the libpostal clean-arena −6.
2. **Ledger fate — DECIDED (operator, 2026-07-02): revived, automated.** This re-score is the
   v5.0.0 row in `evals/scores-by-version.json` (appended via the new
   `scripts/eval/ledger-append.ts`; `promotion-gate.ts` prints the pre-filled append command on
   every PASS, so the update no longer depends on discipline). The 4.5–4.16 gap stays
   unpopulated and is documented in the row's notes.
3. **Standing re-score rule — APPROVED (operator, 2026-07-02)** and written into
   `CONTRIBUTING_MODEL_WORK.mdx`: every 5 promotes, or any promote that lowers a gate floor,
   triggers a full re-score published as a dated scorecard. v4.4.0 → v4.15.0 was 11 promotes
   with none; this doc is the debt paid once.

## Provenance

- Battery out-dir: `/mnt/playpen/mailwoman-data/scratch-825/rescore-885/` (`verdict.json`,
  per-leg JSON + md, `provenance.txt` with artifact md5s).
- Runner: `scripts/eval/promotion-gate.ts` @ branch `feat/885-measurement-reanchor`; NAD-native
  v2 row from a standalone `score-affix.ts --file street-affix-real-v2.jsonl` run (not a battery
  leg).
- Known battery defect found during this run:
  [#887](https://github.com/sister-software/mailwoman/issues/887) — `de-order-eval`'s anchor-OFF
  ablation column is broken by the #718 fail-closed scorer gate (empty-anchor idiom refused).
  The anchor-ON leg that grades the `de.native_locality` floor is unaffected.
