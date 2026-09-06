# Semantic-utility probe — pre-registration and baseline (#1928)

**Date:** 2026-08-26. **Command:** `mailwoman eval semantic-utility-probe --arm baseline --out
packages/mailwoman/lib/eval-harness/semantic-utility/baseline-receipt.json`. **Pre-registration:**
`packages/mailwoman/lib/eval-harness/semantic-utility/probe-definition.json` v1.0.0, content hash
`df32f00dc3665f6b9aa79330668d5f5791153e82ef5b036271a41660796bf84c`. **DB:**
`$MAILWOMAN_DATA_ROOT/poi/poi.db`, `layer_manifest` `poi 2026-07-22.0` (vintage 2026-07-22.0).
**Weights:** en-US 9.1.0. **Resolver:** candidate-table backend. **Tree:** working tree at
`2b5fa6193` carrying this pull request's harness, which adds no pipeline behaviour.

This is the frozen ruler for the geographic-model utility decision (#1930) and the pre-injection
measurement it compares against. #1929 supplies one semantic observation and runs the same command
with a different `--arm`; it changes no row, no comparator, no metric and no threshold.

## Route

Route (a) of the boundaries record §5.5 — commit the target rows first, graded on outcomes only.

Route (b) pre-registers on the §5.3 recall gap, and it cannot be executed against the frozen
vertical slice: reaching the 7,168 `drugstore` rows the shipped `pharmacy` query cannot see needs a
**second** establishment class asserting the affordance, which §4 forbids ("no sibling class is
minted") and stop condition 5 makes an explicit amendment rather than a probe. It would also need a
recall metric the committed grader does not have (§5.5's second bound). Route (a) needs neither: the
comparator already exists and is committed, the anchors and expectations are copied byte-for-byte
from committed board rows, and the semantic arm is reachable from the frozen slice alone — activity
phrase → `obtain_medication` → the concepts that afford it → POI category `pharmacy` through the
committed mapping.

The target rows live in the pre-registration rather than in `poi-board.jsonl` for two reasons. The
board's floors were pre-registered against a 51-row composition, and moving that denominator would
move a second ruler while this one is being set. And #1930 reserves promotion into the permanent
board family for a GO decision.

## The frozen definition

**Comparator:** `poi_board_assembled_answer` — `gradeCase` from
`packages/mailwoman/lib/eval-harness/poi-board.ts`, unchanged. The top result's `categoryID` and the
nearest returned coordinate against the row's committed anchor. Outcomes only.

**Target rows (4).** Each pairs an activity phrase attested in §5.1 with an anchor taken byte-for-byte
from the committed control row named beside it. No row carries a `locale`, matching its control, so
the anchor, the country prior and the weights package are held constant and the subject phrase is the
only thing that varies.

| id              | query                                               | anchor from | expected            |
| --------------- | --------------------------------------------------- | ----------- | ------------------- |
| `sem-act-us-01` | `where can i pick up a prescription near Denver CO` | `cat-us-05` | `pharmacy`, ≤ 25 km |
| `sem-act-us-02` | `prescription near Denver CO`                       | `cat-us-05` | `pharmacy`, ≤ 25 km |
| `sem-act-fr-01` | `somewhere to fill a prescription near Toulouse`    | `cat-fr-03` | `pharmacy`, ≤ 25 km |
| `sem-act-mx-01` | `i need my prescription refilled near Tijuana`      | `cat-mx-02` | `pharmacy`, ≤ 25 km |

**Control rows (6), in two groups, both deciding.**

| id           | group           | query                     | guards                                             |
| ------------ | --------------- | ------------------------- | -------------------------------------------------- |
| `cat-us-05`  | `same_category` | `pharmacy near Denver CO` | the venue-noun form at two target rows' anchor     |
| `cat-mx-02`  | `same_category` | `pharmacy near Tijuana`   | the venue-noun form at `sem-act-mx-01`'s anchor    |
| `cat-fr-03`  | `same_category` | `pharmacy near Toulouse`  | the venue-noun form at `sem-act-fr-01`'s anchor    |
| `syn-01`     | `adjacent`      | `er near Denver CO`       | a different healthcare category at the SAME anchor |
| `cat-us-04`  | `adjacent`      | `bank near Seattle WA`    | an unrelated category at an unrelated anchor       |
| `abstain-05` | `adjacent`      | `hospital`                | a bare category — an arm must not invent an anchor |

The second group is what makes the control set non-vacuous: an arm that answers `pharmacy` for
everything would leave all three `same_category` rows green.

**Metrics.**

- `target_answer_rate` — target rows passing the comparator, over **4** registered target rows.
- `target_poi_routing_rate` — target rows whose outcome shape is not `no_poi_branch`, over the same
  **4**. This is the structured mechanism metric the DIAGNOSTIC-ONLY decision requires; it reads the
  closed POI outcome-shape vocabulary, never free-form prose.
- `control_hold_rate` — control rows still passing, over **6**.

A row that errors, returns nothing, or never reaches the POI branch counts as not answered and stays
in its denominator.

**Thresholds.** Both metrics are asked for three of the four target rows. Each delta bar is
`3 − that metric's measured baseline`, so the absolute bar binds and the delta bar forbids reaching
it by baseline drift.

| decision            | condition                                                        |
| ------------------- | ---------------------------------------------------------------- |
| **STOP-REDESIGN**   | checked first: control regressions > 0                           |
| **GO**              | `target_answer_rate` ≥ **3**/4 and delta ≥ **+3**                |
| **DIAGNOSTIC-ONLY** | otherwise `target_poi_routing_rate` ≥ **3**/4 and delta ≥ **+2** |
| **STOP-REDESIGN**   | otherwise                                                        |

A control regression stops under both decisions: a target delta bought by breaking the venue-noun
form of the same query is not a result the program can act on.

## The baseline

| metric                    | numerator | denominator |
| ------------------------- | --------: | ----------: |
| `target_answer_rate`      |     **0** |           4 |
| `target_poi_routing_rate` |     **1** |           4 |
| `control_hold_rate`       |     **6** |           6 |

| role    | id              | shape                | pass | detail                                                                    |
| ------- | --------------- | -------------------- | ---- | ------------------------------------------------------------------------- |
| target  | `sem-act-us-01` | `no_poi_branch`      | ✗    | `path=full`, no poi intent                                                |
| target  | `sem-act-us-02` | `no_poi_branch`      | ✗    | `path=full`, no poi intent                                                |
| target  | `sem-act-fr-01` | `poi_intent_results` | ✗    | nearest 211.75 km > 25; top category `womens_clothing_store` ≠ `pharmacy` |
| target  | `sem-act-mx-01` | `no_poi_branch`      | ✗    | `path=full`, no poi intent                                                |
| control | `cat-us-05`     | `poi_intent_results` | ✓    | 20 results, nearest 0.41 km, top `pharmacy`                               |
| control | `cat-mx-02`     | `poi_intent_results` | ✓    | 20 results, nearest 1.05 km, top `pharmacy`                               |
| control | `cat-fr-03`     | `poi_intent_results` | ✓    | 20 results, nearest 0.12 km, top `pharmacy`                               |
| control | `syn-01`        | `poi_intent_results` | ✓    | 20 results, nearest 1.12 km, top `hospital`                               |
| control | `cat-us-04`     | `poi_intent_results` | ✓    | 20 results, nearest 3.04 km, top `bank`                                   |
| control | `abstain-05`    | `poi_abstain`        | ✓    | `anchor_required`                                                         |

**Recorded decision for this arm: STOP-REDESIGN** — the baseline compared against its own frozen
baseline moves nothing, which is the self-check that the decision function is not vacuously
permissive.

### One measured surprise, and why the row stays

§5.2 measured `matchPOISubject` in isolation and found NO SUBJECT MATCH for all four activity
phrases. The full pipeline reproduces that for three of them. `sem-act-fr-01` still reaches the POI
branch, and the reason is not the category lexicon: `matchPOISubject` returns `null` for it too.
`Somewhere` is a POI **name** in the shipped `poi.db` — a `clothing_store` in Bordeaux and two
`womens_clothing_store` rows in Lyon and Paris — so the name lexicon claims the query and the branch
answers a clothing store 211.75 km from Toulouse.

That makes this row's baseline a confident wrong answer rather than a miss, which is a worse starting
point than the other three, not a better one. The row is kept: its form is attested in §5.1, and
swapping it out after measuring would be exactly the row selection this pre-registration exists to
prevent. It is the reason the diagnostic baseline is 1 rather than 0, and therefore the reason the
diagnostic delta bar is +2 rather than +3.

## Reproducing

```bash
yarn compile
node packages/mailwoman/out/cli.js eval semantic-utility-probe --arm baseline --json
```

The loader refuses the pre-registration if its content hash has moved from
`packages/mailwoman/lib/eval-harness/semantic-utility/probe-freeze.json`, so a run that produces a
receipt has provably read the ruler recorded here. `packages/mailwoman/test/unit/eval-harness/semantic-utility-probe.test.ts`
holds the freeze, the refusals, the arithmetic, and this receipt's agreement with the frozen numbers.
