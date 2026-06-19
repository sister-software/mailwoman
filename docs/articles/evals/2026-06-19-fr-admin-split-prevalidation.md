# FR admin-split — pre-GPU self-validation (2026-06-19)

The international admin-split retrain (night 2026-06-19, surpass-v1.5.0) rests on one premise: that
teaching the model to **split the département out of the locality** moves the assembled, anchor-ON
coordinate. The whole measurement-integrity campaign says to prove that before spending an A100 —
the v1.7.0 trap was a label change the resolver ignored. So this is the falsification gate, run
**before** any training.

## Method

For each sampled FR commune (truth = its own WOF centroid), resolve three parse states through the
**same resolver the geocoder ships** (`createWofResolver` over `admin-global-priority.db`,
`defaultCountry: FR`), and measure great-circle error to the truth centroid:

- **dropped** `{locality:[commune]}` — the model's observed "région → null" failure
- **merged** `{locality:[commune + " " + dept]}` — the AU `CANBERRA ACT` fuse failure
- **split** `{locality:[commune], region:[dept]}` — the corrected parse

Two strata: **collision** communes (a name shared by >1 département — where the région is the only
disambiguator) and **unique** communes (control). Unresolved is penalized to the country centroid
(the coordinate the geocoder actually falls back to on a miss), so the three states are comparable on
one metric instead of averaging over different resolved subsets. n=200 per stratum (`scripts/eval/fr-admin-split-selfvalidation.ts`).

## Result

### Collision communes (n=200) — the région disambiguates

| state                       |  mean km |     p50 |   p90 | resolve-rate |
| --------------------------- | -------: | ------: | ----: | -----------: |
| dropped (région→null)       |    172.4 |   132.0 | 391.8 |          92% |
| merged (loc = commune+dept) |    247.2 |   248.5 | 394.8 |       **0%** |
| **split (corrected)**       | **66.7** | **0.0** | 281.4 |          97% |

**SPLIT vs DROPPED: −61.3% mean error**, split beats dropped by >2 km on 100/200.

### Unique communes (n=200) — control

| state                       |  mean km |   p50 |   p90 | resolve-rate |
| --------------------------- | -------: | ----: | ----: | -----------: |
| dropped (région→null)       |    112.7 |   0.0 | 363.1 |          65% |
| merged (loc = commune+dept) |    318.0 | 315.5 | 453.6 |       **0%** |
| **split (corrected)**       | **50.4** |   0.0 | 219.1 |          87% |

**SPLIT vs DROPPED: −55.3%**.

## Read

Three findings, all the same direction:

1. **The région tag is load-bearing.** Collision communes drop 172 → 67 km (p50 132 → 0). Without
   the région, the resolver picks the wrong same-named commune about half the time — exactly the
   disambiguation the split restores.
2. **The merge failure is catastrophic, not cosmetic.** `locality = "Villeneuve Creuse"` resolves to
   **nothing** (0% across both strata). The AU-style locality+admin fuse doesn't mis-resolve — it
   fails to resolve at all. Fixing it is pure upside.
3. **Even unique communes benefit.** Adding the département lifts resolve-rate 65 → 87%: a bare
   `{commune}` doesn't always resolve, and the admin context helps the resolver find it.

**Verdict: the lever is real — the resolver demonstrably uses the région tag, so a model that emits
the split will move the anchor-ON coordinate.** The GPU is justified.

**Honest caveat:** this measures the _ceiling_ with perfect, hand-constructed splits. The retrain
must still learn to (a) emit the right département and (b) keep the commune right. So the live gate
on the trained candidate (`gate rubric` in the night plan — FR centroid-shift, anchor-ON, vs v1.5.0)
is what counts; this only proves the ceiling is worth climbing toward. It is: a 55–61% reduction and
a 0% → 97% resolve-rate flip on the merge class.

Reproduce: `node --experimental-strip-types scripts/eval/fr-admin-split-selfvalidation.ts --n 200`.
