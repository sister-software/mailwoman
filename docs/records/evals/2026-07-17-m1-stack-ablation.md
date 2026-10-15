# 2026-07-17 — M1: the stack ablation. The atlas channel is the stack. Two repairs are inert and two are negative.

The road-to-v7 Track M opener, and the external audit's central unanswered question: how much of
the shipped quality is the model, and how much is the stack of prior channels and repair passes
around it? Eleven configurations — the full production path, each change off one at a time, the
check-battery config, and the raw model without any channel — scored on four arenas with the check battery's own
metric (decodeAsJSON → fold → per-tag exact-match F1). The runner is `scratchpad/m1-ablation.run.ts`
and the results are in `scratchpad/m1-ablation-results.json`. Model = shipped v381/v6.5.0, en-us weights, all
sweeps CPU-only.

Interpretation: the ablation removes a channel the model was TRAINED with, so it tests deliberate out-of-distribution
input (#566/#685), so a channel delta reads "what this channel adds to the trained model" —
not "what a model trained without it would score." That is the right question for the
consolidation ledger (P2): it measures what each layer contributes at inference time today.

## Micro-F1 deltas vs the full production config

| config                 | golden-us (2660) | golden-fr (1546) | adversarial (49) | parity (376) |
| ---------------------- | ---------------: | ---------------: | ---------------: | -----------: |
| full (production)      |             85.5 |             91.6 |             90.1 |         69.6 |
| battery (check config) |         **+2.3** |             −0.0 |             −0.4 |         +0.1 |
| no-heal                |             −0.6 |             −0.8 |             +0.2 |     **−2.6** |
| no-pcrepair            |              0.0 |             −0.0 |              0.0 |         +0.1 |
| no-queryshape          |         **+2.3** |              0.0 |             −0.4 |         −0.0 |
| no-anchor              |             +0.8 |         **−1.6** |              0.0 |         −0.3 |
| no-gazetteer           |        **−10.4** |             −1.7 |             −0.8 |     **−3.9** |
| no-country             |             −0.1 |             +0.3 |             +0.2 |         −0.1 |
| no-conventions         |              0.0 |              0.0 |              0.0 |         +0.2 |
| no-suppress            |             +0.6 |              0.0 |             −0.2 |         −0.1 |
| raw (model only)       |         **−8.8** |         **−9.2** |             −0.7 |     **−8.1** |

## The four findings

**1. The gazetteer channel is the stack.** Without it, the score drops −10.4 micro on golden-us and
collapses the country tag everywhere (−66.5 us / −60.0 fr / −63.4 parity — the country tag comes
almost entirely from the atlas feed), with locality −21.6 and region −16.6 on US riding with it. The
raw-model rows confirm it: of the ~9-point total stack value on us/fr/parity, nearly all of it is
this one channel. The audit's "retrieval-augmented" framing is literal. The atlas channel is
required. Every other channel moves the score by a few points at most.

**2. The query-shape prior COSTS 2.3 micro on clean US addresses — and this is the clean-arena
drift, diagnosed.** `no-queryshape` reproduces the battery numbers exactly: the entire
production-vs-battery gap on golden-us is the query-shape prior, and it is driven by **locality
−7.8** under the prior. On FR, adversarial, and parity it is ~0. Two consequences: (a) the check
battery (which never feeds queryShape) has been over-reporting the production config by 2.3 micro
on US golden, so the check measures a config production does not run. (b) The prior itself misfires
on clean full addresses, the exact "libpostal clean-arena drift" the audit told us to watch.
Follow-up filed: either fix the locality interaction or make the check score the production config.

**3. Two repairs are inert. One is mildly negative.** `postcodeRepair` measures 0.0 on every arena.
This is the first time it has been measured, because the battery never exercised it. The
`conventions` mask is 0.0 everywhere. `suppressGazetteerNearPostcode` (the #956-era near-postcode choreography) is
**+0.6 on golden-us when removed** (house_number +1.9, postcode +1.2) — a repair built for an older
model era that now slightly hurts the current one. All three are P2 consolidation-ledger
candidates: retire each, or show an arena where it improves the score.

**4. The word-consistency heal and the postcode anchor both improve the score, by locale-dependent
amounts.** The heal adds +0.6/+0.8/+2.6 (us/fr/parity). The heal adds the most on parity, the arena with the most hostile input, so the heal stays default-ON. The anchor channel adds +1.6 on FR (house_number +5.7, so FR
depends on it) but reads −0.8 on golden-us, i.e. mildly counterproductive on clean US input. That
reading does not justify a change by itself. It does show that channel value is locale-asymmetric.
The per-locale capability manifest should eventually reflect that asymmetry.

## Cross-check

The `battery` arm scores golden-us 87.8 vs the promotion check's 86.8 for the same weights — a
1.0-point loader difference (createScorer explicit-paths vs loadFromWeights package feed) that is
constant across configs and does not affect any delta above.

## What this feeds

- **P2 (repair-stack consolidation ledger):** pcrepair, conventions, suppress enter with measured
  deltas ≤0 — each must show a justifying arena or be retired at the next consolidation retrain.
- **The queryShape–locality interaction** is a new, quantified defect (−7.8 locality on clean US)
  with a one-line repro (`scratchpad/m1-ablation.run.ts`, configs `full` vs `no-queryshape`).
- **The audit disposition:** Kimi's "repair-stack weight" and "prior-ablation matrix" items are
  now run. The clean-arena-drift watch item has a diagnosis.
