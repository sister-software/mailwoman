# T1b — the gazetteer feedback loop: real ingredients, no measured effect

**Question (pre-registered, 2026-07-16 review Tier 1b):** famous streets sit in WOF as _places_, so the
gazetteer channel injects the locality vote on `Rue Montmartre`, the model takes it, and the resolver
reinforces it — a learned feedback loop, the Pelias trap in soft form. Is it live?

**Verdict: the ingredients are real; the effect is nil. The hypothesis is FALSIFIED as a cause of the
target class.** The model's locality reading is its own.

|         |                                                                |
| ------- | -------------------------------------------------------------- |
| Probe   | `scratchpad/t1b-gazetteer-feedback.mjs`                        |
| Model   | v264 (v6.3.0, shipped), ship config                            |
| FST     | `fst-global-priority.bin` — 2,084,640 states, 4,144,846 places |
| Fixture | `mailwoman/eval-harness/fixtures/paris-streets.jsonl` (n=63)   |

---

## 1. The ingredients are unambiguously present

Walking the shipped FST over the 63 fixtures returns **43 distinct surfaces, 37 of which would fire an
emission bias** (`PLACETYPE_TO_BIO` covers country/region/locality/postalcode; `impBias = importance *
biasScale * maxBias`).

| surface                  | placetype : importance                | note                        |
| ------------------------ | ------------------------------------- | --------------------------- |
| `rue`                    | localadmin 0.145, neighbourhood 0.149 | the designator is a place   |
| `boulevard`              | neighbourhood 0.167                   | so is this one              |
| `place`                  | neighbourhood 0.169                   | and this one                |
| `la`                     | locality **0.850**                    | a particle, inside a street |
| `du`                     | region **0.650**                      | likewise                    |
| `de`                     | county 0.192                          | likewise                    |
| `londres`                | region 0.937, locality 0.936          | exonym, near-max importance |
| `paris`                  | region 0.789                          |                             |
| `temple`                 | locality 0.468                        |                             |
| `saintgermain`           | locality 0.386                        |                             |
| `rome`                   | locality 0.378                        | the `Rue de Rome` archetype |
| `hugo`                   | locality 0.295                        | `Avenue Victor Hugo`        |
| `12`, `2`, `14`, `21`, … | localadmin 0.05–0.15                  | bare house numbers          |

Three findings worth naming:

1. **Street furniture is in the gazetteer.** `rue`, `boulevard`, `place` all carry live importance.
   The operator flagged this from the FST months ago; this is the confirmation.
2. **The French particles are the strongest hits on the board.** `la` at 0.850 locality and `du` at
   0.650 region sit inside exactly the phrases the arc targets — `Rue de la Paix`,
   `Rue du 11-Novembre-1918`. If any surface were going to drag a street reading toward locality, it
   is these.
3. **Bare house numbers match places.** `12` → localadmin 0.065, `2` → 0.148. The gazetteer will
   happily bias a house number toward an admin tag.

Only 3 surfaces were inert at importance 0 (`avenue`, `budapest`, `paix`) — so the
[meaning-of-zero](../plan/reference/registry-backed-structured-prediction.mdx) inertia is **not** what
is protecting us here. The prior is live and it fires.

## 2. The effect is nil

| class                  | prior OFF | prior ON  |     |
| ---------------------- | --------- | --------- | --- |
| bare-fragment/elision  | 3/6       | 3/6       |     |
| bare-fragment/esoteric | 7/10      | 7/10      |     |
| bare-fragment/famous   | 3/15      | 2/15      | −1  |
| bare-fragment/homonym  | 4/12      | 4/12      |     |
| contextful/homonym     | 6/6       | 6/6       |     |
| contextful/multi-class | 9/10      | 10/10     | +1  |
| date-name              | 1/4       | 1/4       |     |
| **TOTAL**              | **33/63** | **33/63** | +0  |

Exactly two fixtures changed, in opposite directions:

```
BROKE [bare-fragment/famous] "Boulevard Haussmann"
    off="Boulevard Haussmann"  on="Haussmann"
FIXED [contextful/multi-class] "12 Rue du Chat-qui-Pêche, Paris"
    off="Rue du Chat-qui-Pêche, Paris"  on="Rue du Chat-qui-Pêche"
```

The one break is on-thesis (the `boulevard` neighbourhood entry eats the prefix); the one fix is the
prior doing its actual job (`Paris` is a locality, so stop calling it street). Net zero on n=63 is
consistent with noise in both directions, not with a systematic drag.

## 3. What this closes and what it opens

**Closes:** the feedback loop is not the cause of the bare-fragment failures. Every Paris and parity
number in the arc was measured with this prior OFF (see below), and turning it ON does not rescue the
class. `Rue Montmartre → locality` is the model's own prior, learned from a corpus where bare street
fragments are rare and bare localities are not.

**This is a positive result for the plan, not a null one.** It removes the last inference-time
explanation standing between the evidence and the training-distribution hypothesis. T2 (the BAN
bare-street shard) was already ranked highest-EV by all three reviewers; it is now the only live
explanation with a lever attached.

**Opens — the harness does not run production's configuration.** Found while setting this up:

- `core/pipeline/runtime-pipeline.ts:426` — production's joint branch calls
  `parseWithLogits(normalized, { queryShape, fst: stages.fst })`. Production runs the FST prior **and**
  the queryShape prior.
- `oracle-k.ts`, `parity-corpus.ts`, and the arc's scratchpad probes call
  `parse(input, { postcodeRepair, enforceWordConsistency })` — **neither prior**.
- `parity-corpus.ts` can wire the street-morphology prior, but only behind `--street-morphology`,
  which defaults to **false** and is labeled "Probe 0".

So the standing parity floors and the whole span-head arc grade a configuration production does not
run. On this fixture the FST half of that gap measures **+0**, which bounds the concern for Paris —
but it is unmeasured for parity and every other locale. Tracked as its own item; the fix is a
measurement, not a guess.

Note the shape of the miss: this is the #718 channel-starvation class one layer up. Phase 1's +7.9pp
headline was corrected for channel starvation in the _Python_ harness; the "channels fed" JS harness
that replaced it is itself missing two priors production has. A registered baseline
(`baselines.json`) cannot catch this — a baseline registered against the starved config is
self-consistent. **The registry pins reproducibility, not validity.**

## 4. Also worth a look later

`applyBias` collects `allPieceIndices` across every word group and applies the winning per-tag bias to
**all of them** — the bias is global to the input, not positional. That may be why 37 firing surfaces
move two fixtures. Not chased here; noted because it bears on whether the FST prior is doing anything
useful at all, which is a different question from whether it is doing harm.

---

**Reproduce:** `node scratchpad/t1b-gazetteer-feedback.mjs` (needs `fst-global-priority.bin` under
`$MAILWOMAN_DATA_ROOT/wof/`; the artifact is dated 2026-05-28 — the staleness #1142 flagged).
