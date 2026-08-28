# v4.2.0-base-anchor-v2 (Run B, 60k) — scored against its pre-registered sheet (2026-08-05)

**Status:** measurement only. No promotion decision is taken or implied here.

**Recipe (the authority):** `corpus-python/src/mailwoman_train/configs/v4.2.0-base-anchor-v2.yaml`.
**Artifacts:** `$MAILWOMAN_DATA_ROOT/models/v420-base-anchor-v2-s42/` — `step-060000/` (pytorch_model.bin,
config.json, `fisher-diag-v1.npz` + `fisher-diag-v1.json`, training_state.json), `model.onnx` (fp32, 157 MB),
`model-int8.onnx` (39.4 MB). Tokenizer `models/tokenizer/v0.9.0-multisplice/tokenizer.model`.
**Baseline everywhere below:** `model-v401-base-step-060000-int8.onnx` — the v4.0.1 base, which is what
`link-dev-weights.ts` puts in `neural-weights-en-us/model.onnx` on this worktree. Every baseline number
was re-measured here on the same instrument, not quoted from a prior record, except where a prior
record's number is named explicitly as a replication target.

## The instrument

Production runtime pipeline (`createRuntimePipeline` with the classifier only — what `mailwoman parse`
builds with no `--resolve` and no `MAILWOMAN_WOF_DB`), three registers per row (as-written / lowercase /
UPPERCASE), exact match on the tag's concatenated span folded to uppercase with whitespace stripped.
This is `docs/records/evals/2026-08-05-en-gb-anchor-off.md`'s instrument, re-implemented in
`mailwoman/dev-tools/score-anchor-v2-boards.run.ts`.

**Instrument validated by replication.** Run against the shipped `neural-weights-en-gb` overlay (v4.0.1
model, anchor OFF), it reproduces that record's anchor-OFF column exactly: postcode **318/318**,
`dependent_locality` **207/207**, comma-stripped `dependent_locality` **198/207**, per register
106/106/106 and 69/69/69. Numbers below are therefore comparable to it line for line.

## Assembly

The candidate is graded as a package-shaped weights dir (`weightsCacheRoot`), never via
`--model`/`--tokenizer`, so every sibling channel is fed (the #718 zero-fill trap).

**The GB anchor bin had to be built, and the shipped command cannot build it.**
`mailwoman gazetteer postcode-binary --locale GB:postalcode-gb-codepoint.db` writes a valid, EMPTY
binary and reports success:

```
GB: 0 codes (0 placed) → postcode-gb.bin (0.00 MB)
```

Its GB branch (`aggregateGbOutward` → `gbOutward`) derives the outward district by splitting `name` on a
SPACE, because it was written against `postalcode-gb.db`, whose `name` carries the spaced display form.
The licence-clean Code-Point Open shard stores `name` already space-stripped (`AB101AB`), so the split
returns null on all 1,746,976 rows. It also aggregates to outward codes only, which is the wrong
granularity for a model trained against `pilot-anchor-lookup-v2` (unit keys with unit centroids).

`mailwoman/dev-tools/build-gb-anchor-bin.run.ts` builds the train-faithful artifact instead — a verbatim
mirror of the training lookup's GB half (`gazetteer-pipeline/anchor-lookup.ts::loadGBCodePoint` +
`addGBOutwardKeys`):

```
GB: 1,749,839 keys (1,746,976 units + 2,863 outward districts, 0 rows skipped) → postcode-gb.bin (20.03 MB)
```

Those three counts are the recipe header's GB line to the digit.

**The channel fires.** `scripts/probe-gb-anchor-fire.ts` replays `buildAnchorFeatures`'s SHAPED
recognizer over the case-normalized text (what the anchor actually sees, `normalizeInputCase` being
default-ON):

```
anchor lookup keys: 1,749,839
asis   fired 106/120 (unit 106 · outward-fallback 0) · no shaped span 14 · span-but-no-key 0
lower  fired 106/120 (unit 106 · outward-fallback 0) · no shaped span 14 · span-but-no-key 0
upper  fired 106/120 (unit 106 · outward-fallback 0) · no shaped span 14 · span-but-no-key 0
```

106/120 is every row on the board carrying a postcode, and every hit is a UNIT key — the outward
fallback is never needed and no shaped span misses the lookup. Register-flat, but only because of
`normalizeInputCase`: on the RAW text the shaped recognizer fires 0/120 on lowercase, because the
alphanumeric shape patterns require uppercase letters by design. Anything that bypasses case
normalization loses the GB anchor entirely.

