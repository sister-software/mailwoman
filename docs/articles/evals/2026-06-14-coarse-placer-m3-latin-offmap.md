# Coarse-placer M3: the Latin off-map residual is a data wall, not a method one

_2026-06-14. The #244 coarse-placer's M2 OTHER class was trained on non-Latin scripts (Cyrillic,
Arabic, …), so it abstains well on those but still confidently mis-places off-map COUNTRIES written in
Latin script — Poland, Brazil, Mexico — onto a trained Latin country. This milestone tested the
obvious fix: feed it REAL off-map addresses (not synthetic name variants — see #564) as OTHER. The
mechanism works cleanly and at zero in-map cost, but it does not generalize past the countries you
train on, and Overture's addresses theme doesn't currently have the breadth to train on enough of
them. So this is a directional win with an honest ceiling, recorded — not a promotion._

## The residual, measured

A Latin off-map address is **handled** when the placer routes it to OTHER or abstains; anything else is
a confident mis-placement onto a wrong trained country. On a fresh held-out set of real Overture
addresses from off-map Latin countries (n=17815), the shipped (M2) model handles only **23.3%** — i.e.
it confidently mis-places three out of four. Polish addresses go to JP/NL/US at 0.58–0.96 confidence.

## The experiment

Assemble real address strings from the Overture per-country address parquet and append them as
`country: "OTHER"`. Split the countries deliberately:

- **Train** (their rows feed train/val OTHER): PL, BR, MX, PT — the off-map Latin countries Overture
  actually has rows for.
- **Held out** (test only — the generalization probe): CZ (a distinct Slavic country the model never
  sees), plus CA and LI (the hard near-twins — Canadian addresses read like US, Liechtenstein like DE).

Retrain (34s CPU, same SGD recipe), evaluate against the shipped model.

## Results

| group                                           | shipped (M2) | M3 retrain |
| ----------------------------------------------- | -----------: | ---------: |
| **in-distribution** (held-out PL/BR/MX/PT rows) |        23.1% | **100.0%** |
| **held-out** (CZ / CA / LI, never trained)      |        23.3% |      25.0% |
| overall                                         |        23.3% |      31.4% |

Per held-out country: CZ 39.5 → 42.8%, CA 7.0 → 7.4%, LI 19.5 → 20.6%.

**In-map accuracy held**: golden test 94.99 → **95.10%** (+0.1pp), every in-map class flat or up
(ES 90.4 → 91.1%), non-Latin multi-script handling maintained. No regression anywhere — M3 is a strict
Pareto improvement.

## What this says

The mechanism is real: train a country on OTHER and it goes to **100%** handled, at **zero** in-map
cost. But the model learns _those countries' n-grams → OTHER_, not a general "off my map" concept —
the held-out countries barely move (+1.7pp overall), and the near-twins (CA looks like US, and for a
_coarse_ placer that's arguably not even wrong) stay where they are. General Latin off-map handling
needs **broad country coverage** — dozens of off-map countries in the OTHER class, not four.

That breadth is the wall. Of the 12 off-map countries requested from Overture's addresses theme
(2026-05-20.0, ALPHA), only 5 returned rows (PL/BR/MX/PT/CZ); RO/TR/ID/SE/VN/HU/PH/AR were empty. So
this is a **data-availability ceiling, not a method failure** — the same shape as #564's fr.house_number
plateau (real-data realism is the lever; we just don't have enough of it yet).

## Decision

- **Do not promote.** `model-m3` is a strict improvement but does not meet the ≥90% general target; the
  coarse-placer isn't bundled anywhere yet, so there's nothing to gate — this is a recorded finding,
  and the canonical fp32 model stands.
- **The next lever is breadth, not weight or recipe.** Broad off-map address coverage — a full
  OpenAddresses off-map pull, or a later Overture release once the addresses theme fills in — folded
  into OTHER, with the held-out-country probe as the gate. Tracked as a follow-up to #244.

## Reproduce

```bash
node --experimental-strip-types scripts/ingest-overture-addresses.ts --release 2026-05-20.0 \
  --countries PL,BR,MX,PT,CZ,CA,LI --limit 6000
node scripts/coarse-placer/build-outlier-latin.mjs            # appends OTHER + writes the test file
node scripts/coarse-placer/eval-latin-offmap.mjs --model .../coarse-placer/model        # baseline
node scripts/coarse-placer/train.mjs --out .../coarse-placer/model-m3
node scripts/coarse-placer/eval-latin-offmap.mjs --model .../coarse-placer/model-m3     # after
```
