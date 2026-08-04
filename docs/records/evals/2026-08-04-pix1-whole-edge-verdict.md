# PIX1 whole-edge — bar verdicts (2026-08-04)

Grades the four bars in
[`docs/superpowers/plans/2026-08-04-pix1-whole-edge-preregistration.md`](../../superpowers/plans/2026-08-04-pix1-whole-edge-preregistration.md).
Defect record: [`2026-08-04-pix1-parent-assumption.md`](./2026-08-04-pix1-parent-assumption.md).

Model: shipped en-US weights, `model-v401-base-step-060000-int8.onnx` (md5 `c968c24a`). Gazetteer: the
2026-08-04 admin + candidate rebuild. Indexes: the `link-dev-weights` artifacts built the same day —
`pair-index-us.bin` (47,878 pairs, δ=10, β=5), `-gb` (30,825), `-nz` (3,134), `-fr` (199,282).

**Status: all four bars clear. NOT shipped — `parentDelta` stays `undefined` by default.** The ship
decision, like R5's, is the operator's.

## B-1 — byte-stability where the set is unconstraining

> Bar: **byte-identical output on every case whose fired child tag has ≥2 allowed parents.** A single
> diff falsifies the construction argument above and the design goes back for a per-tag δ.

**VACUOUS on the preregistered instrument.** Every SHIPPED pair index asserts `dependent_locality`
and nothing else, and `WESTERN_PARENT_OF.dependent_locality` is `["locality"]` — exactly one allowed
parent. So the bar's population is empty by construction:

| board                      | rows | fired tags                 | ≥2-allowed-parents rows |
| -------------------------- | ---: | -------------------------- | ----------------------: |
| gauntlet regression corpus |  130 | `dependent_locality` × 1   |                   **0** |
| `gb-golden.jsonl`          |  120 | `dependent_locality` × 69  |                   **0** |
| `nz-suburb-golden.jsonl`   |  300 | `dependent_locality` × 246 |                   **0** |

That is a real finding, not a technicality: the construction argument the design rests on is not
reachable by any instrument built from shipped artifacts. The only pair indexes in the tree whose
child tag has ≥2 allowed parents are the hierarchy-probe artifacts
(`pair-index-locality-region-{us,fr}.bin`, child tag `locality`, allowed parents
`{subregion, region, country}`).

**Supplementary, beyond the preregistered instrument.** A 240-row `<city>, <state>` board drawn from
`pair-index-locality-region-us.bin`'s own entries, in three shapes (bare / with street / with street
and ZIP), child δ proxied to 10 so the child side is representative:

| parentDelta | unconstrained rows | byte-identical |
| ----------: | -----------------: | -------------: |
|           8 |                160 |    **160/160** |
|          20 |                160 |    **160/160** |

Byte-identical at 2.5× the shipped child δ. The write is not silently absent — the unit tests assert
`+δ` lands on all three allowed parent labels of a `locality` child, and the gauntlet ON/OFF diff
below shows the mechanism moving real cases.

**Verdict: PASS, with the vacuity of the preregistered instrument on the record.**

## B-2 — the positive side

> Bar: **≥70% whole-edge-correct** … Report the child-only rate beside it; if the parent bias does
> not move it, the mechanism is not doing what this document claims.

Two boards, both `<neighbourhood>, <city>, <state>`, no postcode, held out from R5's graded 60 and
drawn on a fresh seed. Gold from the admin gazetteer's own ancestry.

**General board (120 rows).** State surface alternates full name / USPS abbreviation.

| parentDelta | whole-edge      | child-only      |
| ----------: | --------------- | --------------- |
|         OFF | 118/120 (98.3%) | 118/120 (98.3%) |
|        4–20 | 118/120 (98.3%) | 118/120 (98.3%) |

**The parent bias moves nothing here**, and the eval record predicted exactly that: on an ordinary
`<neighbourhood>, <city>, <state>` row the parent already reads `locality` because nothing pulls it
elsewhere. The defect lives in the tail.

**Sub-board, 60 rows, city surface is also a US state name** — the `brooklyn, new york, ny` class:

| parentDelta | whole-edge    | child-only    |
| ----------: | ------------- | ------------- |
|         OFF | 11/60 (18.3%) | 59/60 (98.3%) |
|           2 | 27/60 (45.0%) | 59/60 (98.3%) |
|           4 | 50/60 (83.3%) | 59/60 (98.3%) |
|           5 | 59/60 (98.3%) | 59/60 (98.3%) |
|        6–20 | 59/60 (98.3%) | 59/60 (98.3%) |

Child-only is flat across the whole sweep; only the parent moves. That is the mechanism doing what
the document claims, and it is worth naming that the general board would have hidden it.

**Verdict: PASS** (≥70% on both boards at parentDelta ≥ 4).

## B-3 — the confound the parent bias creates

> Bar: **≤2% parent-tag false positives**, the shipped GB floor B-R5.2 used for the child.

Graded as the FPs the parent bias CREATES — a row correct with the bias off and wrong with it on.
A row already wrong at OFF is a pre-existing child-side defect, not this bar's business.

