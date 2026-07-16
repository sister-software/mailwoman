# The Norway retrain falsified the coverage hypothesis

2026-07-16 (afternoon). The deepparse rematch (§2) attributed two of four contextful house_number
losses to Norwegian coverage — the model "never saw Norwegian" (v310 trained on 0 NO rows, the YAML
bug #1145). We ran the retrain to validate it. **It's wrong. Coverage is not the lever.**

## The experiment

- **v3.4.0** — 2k probe, init_from v310, Norway un-dropped. Brief Norwegian rows read IDENTICAL to
  v310. Read as: v310's prior too baked for 2k to overwrite → escalate.
- **v3.4.1** — 8k, init_from v264 (v310's PARENT), v310's exact recipe, Norway now flowing ~4.2%.
  "What v310 would have been with #1145 fixed." Converged clean, no NaN.

## The result: v341 ≡ v310 on every Norwegian measurement

|                              | v310 (0 NO rows)             | v341 (8k, Norway in) |
| ---------------------------- | ---------------------------- | -------------------- |
| `Epleskogen 39A` (bare)      | locality + postcode          | **identical**        |
| `Tindvegen nedre 44B` (bare) | locality + street + postcode | **identical**        |
| board 3 bare-street-hn       | 0.693                        | 0.695 (noise)        |
| board 3 overall              | 0.867                        | 0.867                |

And the tell that closes it:

```
Epleskogen 39A, 4370 Egersund   (CONTEXTFUL)
  v310: street "Epleskogen", house_number "39A", postcode 4370, locality Egersund   ✓ CORRECT
  v341: identical
```

**v310 — which never trained on a single Norwegian address — already parses contextful Norwegian
perfectly.** It generalizes from its 20-locale training (Swedish/Danish/German neighbours + diacritic
street morphology). Adding real Norwegian data changed nothing, because there was nothing to fix.

## What the Norwegian rows actually are

`Epleskogen 39A` fails **only in bare form**. The same street with a postcode+city parses correctly
on v310. So the failure is not "the model doesn't know Epleskogen" — it is the **bare-street polarity
licence defect** (bare toponym → locality by default), the exact cross-lingual defect Track B
root-caused (FR/NO/PL) and fr-fragment fixed for French. Coverage doesn't touch it because the model
already generalizes to the street _in context_; the defect is the default when context is stripped.

## Corrections this forces

1. **The deepparse rematch §2 was wrong.** The Norwegian house_number losses are not coverage — they
   are the bare-street licence defect in bare form. deepparse wins them via its bare-fragment
   StreetNumber default, not more Norwegian data. (Corrected in that doc.)
2. **#1145 remains a valid bug** — Norway _should_ train, and v341 confirms it is do-no-harm (US/FR/PL
   and board 3 all flat) — but it is **not the house_number lever**, and a v6.5.0 on v341 would change
   nothing a user sees. Not a ship candidate.
3. **Data acquisition (Kartverket / LINZ / BAG) is a BREADTH play, not the house_number fix.** The
   model already generalizes to unseen locales in context; more national address files widen coverage
   but won't close the deepparse house_number gap.

## What actually defines the day

The house_number gap is **Track B, end to end** — no coverage escape hatch:

1. **The bare-street polarity licence defect** (cross-lingual). The fragment shard — but note B4's
   NO-only probe was weak (+1.7pp); the real move is a _cross-lingual_ fragment shard at a higher
   bare-street ratio (B4b), or
2. **The length-conditioned digit defect** — the number-piece vocab splice (B4c), which attacks the
   root the shard only dents.

The retrain cost ~$6 and bought the most valuable thing a cheap experiment can: it killed the
plausible-but-wrong hypothesis (coverage) that both the operator and I believed, before it shipped.
