# Retiring joint-reconcile as the default decode path

_2026-06-14. A reconcile-vs-raw-neural audit, run during the geocoder campaign to quantify how often
the shipped pipeline degrades a parse, found the joint-reconcile path (#427's default since Route A
Phase II) breaks the street + house-number geocode precondition on 77–84% of clean US addresses and
fixes none. This report records the measurement, the mechanism, and the decision to de-promote it back
to argmax. The destructive piece — the phrase grouper bundling the house number into the STREET_PHRASE
— is filed separately as the real fix._

## Why we looked

The forward geocoder keys its situs and interpolation tiers on a clean street name plus a separate
house number. Building the `geocode` CLI, the situs tier silently fell through to the admin centroid on
addresses it should have nailed. The cause was the runtime pipeline's reconcile stage merging the
house number and street into one node. We bypassed it in the CLI (raw `classifier.parse` +
`resolveTree`) and then ran an audit to see how widespread the damage was — because our per-tag evals
grade **raw neural** (`classifier.parse`), not the assembled pipeline, so a pipeline-stage regression
is invisible to every scorecard we publish.

## What we measured

**Precondition audit** — share of addresses where the parse yields a separate `street`, `house_number`,
and `postcode` (the minimum the geocoder needs), on two **non-circular** US holdouts:

| Holdout                          | raw neural | reconcile pipeline | reconcile BREAKS (raw had it, lost it) | reconcile FIXES |
| -------------------------------- | ---------- | ------------------ | -------------------------------------- | --------------- |
| Travis County E-911 (TX, n=1965) | 100.0%     | 16.2%              | **83.8%** (1647)                       | 0%              |
| OpenAddresses 7-state (n=700)    | 99.7%      | 22.9%              | **76.9%** (538)                        | 0%              |

**Per-tag recall** — raw argmax vs the reconcile pipeline on golden v0.1.2 US+FR (n=4507, the eval
family our parity scorecards use; loose value-match, identical for both columns so the delta is fair):

| tag          | raw    | reconcile | delta       |
| ------------ | ------ | --------- | ----------- |
| house_number | 92.7%  | 69.7%     | **−23.1pp** |
| street       | 92.6%  | 67.0%     | **−25.6pp** |
| locality     | 89.2%  | 87.0%     | −2.3pp      |
| region       | 53.1%  | 53.1%     | −0.1pp      |
| postcode     | 68.5%  | 68.7%     | +0.2pp      |
| venue        | 95.5%  | 95.0%     | −0.6pp      |
| unit         | 100.0% | 100.0%    | 0.0pp       |

Reconcile is **worse-or-flat on every tag** — including venue, the component #427 promoted it for.

## The mechanism

For `3075 Hill Street, Round Rock, TX 78664`:

- The **phrase grouper** proposes `STREET_PHRASE = "3075 Hill Street"` — it bundles the leading house
  number into the street phrase (it should propose `"Hill Street"`). Same shape on `350 5th Ave` →
  `STREET_PHRASE = "350 5th Ave"`.
- **`reconcileSpans`** takes that span and, from the aggregated span logits, types the whole thing as a
  single node — sometimes `house_number = "3075 Hill Street"`, sometimes `street = "109 Seminary Dr"`.
  Either way the number and street name fuse; there is no separate `street`.
- **Raw neural** parses it correctly: nested `street = "Hill Street"` containing `house_number = "3075"`.

This is structural, not data-dependent: it fires on every "number + street name" pattern, i.e. nearly
every US street address.

## Why #427 didn't catch it

The Route A Phase II re-gate reported "DE +25pp, IT/ES +15pp, per-field regression under 0.5%." A direct
DE/ES probe shows the kernel of truth: on out-of-distribution inputs where the en-US model mangles the
street (`Müllerstraße 12` → raw `street = "Müllerstraße 1"`, truncated), reconcile keeps the street
string intact (`"Müllerstraße 12"`). That lifts a **loose street-string-recall** metric. But neither
path separates the house number on those inputs — neither produces a geocodable parse — and the re-gate
never measured the **geocode precondition** (clean street + separated house number) on standard US
addresses. Our evals grade raw neural, so nothing downstream of the classifier was ever scored against
truth. The blind spot was the eval target, not the math.

## The decision

**Retire joint-reconcile as the default.** `jointReconcile` defaults to `false` (argmax) as of this
change (`core/pipeline/runtime-pipeline.ts`). This:

- Recovers street +25.6pp and house_number +23.1pp; loses nothing measurable (region/postcode/venue/unit
  flat, locality +2.3pp).
- Restores the pipeline to **byte-identical** with raw neural on both holdouts (Travis 100% precondition,
  OA 99.7%, every street/HN tag identical) — confirming the grouper-audit venue rescue, which runs in
  both paths, injects nothing spurious on fully-parsed addresses.
- Makes `parse` consistent with the already-fixed `geocode` CLI.

The flag and the `reconcileSpans` code stay; the A/B harnesses still drive it with `jointReconcile: true`.
This is the geocoder-sprint-correct default (US street-level is the DoD; multi-locale may degrade this
sprint), not a deletion.

## Residual

The destructive piece is the **phrase grouper bundling the house number into `STREET_PHRASE`**. Fixing
that — so the grouper proposes the bare street phrase and reconcile can separate the number — is the
prerequisite to ever re-enabling reconcile for the multi-locale work, where its OOD street-intactness is
genuinely useful. Filed as a tracked issue.

## Reproduce

```bash
yarn compile   # both scripts read the compiled out/ trees
# precondition audit (raw vs pipeline), any OA-format holdout:
node scripts/eval/reconcile-precondition-audit.mjs data/eval/external/openaddresses-us-sample.jsonl 700
# per-tag raw vs pipeline on golden:
node scripts/eval/pertag-raw-vs-reconcile.mjs data/eval/golden/v0.1.2/us.jsonl data/eval/golden/v0.1.2/fr.jsonl
```

(The numbers above were also measured against the Travis County E-911 holdout `/tmp/ood-truth.jsonl`,
acquired out-of-lineage from TxGIO/TNRIS — see the geocoder campaign doc.)
