# Re-gating joint-reconcile after the #565 grouper fix

_2026-06-14. We retired joint-reconcile to argmax (#566) after an audit found it broke the
street + house-number geocode precondition on 77–84% of clean US addresses. The root cause — the
phrase grouper bundling the house number into the street phrase — was then fixed (#565). This report
answers the obvious follow-up: now that the destructive mechanism is gone, does reconcile earn its way
back as the default (or at least FR-scoped, the locale #427 claimed it helped)? Graded on the assembled
pipeline in both modes, the answer is no. #565 repaired the structural break, but reconcile is still
strictly worse than argmax on tag values — worst on the exact locale it was supposed to help. Argmax
stays the default; the parked re-promotion decision is resolved as "keep retired."_

## Why we re-gated

The retirement was a de-promotion under fire — the geocoder needed a clean street and a separate house
number, reconcile was merging them, so we flipped the default to argmax and moved on. But two things
left the door open:

1. The **#427 claim** that joint-reconcile helped FR/EU. If true, retiring it would cost those locales
   something, and an FR-scoped re-promotion via the policy registry might be the right shape.
2. The **#565 grouper fix** removed the specific mechanism (house-number bundling) that the retirement
   audit blamed for the 77–84% precondition break. With that gone, reconcile might now be neutral-or-
   better.

So the question is sharp and worth a real measurement: **run the pipeline with `jointReconcile: true`
and see whether it beats-or-matches argmax (`jointReconcile: false`, the #566 default) — on FR without
regressing US — grading the assembled pipeline, never raw neural.** Grading raw neural is the mistake
that hid the original regression for months; we do not repeat it.

## What we measured

Two harnesses, both comparing the **assembled runtime pipeline** in argmax mode vs reconcile mode (same
weights, same grouper, only the `jointReconcile` flag differs):

- `scripts/eval/reconcile-regate.mjs` — per-tag recall on golden v0.1.2, US and FR graded separately.
- `scripts/eval/reconcile-precondition-regate.mjs` — the share of rows that keep a separate
  `street` + `house_number` + `postcode` (the geocoder precondition), on the Travis/OpenAddresses
  holdout (`/tmp/ood-truth.jsonl`, n=1965). This holdout is the same non-circular real-points file used
  in the retirement audit — E-911 / parcel-centroid provenance, disjoint from training and from grouper
  tuning, so the precondition number is not gamed.

### Per-tag recall — reconcile is worse, everywhere it isn't flat

**US — golden v0.1.2, n=2956 addresses**

| tag          | argmax | reconcile | Δ (rec − argmax) |
| ------------ | -----: | --------: | ---------------: |
| house_number |  99.8% |     99.5% |           −0.3pp |
| street       |  95.3% |     92.9% |       **−2.4pp** |
| locality     |  97.7% |     95.9% |           −1.8pp |
| region       |  55.7% |     56.2% |           +0.5pp |
| postcode     |  72.2% |     72.7% |           +0.5pp |
| venue        |  95.2% |     95.0% |           −0.2pp |
| unit         | 100.0% |    100.0% |           +0.0pp |

**FR — golden v0.1.2, n=1551 addresses**

| tag          | argmax | reconcile |    Δ (rec − argmax) |
| ------------ | -----: | --------: | ------------------: |
| house_number |  83.0% |     84.8% |              +1.8pp |
| street       |  79.4% |     65.7% | **−13.7pp** |
| locality     |  80.2% |     76.5% |              −3.6pp |
| region       |  17.4% |     10.5% |              −6.8pp |
| postcode     |  63.9% |     63.4% |              −0.5pp |
| venue        | 100.0% |    100.0% |              +0.0pp |

US has no offsetting win — street regresses 2.4pp, locality 1.8pp, everything else flat. FR is the
damning column: reconcile takes **street from 79.4% to 65.7% (−13.7pp)**, with locality and region also
down. Its only gain anywhere is FR house_number (+1.8pp). The locale #427 said reconcile helps is the
locale it hurts most.

### Precondition — #565 worked, but reconcile still isn't at parity

**Travis/OA holdout, n=1965 (predominantly Austin TX)**

| mode      | street+HN+postcode preserved | reconcile BREAKS (argmax had it, lost it) | reconcile FIXES |
| --------- | ---------------------------: | ----------------------------------------: | --------------: |
| argmax    |              1965 (100.0%) |                                         — |               — |
| reconcile |               1854 (94.4%) |                            **111 (5.6%)** |        0 (0.0%) |

This is the good news and the verdict in one table. The #565 fix is real: the precondition break
collapsed from the retirement audit's **77–84% to 5.6%**. But argmax preserves the precondition on
**100%** of these rows; reconcile still drops the street to `null` on 5.6%, and fixes nothing argmax
missed. The break pattern is consistent — multi-word residential streets:

```
7425 Marble Ridge Drive, Austin, TX 78747   argmax: st=Marble…  reconcile: st=null
11407 Saddle Mountain Trail, Austin, TX 78739  argmax: st=Saddle…  reconcile: st=null
5712 Sunny Vista Drive, Austin, TX 78749    argmax: st=Sunny…   reconcile: st=null
```

## The mechanism

#565 fixed the grouper's house-number bundling — the structural break that the retirement blamed. What
this re-gate shows is that reconcile's harm was never only structural. By **merging** tokens into one
candidate span rather than **selecting** the neural argmax, reconcile destroys internal street
structure that argmax keeps intact. On FR that is the `Rue de la <X>` / `Chemin du <X>` prefix +
particle + core pattern — the merge collapses it and the street value falls apart (−13.7pp). On US
multi-word residential streets it drops the span entirely (the 5.6% precondition break). Argmax avoids
both failure modes for the same reason: it commits to the model's per-token decision instead of
re-deriving a span from phrase proposals. This is design-level behavior of the reconcile path, not a
second bundling bug to patch.

## Verdict — keep reconcile retired

Both gates fail. Reconcile loses tag-value accuracy on US and FR with no locale where it wins overall,
and it still breaks the geocoder precondition on 5.6% of rows where argmax never does. There is no slice
— not even FR — where re-promotion is net-positive. **Argmax stays the default. Joint-reconcile remains
opt-in (`jointReconcile: true`) and undefaulted; this report is the record of why.** The #427 "reconcile
helps FR" claim was an artifact of grading raw neural — the same blind spot that hid the original
regression.

Independent of the reconcile decision, the **argmax-FR street ceiling of 79.4%** is its own open
question (and the FR street/region recall generally) — that is a model + FR-grouper matter, not a
reconcile one, and is left to the FR parity track. Worth capturing as a learning item; not a
prerequisite for this verdict.

## Resolved parked decision

> Re-promote reconcile + scope — **resolved: no.** Keep retired (argmax default). Evidence: this report.
> Concurred by an independent review (DeepSeek, 2026-06-14).

## Reproduce

```bash
yarn compile
node scripts/eval/reconcile-regate.mjs data/eval/golden/v0.1.2/us.jsonl data/eval/golden/v0.1.2/fr.jsonl
node scripts/eval/reconcile-precondition-regate.mjs /tmp/ood-truth.jsonl
```

See also: [`2026-06-14-reconcile-retirement.md`](./2026-06-14-reconcile-retirement.md) (the de-promotion
that prompted this re-gate).