**Broad homonym board (120 rows,** including the five named rows: `Buffalo, New York`,
`Springfield, Washington`, `Vancouver, Washington`, `Kansas City, Kansas`,
`Oklahoma City, Oklahoma`**): the pair prior fires on 0/120.** 0.00% FP, and vacuously so — nothing
to amplify.

**Amplification stratum (56 rows, 56/56 fire).** Built from index entries whose parent fold IS a US
state name and whose child fold also names a locality in that same state, so `<child>, <state>` reads
as city-in-state and the child bias fires anyway:

| parentDelta | parent-bias FP   |
| ----------: | ---------------- |
|        4–20 | **0/56 (0.00%)** |

Disclosure: this stratum is 56/56 WRONG at parentDelta=OFF. `Arlington, New York` already parses as
`dependent_locality=Arlington, locality=New York` on the shipped child-only mechanism — R5's known
residual FP class. The parent bias adds nothing to it at any δ through 20.

**Verdict: PASS** (0.00% vs ≤2%).

## B-4 — parent δ is calibrated, not inherited

> Bar: **a δ exists that clears B-2 and B-3 simultaneously**.

parentDelta ∈ [5, 20] clears B-2 (98.3% ≥ 70% on both boards) and B-3 (0.00% ≤ 2%) at once. δ=4
clears both too (83.3% / 0.00%); δ=2 fails B-2's sub-board at 45.0%. **δ=5 is the smallest that
saturates B-2**, and the curve is flat from there to 20 — the choice is not knife-edge.

**Verdict: PASS.**

## D-rule

No regression on either tier-1 locale, and two improvements elsewhere. Whole-edge on each shipped
board, parentDelta 4/6/8/20 all identical:

| board                     | rows | OFF             | ON                 |
| ------------------------- | ---: | --------------- | ------------------ |
| `fr-lieudit-golden.jsonl` |   80 | 77/80 (96.3%)   | 77/80 (96.3%)      |
| `gb-golden.jsonl`         |   69 | 66/69 (95.7%)   | **69/69 (100%)**   |
| `nz-suburb-golden.jsonl`  |  246 | 230/246 (93.5%) | **246/246 (100%)** |

(The NZ leg runs anchor-OFF — `neural-weights-en-nz` ships no `postcode-nz.bin` — so both legs are
equally degraded and the comparison holds, but the absolute numbers are not the shipped NZ path.)

Full gauntlet, `MAILWOMAN_PAIR_PARENT_DELTA` unset vs `=6`, everything else identical:

```
5c5
< === Gauntlet · regression (54/55 gated cases pass, 61 tracked) ===
> === Gauntlet · regression (54/55 gated cases pass, 60 tracked) ===
29d28
<   ~ gb-op2-nine-elms-bare [improvement_target]: locality "Nine Elms" ≠ "London"
69a69,71
> ⚠ tracked cases that now PASS — promote to status=pass:
>   + gb-op2-nine-elms-bare [improvement_target] now PASSES — promote to status=pass
```

Same gated verdict, one tracked improvement_target promoted, zero newly-failing cases. The `54/55`
is the pre-existing `si-sentinel-apace` failure, present on both legs and on `main`.

## The defect the bars caught

The first implementation biased the parent's WHOLE comma-delimited segment. #1308 strips a same-field
postcode from the probe KEY but leaves `pieceIndices` spanning the segment, so a French parent field
`12210 Montpeyroux` — key `montpeyroux` — took the `locality` bias across the postcode too:

| parentDelta | FR whole-edge (pre-fix) | child-only |
| ----------: | ----------------------- | ---------- |
|         OFF | 77/80 (96.3%)           | 77/80      |
|           4 | 77/80 (96.3%)           | 77/80      |
|           6 | **1/80 (1.3%)**         | 77/80      |
|        8–20 | **0/80 (0.0%)**         | 77/80      |

`loc=[12210 Montpeyroux]` on every failing row — the child was right the whole time. A D-rule
regression on a tier-1 locale, invisible below δ=6, which is one notch under the δ the sub-board
wanted. Fixed by recording the stripped range as `CandidateWindow.keyPieceIndices` and writing the
parent bias over it; the child write still spans the whole segment, unchanged. Two unit tests pin
both the FR leading-postcode and GB trailing-postcode shapes.

Worth stating plainly: the general B-2 board, the broad B-3 board and the preregistered B-1
population would all have passed this defect. The FR leg caught it.

## Reproduce

```bash
node neural-weights-en-us/scripts/link-dev-weights.ts   # and -en-gb, -en-nz, -fr-fr
node mailwoman/out/cli.js eval gauntlet                                  # OFF
MAILWOMAN_PAIR_PARENT_DELTA=6 node mailwoman/out/cli.js eval gauntlet    # ON
```

The board builders and graders are gitignored scratchpad scripts (`scripts/scratchpad/pix1-b1.ts`,
`pix1-b2.ts`, `build-b2-board.ts`, `build-b2-collide-board.ts`, `build-b3-board.ts`,
`build-b3-fire-board.ts`, `build-locality-region-board.ts`). Every board they emit is derived from
`$MAILWOMAN_DATA_ROOT` artifacts on a fixed seed, so they rebuild byte-identically.
