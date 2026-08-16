# Mechanism accounts — diagnosis machinery for mailwoman

**Date:** 2026-08-17 · **Status:** design of record; first slices landed (see §8) · **Epic:** #1716
**Origin:** the 2026-08-16 design conversation, the #1711 investigation that motivated it, and two
claim-tagged research reports (`docs/records/research/2026-08-16-*.md`).

## 1. The problem

Debugging this system today rests on whoever is reasoning about it in the moment. The operator named
the cost precisely: every context reset means re-learning how addresses behave through a small
porthole, and the assistant's in-context reasoning is a load-bearing part of how the product
improves — which is exactly what nobody wants load-bearing.

The instrument driving that dependence is the aggregate. Distance-from-truth is a projection that
destroys diagnostic information: the #1711 city-only stratum reported `89.1% vs 96.9%, p = 0.084` —
"underpowered, nothing to see" — while containing a six-row single-mechanism defect
(`Weimar, Thüringen` → Weimar, **Texas**, 8,627 km, with the disambiguator in the input) and a
truth-provenance flaw that flipped the sign of a column when corrected (#1725). Both findings came
from hand-tracing, an A/B, and one suspicious 0.23 m error. None of that is a process.

## 2. The two commitments (the anti-Pelias rules)

Pelias-style rule geocoders ossify through their test suites: each test encodes a belief about how
addresses work, new addresses force nudges that must not break old tests, and the suite becomes a
straitjacket. A hand-authored taxonomy of failure classes is the same folly one level up. Two
commitments prevent it:

1. **Expectations pin OUTCOMES, never mechanisms.** A board row asserts "this input resolves near
   here" and nothing else. No row ever asserts "fails with class X" or "takes path Y." Explanations
   are recomputed from the current system on every run, free to dissolve when the code changes —
   nothing mechanistic accumulates for a truer understanding of addresses to break against.
2. **Failure shapes are MECHANISM-STATES, never address shapes.** The vocabulary comes from the
   pipeline's own seams — _parsed-but-not-consulted_, _absent-from-candidates_,
   _present-but-outranked-by-term-T_, _gated-out-by-G_, _evidence-silent_ — and makes claims about
   what the system did, never about how addresses work. It is finite, derived from code structure,
   and versioned with the code.

## 3. The account

Per-row, regenerated every run, assembled from facts the system already computes: what the parse
produced, what each evidence channel fed, what retrieval returned, which constraints were applied,
which gates fired, what won and on which score terms — plus the smallest counterfactual that flips
the row. Every line is checkable against execution; nothing in it is a narrative.

The Weimar worked example, with today's real data:

```
input: "Weimar, Thüringen"
parse:      locality=Weimar, region=Thüringen (conf 0.69–0.92)   — qualifier extracted
evidence:   anchor 0/4, gazetteer 0/4, country 0/4                — every channel SILENT
            ⚠ "thüringen" is a candidate.db region row (DE, importance 0.73)
            → evidence-silent (and channel-empty-for-known-token)
retrieval:  locality "weimar" → candidates include DE and TX rows
constraint: parsed region resolves to a DE region row — never applied to the ranking
            → parsed-but-not-consulted
winner:     Weimar TX  (admin tier)
smallest counterfactual: apply the region constraint → order inverts
```

The interiority boundary, stated honestly: inside the weights there are no reasons to recover.
Accounts live at the seams — what was fed, retrieved, gated, ranked — and when one bottoms out at
"the model chose X with margin m and every channel silent," that IS the class (the model flew
blind), and the fix is evidence, not archaeology in the logits.

## 4. Shapes and confidence

Classification is a **posterior with abstention**, never a bare label (operator's amendment,
2026-08-16 — a hard label is a confidence of 1.0 nobody argued for).

- **v1 — seam-fact matching.** Each shape predicts a pattern of seam facts; a row's posterior is
  scored by which predictions the observed facts match. Transparent, no training, and reports
  itself as uncalibrated. Ambiguity is useful: a posterior split evenly between
  `constraint-not-consulted` and `evidence-starvation` names the next cheapest probe (feed the
  channels, watch the order).
- **v2 — Mondrian (class-conditional) split conformal** over the human triage ledger. Marginal
  conformal measurably collapses on rare classes; per-class calibration restores coverage and makes
  vocabulary growth cheap — a new shape needs only its own ~20–40 triaged rows, existing guarantees
  untouched. **Novelty mints a class**: a case conforming to no known shape gets a conformal
  p-value that says "new shape," never a forced classification. Rolling-window recalibration
  (triage standards drift); calibration expires with the tree fingerprint. Skip evidential deep
  learning. (Research grounding: decoder-interpretability report §4; the assembled-practice gap is
  flagged there — no literature treats a _changing_ diagnosis vocabulary as solved.)

## 5. The three coverage checks

One trichotomy covers what outcome tests cannot see. All three exist because soft mechanisms are
designed to degrade silently ("features, never overrides"), so their failure is invisible to any
test that asserts outcomes:

| check                                                 | asserts                                                   | catches                                                                                 | status                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **mailfail** (`eval-harness/fixtures/mailfail.jsonl`) | must NOT activate (no-component / no-resolve / no-throw)  | garbage handled as garbage                                                              | shipped 2026-08-02                                                               |
| **activation census** (#1719, `mwdev_census`)         | must activate SOMEWHERE (L0 ran / L1 signaled / L2 moved) | inert mechanisms — the house's most-repeated failure class (#1699, #1703, #1349, R5)    | L0/L1 shipped; first run found 2 inert, both verified deliberate and allowlisted |
| **fragile-pass ledger** (#1720)                       | activated for the RIGHT reason                            | compensated defects (XOR signature: fixing one of a canceling pair turns the board red) | designed; needs accounts                                                         |

Census rules: zero at L1 across the set is a failure unless allowlisted with a reason a reader can
check; an allowlisted mechanism that FIRES is a stale reason, reported loudly. Measured baseline,
first run over the 558-row board: **364 rows (65.2%) parse with every present evidence channel
silent** (gazetteer fires 158/558, country 141/558, anchor 54/558).

The ledger's policy payoff: it **pre-registers** which passing rows may legitimately flip when a
named mechanism is fixed — how an unmasking fix survives the D-rule instead of being reverted as a
regression.

## 6. The coherence ladder (the checker)

Scores the **assembled output** — the joint the resolver emits — which the decoder never sees, so
the two fail independently. Output is per-component verdicts (`locality confirmed / region
contradicted`), never one scalar (the Google-confirmation-levels / USPS-DPV pattern; the
accept/review/reject band already exists as Fellegi–Sunter's clerical band in `packages/match`).

- **Rung 0 — deterministic containment** (#1717): `ancestry(winner) ∌ parsed region` is a boolean,
  one PARENT_OF walk, no model. Kills the Weimar class. Flag-first, re-rank behind a lever,
  D-rule before default-on.
- **Rung 1 — counting**: p(parent|child) as literal hierarchy-table lookups (SDValidate shape);
  smoothing only where sparsity measurably bites.
- **Rung 2+, gated** (#1724): masked-cell model (MCM/TURL-shaped) over assembled records, reusing
  the BIO masking infrastructure — only for coherence the hierarchy cannot express, and only if it
  beats the rung-1 baseline in an eval. ("Autodecoder" investigated and rejected — right intuition,
  wrong rung; coherence report §1.)
- **Echo-chamber guard, structural**: any checker trains on gazetteer + labeled corpus ONLY;
  resolver outputs are scored, never supervision. Standing audits: round-trip fixpoint through
  `@mailwoman/formatter`, and adversarial validation (real-vs-assembled classifier; AUC ≫ 0.5 is
  itself a defect meter).

## 7. Model-side instruments (#1723)

In ship order: evidence-silent predicate (no interpretability needed — shipped, §8) → linear
country probe + logit-lens decision depth (the model/resolver contradiction detector: hidden states
read "DE" while the resolver commits US) → channel-reliance board metric (paired-input interchange;
ERASER sufficiency/comprehensiveness per checkpoint) → exhaustive patch-sweep tool (~1,700 sites
per input at this depth; seconds per case) → gated: IIT country register, at most one exploratory
SAE run. Non-levers, recorded so they are not re-proposed: hard concept bottlenecks (would have
been wrong in Weimar — flag bypass decisions, never prevent them), RRR gradient penalties,
attention-as-explanation.

## 8. What is already landed (as of 2026-08-17)

- `variable_isolation` rename — the confound check now claims setup hygiene, not causation
  (the vocabulary bug beneath it was #1715).
- `evidence.ts` — absent / silent / fired channel states + the starvation flag; on every
  `mwdev_trace` row (#1718).
- `mwdev_census` — L0/L1 per mechanism, inert verdicts, self-policing allowlist (#1719).
- Panels **v2.1 / v3.1** — the 25 board-sourced city-only truth rows re-sourced from Wikidata;
  the corrected measurement inverted the @1km column (#1725, closed).
- Run store + recorded arms (#1714) — every comparison replayable by `run_id`, which is what makes
  account-generation over past runs possible.

## 9. Sequencing

`now` → #1717 (flag-only), remaining #1718 production bit
`next` → #1721 (resolver interior in the trace), #1720 (ledger over accounts), census L2
`then` → #1722 (`mwdev_diagnose` v1), #1723 (probe + reliance metric)
`later` → #1722 conformal v2, #1723 patch sweep, #1724 rungs 1+

## 10. Bounds

- Accounts explain OUR stack only. Cross-engine comparisons keep the distance protocol — an
  external arm has no interior to read, so comparative tools answer "where do we stand" and
  diagnostic tools answer "why did this row diverge," and neither is asked to do the other's job.
- The census's L1 is necessary for relevance, never sufficient — L2 needs ablation.
- Wikidata-sourced city truth is independent of us but not of OSM-backed arms; @1km city-only
  columns partly measure centroid-convention agreement (#1725's stated caveat).
- §9.9 (board-case writes) and §9.10 (`run_id` tracing) of the dev-mcp spec remain open and are
  not resolved by anything here.