**Card.** Assembled next to the model, declaring the recipe's exact trained channel set — `anchor`
(`required: true`, `span_mode: "shaped"` — the recipe's SHIP OBLIGATION), `gazetteer`, `country`,
`conventions` (`mode: "gb"`, matching the en-gb overlay the baseline board used), `bridge: false`,
`suppress_gazetteer_near_postcode: true`, `street_type` (dim 1), `locality_surface` (dim 2), plus the
33-label vocab. The loader accepted it; `createScorer`'s fail-closed path never fired, and the anchor-OFF
arm produced its one loud warning as designed.

## Gate table

| #   | Sheet line                                                 | Bar                              | Measured                                                                                 | Verdict                                   |
| --- | ---------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| 2   | gb-golden exact `postcode`, 3 registers, anchor FED        | ≥ 318/318                        | **318/318** (106·106·106)                                                                | **PASS**                                  |
| 2b  | gb-golden exact `dependent_locality`, 3 registers          | hold 207/207                     | **207/207** (69·69·69)                                                                   | **PASS**                                  |
| 2c  | same, comma-STRIPPED                                       | (baseline 198/207)               | **207/207** — recovers all 9                                                             | **PASS, +9**                              |
| 3   | US parity, 100 rows × 3                                    | no regression                    | 567/777 → **608/777**                                                                    | **PASS** (one tag down, see below)        |
| 3b  | FR parity, 46 rows × 3                                     | no regression                    | 151/267 → **158/267**                                                                    | **PASS** (no tag down)                    |
| 4   | Anchor-ablation delta on gb-golden                         | ≠ 0                              | **0/318, 0/207, 0/207 on score** — but 6/567 parses differ                               | **INCONCLUSIVE ON THE BOARD** (see below) |
| 5   | Fisher sanity                                              | loads, finite, nonzero head mass | 106 entries, 39,261,743 scalars = sidecar `param_count`, 0 non-finite, all heads nonzero | **PASS**                                  |
| —   | int8 ↔ fp32 delta                                          | 0                                | **byte-identical** span serialization, sha256 `92fdb3fc…`, 567 parses                    | **PASS**                                  |
| G1  | fragment bars, P0 grid with `--lexicon`/`--street-lexicon` | —                                | **HARNESS ABSENT** (see below)                                                           | **NOT SCORED**                            |
| G2  | ablation vs SHIPPED 6.7.0 same-grader reference            | —                                | **REFERENCE ABSENT** (see below)                                                         | **NOT SCORED**                            |
| G3  | invariance, zero new classes                               | 0 new                            | **4 new violations** (2 DEGRADED, 2 LOST)                                                | **FAIL**                                  |
| G4  | gauntlet × 3 layers                                        | —                                | regression 88/90 → **84/90**; metamorphic PASS; held-out **PASS, z=2.85**                | **MIXED**                                 |
| G5  | golden ABLATED, match-or-beat 6.7.0, zero waivers          | —                                | **FIXTURES ABSENT ON THIS HOST**                                                         | **NOT SCORED**                            |
| G6  | canary zero-flip, formatted mode                           | —                                | **HARNESS NOT FOUND**                                                                    | **NOT SCORED**                            |
| G7  | full pre-ship gauntlet on the dev-linked flip              | —                                | = G4 (same instrument, run on the linked worktree)                                       | **MIXED**                                 |
| G8  | DE golden + DE fragment leg                                | —                                | **FIXTURES ABSENT** (golden); DE fragment board never built                              | **NOT SCORED**                            |

## Anchor ablation — the delta is zero because the board is at ceiling

Both arms of the ablation (same model, `postcode-gb.bin` present vs absent) score **318/318, 207/207,
207/207**. The sheet reads a zero delta as "slot 4 still took no gradient". That inference does not hold
here, and two independent measurements say so.

**The parses are not identical.** Full span serialization over all 567 parses: anchor ON `92fdb3fc…`,
anchor OFF `494f29e4…`. Six parses differ — two rows × three registers, both on the comma-free leg, and
the ON arm is the better read on both:

```
Piran Heights, Upton, Bude, EX23 0LY
  ON   dependent_locality=Upton; locality=Bude;              street=Piran; street_suffix=Heights
  OFF  dependent_locality=Upton; locality=Piran Heights|Bude
8 Simons Orchard, Ashby Parva, Lutterworth, LE17 5JE
  ON   street=Simons; street_suffix=Orchard
  OFF  street=Simons Orchard
```

**The Fisher artifact determines the result directly.** The diagonal empirical Fisher over the final 2,000 steps is
per-parameter squared-gradient mass, so `anchor_projection.weight` column _j_ answers "did LOCALE_ORDER
slot _j_ take gradient". The within-run control is exact: the widened lookup covers DE/FR/US/GB/NL/ES/IT,
so CA (slot 3) and JP (slot 5) could not have taken any.

```
slot  feature   fisher-col-sum   share
   0  US         4.365462e-05   22.49%
   1  FR         2.916441e-05   15.03%
   2  DE         1.151791e-05    5.93%
   3  CA         0.000000e+00    0.00%   <- control
   4  GB         2.189547e-05   11.28%
   5  JP         0.000000e+00    0.00%   <- control
   6  ES         1.277138e-05    6.58%
   7  IT         5.852816e-06    3.02%
   8  NL         2.179433e-06    1.12%
   9  lat        5.786385e-05   29.81%
  10  lon        9.194220e-06    4.74%
```

GB carries 11.28% of the projection's Fisher mass, third among the locale slots and above DE/ES/IT/NL.
The two untouched slots are EXACTLY zero, which is what proves the instrument discriminates. **Slot 4
took gradient. The run did what it exists to do.**

Column L2 norms are NOT a usable instrument here and were checked first: every column of
`anchor_projection.weight` sits at 1.33–1.44 against a Xavier-uniform init expectation of 1.395,
including the two zero-Fisher controls. The projection barely moves in magnitude; only the Fisher
separates the slots.

What the sheet actually wanted — evidence the channel is not inert — is present. What it cannot get from
this board is a SCORE delta, because the postcode board saturated at 106/106 per register in both arms.
A board that can measure the anchor's contribution on this model does not exist yet.

## US / FR parity

Ad-hoc boards (100 US / 46 FR rows of `parity-corpus.jsonl` × 3 registers, per-gold-tag exact match,
`street` compared as the assembled family the way `parity-corpus.ts`'s floor does):

| tag             | US baseline | US candidate | FR baseline | FR candidate |
| --------------- | ----------- | ------------ | ----------- | ------------ |
| country         | 8/18        | 8/18         | 21/21       | 21/21        |
| house_number    | 94/120      | **111/120**  | 24/24       | 24/24        |
| locality        | 119/165     | **125/165**  | 30/87       | **34/87**    |
| postcode        | 57/57       | 57/57        | 12/12       | 12/12        |
| region          | 123/144     | **120/144**  | —           | —            |
| street (family) | 51→163/225  | **184/225**  | 64/96       | **67/96**    |
| unit            | 0/21        | 0/21         | —           | —            |
| venue           | 3/27        | 3/27         | 0/27        | 0/27         |
| **all tags**    | **567/777** | **608/777**  | **151/267** | **158/267**  |

One tag down: US `region`, 123 → 120.

The standing gate (`mailwoman eval parity`, 321 live fixtures, all countries) agrees and is the number to
quote:

| floor        | baseline | candidate  | bar                      |
| ------------ | -------- | ---------- | ------------------------ |
| house_number | 0.8288   | **0.9315** | 0.97 — FAIL in both arms |
| postcode     | 0.9722   | 0.9722     | 0.97 — PASS in both arms |
| street       | 0.6554   | **0.7116** | 0.90 — FAIL in both arms |

Both floors that fail were already failing on v4.0.1 on this harness; the candidate is strictly better on
both. Precision (informational): postcode spurious 15/249 → **9/249**; street spurious 6/54 → **12/54**;
house_number 5/175 → 6/175.

Per-country full-agreement: US 50/99 → 52/99, FR 23/43 → 24/43, GB 1/3 → 3/3, DE 9/13 unchanged, NL
13/22 unchanged, PT 2/8 unchanged.

## FR fragment board (`mailwoman eval fragment-board`, 2,800 BAN fixtures)

Not G1 — this is the standing FR board, run because G1's harness does not exist. Reported as the nearest
existing instrument, clearly not a substitute for the pre-registered bars.

| class                | baseline  | candidate |
| -------------------- | --------- | --------- |
| admin-street-homonym | 0.960     | **0.975** |
| alnum-housenumber    | 0.953     | **0.965** |
| bare-locality        | 0.985     | 0.983     |
| bare-street          | 0.958     | **0.998** |
| date-name            | 0.945     | **0.963** |
| street-housenumber   | 0.920     | **0.960** |
| street-particle      | 0.955     | **0.995** |
| **OVERALL**          | **0.954** | **0.977** |

`bare-locality` (the hallucination class) moves −0.002, one row, well inside its CI.

## Gauntlet (G4 / G7)

Same worktree, same resolver, candidate via `--weights-cache`; baseline is the shipped-default self-check.

```
baseline   regression 88/90 gated, 98 tracked
candidate  regression 84/90 gated, 91 tracked
```

Shared gated failures (2): `de-r9-nippes-koeln`, `us-subvenue-googleplex-building`. **Four NEW gated
failures, and they are one family — Caribbean / US-territory:**

```
✗ pr-op3-venezuela-san-juan       "Venezuela, San Juan, 00926, Puerto Rico"        coord 9.72km off (tol 500m)
✗ vg-op3-road-town                "Road Town, British Virgin Islands"              coord 313.93km off; locality "British Virgin Islands" ≠ "Road Town"
✗ vi-op3-chocolate-hole-cruz-bay  "Chocolate Hole Cruz Bay, St John 00830, USVI"   coord 5.70km off (tol 2000m)
✗ pr-op3-playa-sardinas-culebra   "Playa Sardinas II, Culebra, Puerto Rico"        country "null" ≠ "Puerto Rico"
```

Against that, the tracked (non-blocking) population drops 98 → 91: all five `si-sentinel` postcode rows
clear, and a long tail of `gb-venue-*` / `gb-op2-*` rows now pass outright.

Metamorphic: **PASS** with 3 tracked xfails, and three previously-known xfails now pass outright
(`comma-drop|181 Rue du Chevaleret, Paris`, and both Amsterdam `Damrak 1, 1012 LG` transforms).

Held-out fresh draw (FR/BAN, n=300), candidate vs production: **PASS**, and by a margin —

```
  tolerance     production   candidate
  ≤0.1  km        279          297
  ≤0.5  km        280          297
  ≤5    km        292          300
  resolved        297          300
  z (candidate − production) @ ≤5km: 2.85
```

Combined verdict FAIL in BOTH arms, driven by the regression layer in both.

## Invariance (G3) — FAIL

`mailwoman eval invariance` in regression mode (candidate vs the v4.0.1 baseline, both as package dirs),
23 rows / 156 pairs:

```
INVARIANT 142   DEGRADED 8 (2 new)   LOST 6 (2 new)
```

Four NEW violations against a `maxDegraded` of 0:

```
✗ LOST     [comma-drop] fr-montmartre   "123 Rue Montmartre, Paris"  street: "Montmartre" → "Montmartre Paris"   [was INVARIANT]
✗ LOST     [comma-drop] gb-quoted-venue  street: "The Grange" → "∅"                                              [was DEGRADED]
~ DEGRADED [case-fold]  gb-quoted-venue  dependent_locality: "Fishburn" → "∅"; locality: "∅" → "Fishburn"        [was INVARIANT]
~ DEGRADED [lowercase]  gb-quoted-venue  dependent_locality: "Fishburn" → "∅"; locality: "∅" → "Fishburn"        [was INVARIANT]
```

## Fisher sanity

```
fisher entries:       106
total scalar entries: 39,261,743   (= sidecar param_count, exact match)
non-finite entries:   0
all-zero tensors:     3 / 106  — crf.transitions, crf.start_transitions, crf.end_transitions
classifier.weight        sum 4.621743e-03   max 1.285758e-04
classifier.bias          sum 1.557351e-05   max 5.327054e-06
span_boundary_head.weight sum 1.724299e-05  max 2.164875e-06
locale_head.weight       sum 1.324248e-03   max 1.260073e-05
```

Sidecar: `count_batches 2000`, `captured_at_step 60000`, `window_last_n_steps 2000`, seed 42, corpus
`v0.17.0-batch`, `output_dir /data/output-v420-base-anchor-v2-s42/checkpoints` — provenance complete.
The three all-zero tensors are the CRF transitions, which is expected and not a defect: the recipe sets
`crf_loss_weight: 0.0`, so they take no gradient by construction (CE-only; the CRF is inference-time
structure). Every head carries nonzero mass.

## Assembly gaps found

1. **`mailwoman gazetteer postcode-binary` cannot build a GB bin from the licence-clean shard, and fails
   silently.** Space-split outward derivation vs a space-stripped `name` column → 0 codes, exit 0, a valid
   empty PCB1 written. Also outward-only, which is the wrong granularity for an anchor-v2-trained model.
2. **`resolveWeights` hard-codes `locality-surface-lexicon-v6.json`.** Both v4.0.1 and v4.2.0 train against
   **v7**. The dev-link puts v6 in `neural-weights-en-us/`, and the en-us card declares v6. So the shipped
   configuration feeds a v7-trained model the v6 lexicon. The candidate arms here stage the **v7 content
   under the v6 filename** — train-faithful, but the filename is a lie the loader forces. A version-agnostic
   probe (or a `requires.locality_surface.lexicon`-driven resolve) would close it.
3. **`neural-weights-en-gb` links no evidence-bundle lexicons.** Its `link-dev-weights.ts` stages
   `pair-index-gb.bin` and the FSTs but not `street-type-lexicon-v3.json` / the locality-surface lexicon,
   and its card omits `requires.street_type` / `requires.locality_surface` even though its `$comment` says
   the block is a verbatim copy of the base card's. GB parses therefore run those two channels OFF on a
   model trained with them. The baseline board above inherits that posture (which is why it is the correct
   comparison instrument), but it is a real divergence from the base card.
4. **G1's harness does not exist.** The sheet names a P0 grid taking `--lexicon` / `--street-lexicon`.
   Neither `mailwoman eval fragment-board` nor `eval fragment-dev` carries those flags, and nothing else in
   `mailwoman/commands/eval/` does. The FR fragment board above is the nearest existing instrument, not a
   substitute.
5. **G2/G5/G8 have no fixtures on this host.** `$MAILWOMAN_DATA_ROOT/eval/golden` and `.../eval/splits` are
   both EMPTY directories; the golden set the recipe points at (`/data/eval/golden/v0.1.2`) lives on the
   Modal volume. `mailwoman eval gate` cannot run its battery here. The "SHIPPED 6.7.0 same-grader
   reference" G2 and G5 compare against also has no artifact in `mailwoman/eval-harness/gates/` (which
   carries `v6.0.0-shipped-baseline.json` and `v7.0.0-base.json`, not 6.7.0).
6. **G6's canary harness was not found** under any name in `mailwoman/commands/eval/` or
   `mailwoman/eval-harness/`.
7. **`span_mode: "shaped"` is uppercase-only, and survives only because of `normalizeInputCase`.** The
   alphanumeric shape patterns in `neural/postcode-repair.ts` require uppercase letters deliberately. On raw
   lowercase text the GB anchor fires 0/120. Any serving path that skips #690 case normalization — or any
   future `normalizeCase: false` caller — silently loses the whole channel for GB and NL. Worth an assertion
   rather than a docstring.
8. **`@mailwoman/neural` exports no `./postcode-repair` or `./case-normalize` subpath**, so the fire probe
   lives at `scripts/probe-gb-anchor-fire.ts` (outside any tsconfig project) rather than in
   `mailwoman/dev-tools/`, where a cross-project relative import trips `TS2878`.

## Reproduce

```bash
node mailwoman/dev-tools/build-gb-anchor-bin.run.ts --out <dir>
node scripts/probe-gb-anchor-fire.ts --bin <dir>/postcode-gb.bin
node mailwoman/dev-tools/score-anchor-v2-boards.run.ts --board gb --locale en-gb --cache-root <cache> \
  --dump-spans <spans.tsv>
node mailwoman/dev-tools/score-anchor-v2-boards.run.ts --board us --locale en-us --cache-root <cache>
node mailwoman/dev-tools/score-anchor-v2-boards.run.ts --board fr --locale fr-fr --cache-root <cache>
mailwoman eval parity        --weights-cache <cache>
mailwoman eval fragment-board --weights-cache <cache>
mailwoman eval gauntlet       --weights-cache <cache>
mailwoman eval invariance     --weights-cache <cache> --baseline-weights-cache <repo-root>
```

`<cache>` is a dir laid out as `<cache>/node_modules/@mailwoman/neural-weights-<locale>/` holding
`model.onnx`, `tokenizer.model`, the assembled `model-card.json`, `postcode-<cc>.bin`,
`anchor-lexicon-v1.json`, `country-surface-lexicon-v1.json`, `street-type-lexicon-v3.json`, the
locality-surface lexicon (v7 content, v6 filename), `pair-index-<cc>.bin`, `fst-<locale>.bin`, and
`fst-street-morphology.bin`.
