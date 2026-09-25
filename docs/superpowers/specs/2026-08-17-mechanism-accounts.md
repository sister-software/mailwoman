# Mechanism accounts — diagnosis implementation for mailwoman

**Date:** 2026-08-17 · **Status:** design of record; first increments landed (see §8) · **Epic:** #1716
**Origin:** the 2026-08-16 design conversation, the #1711 investigation that motivated it, and two
claim-tagged research reports (`docs/records/research/2026-08-16-*.md`).

## 1. The problem

Debugging this system today depends on whoever is reasoning about it at the time. The operator
described the cost: after every context reset, someone has to re-learn how addresses behave from a
narrow view, so the assistant's in-context reasoning has become a required part of improving the
product. Nobody wants that dependency.

Aggregate metrics cause that dependency. Distance-from-truth discards diagnostic information. The
#1711 city-only stratum reported `89.1% vs 96.9%, p = 0.084`, which read as underpowered with nothing
to investigate. The same stratum contained a six-row defect from a single mechanism
(`Weimar, Thüringen` → Weimar, **Texas**, 8,627 km, with the disambiguator in the input). It also
contained a truth-provenance flaw that flipped the sign of a column when corrected (#1725). Both
findings came from hand-tracing, an A/B, and one suspicious 0.23 m error. No repeatable process
produced them.

## 2. The two commitments (the anti-Pelias rules)

Pelias-style rule geocoders become rigid through their test suites. Each test encodes a belief about
how addresses work. New addresses force adjustments that must not break old tests, and the suite
eventually blocks change. A hand-authored taxonomy of failure classes would repeat the same mistake one
level up. Two commitments prevent it:

1. **Expectations pin outcomes, never mechanisms.** A board row asserts "this input resolves near
   here" and nothing else. No row ever asserts "fails with class X" or "takes path Y." Explanations
   are recomputed from the current system on every run and can change when the code changes. No
   mechanistic assertions accumulate that a better model of addresses would have to break.
2. **Failure shapes are mechanism states, never address shapes.** The vocabulary comes from the
   pipeline's own boundaries (_parsed-but-not-consulted_, _absent-from-candidates_,
   _present-but-outranked-by-term-T_, _excluded-by-G_, _evidence-silent_). Each term makes a claim
   about what the system did, never about how addresses work. The vocabulary is finite, derived from
   code structure, and versioned with the code.

## 3. The account

An account is generated per row on every run from facts the system already computes. It records what
the parse produced, what each evidence channel fed, what retrieval returned, which constraints were
applied, which checks fired, and what won on which score terms. It also records the smallest
counterfactual that flips the row. Every line can be checked against execution, and the account
contains no narrative.

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

Accounts cannot explain what happens inside the weights, because the weights hold no recoverable
reasons. Accounts therefore describe the boundaries: what was fed, retrieved, conditional, and ranked.
When an account ends at "the model chose X with margin m and every channel silent," that is itself
the class: the model had no evidence. The fix is to supply evidence rather than to inspect the logits.

## 4. Shapes and confidence

Classification is a **posterior with abstention**, never a bare label. The operator added this on
2026-08-16, because a hard label amounts to an unjustified confidence of 1.0.

- **v1 — stage-fact matching.** Each shape predicts a pattern of boundary facts. A row's posterior is
  scored by which predictions the observed facts match. The method is transparent, needs no training,
  and reports itself as uncalibrated. Ambiguity is useful: a posterior split evenly between
  `constraint-not-consulted` and `evidence-starvation` points to the next cheapest probe (feed the
  channels and watch the order).
- **v2 — Mondrian (class-conditional) split conformal** over the human triage ledger. Marginal
  conformal loses coverage on rare classes in measurement. Per-class calibration restores coverage
  and makes vocabulary growth cheap: a new shape needs only its own ~20–40 triaged rows, and existing
  guarantees are unchanged. **A novel case creates a class:** a case that conforms to no known shape
  gets a conformal p-value that reports "new shape" instead of a forced classification. Calibration
  uses a rolling window because triage standards drift, and it expires with the tree fingerprint.
  Skip evidential deep learning. (Research grounding: decoder-interpretability report §4. That report
  notes that no literature treats a _changing_ diagnosis vocabulary as solved.)

## 5. The three coverage checks

Three checks cover what outcome tests cannot see. Soft mechanisms are designed to degrade without
error ("features, never overrides"), so a test that asserts outcomes cannot detect their failure:

| check                                                 | asserts                                                   | catches                                                                                 | status                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **mailfail** (`eval-harness/fixtures/mailfail.jsonl`) | must not activate (no-component / no-resolve / no-throw)  | garbage handled as garbage                                                              | shipped 2026-08-02                                                               |
| **activation census** (#1719, `mwdev_census`)         | must activate somewhere (L0 ran / L1 signaled / L2 moved) | inert mechanisms — the house's most-repeated failure class (#1699, #1703, #1349, R5)    | L0/L1 shipped; first run found 2 inert, both verified deliberate and allowlisted |
| **fragile-pass ledger** (#1720)                       | activated for the right reason                            | compensated defects (XOR signature: fixing one of a canceling pair turns the board red) | designed; needs accounts                                                         |

Census rules: zero at L1 across the set is a failure unless the mechanism is allowlisted with a reason
a reader can check. If an allowlisted mechanism fires, its reason is stale, and the census reports it
as an error. The first run over the 558-row board measured this baseline: **364 rows (65.2%) parse
with every present evidence channel silent** (gazetteer fires 158/558, country 141/558, anchor
54/558).

The ledger **pre-registers** which passing rows may legitimately flip when a specific mechanism is
fixed. A fix that exposes a compensated defect can then pass the D-rule instead of being reverted as
a regression.

## 6. The coherence ladder (the checker)

The checker scores the **assembled output**, the joint record the resolver emits. The decoder never
sees that record, so the two components fail independently. The output is a verdict per component
(`locality confirmed / region contradicted`), never one scalar. This follows the Google confirmation
levels and USPS DPV pattern. The accept/review/reject band already exists as Fellegi–Sunter's
clerical band in `packages/match`.

- **Rung 0 — deterministic containment** (#1717): `ancestry(winner) ∌ parsed region` is a boolean
  computed by one PARENT_OF walk without a model. It fixes the Weimar class. It ships behind a flag
  first, re-ranks behind a change, and passes the D-rule before it is on by default.
- **Rung 1 — counting**: p(parent|child) as literal hierarchy-table lookups (SDValidate shape), with
  smoothing only where sparsity measurably hurts.
- **Rung 2+, conditional** (#1724): a masked-cell model (MCM/TURL-shaped) over assembled records that
  reuses the BIO masking infrastructure. It is built only for coherence the hierarchy cannot express,
  and only if it beats the rung-1 baseline in an eval. (An "autodecoder" was investigated and
  rejected because it belongs at a later rung. See coherence report §1.)
- **Structural guard against self-reinforcement**: any checker trains on the gazetteer and labeled
  corpus only. Resolver outputs are scored and never used as supervision. Two audits run
  continuously: a round-trip fixpoint through `@mailwoman/formatter`, and adversarial validation with
  a real-vs-assembled classifier, where an AUC well above 0.5 itself indicates a defect.

## 7. Model-side instruments (#1723)

The instruments ship in this order:

1. Evidence-silent predicate. It needs no interpretability and has shipped (§8).
2. Linear country probe and logit-lens decision depth. Together they detect a model/resolver
   contradiction, such as hidden states that read "DE" while the resolver commits US.
3. Channel-reliance board metric (paired-input interchange, ERASER sufficiency and
   comprehensiveness per checkpoint).
4. Exhaustive patch-sweep tool (~1,700 sites per input at this depth, seconds per case).
5. Conditional: an IIT country register and at most one exploratory SAE run.

The following are not planned, and are recorded so they are not proposed again: hard concept
bottlenecks (they would have been wrong for Weimar, because they should flag bypass decisions rather
than prevent them), RRR gradient penalties, and attention-as-explanation.

## 8. What is already landed (as of 2026-08-17)

- `variable_isolation` rename. The confound check now claims setup hygiene rather than causation.
  The underlying vocabulary bug was #1715.
- `evidence.ts` records absent, silent, and fired channel states plus the starvation flag on every
  `mwdev_trace` row (#1718).
- `mwdev_census` reports L0/L1 per mechanism, inert verdicts, and an allowlist that the census itself
  checks for stale entries (#1719).
- Panels **v2.1 / v3.1** re-source the 25 board-sourced city-only truth rows from Wikidata. The
  corrected measurement inverted the @1km column (#1725, closed).
- Run store and recorded arms (#1714). Every comparison can be replayed by `run_id`, which makes it
  possible to generate accounts over past runs.
- `mwdev_diagnose` v1 (#1722) produces per-row accounts over the parse / evidence / retrieval /
  outcome boundaries. It includes seven mechanism-state shapes as documented predicates, the
  five-change counterfactual sweep, and `by_shape` aggregation. v1 reports the set of matching shapes
  with each predicate attached and `calibration: "none"`, rather than the normalized posterior §4
  describes. The scoring layer arrives with the v2 conformal calibration, which gives a posterior's
  numbers their meaning. Building v1 exposed a coverage limit: the resolver-interior trace (#1721)
  records only the walk's own `#lookupAndPick`. A row answered by the post-walk span-rescore
  therefore carries a resolved coordinate beside an empty lookup list. Accounts report that case
  explicitly so the empty list is not read as "no retrieval happened".

## 9. Sequencing

`now` → #1717 (flag-only), remaining #1718 production bit
`next` → #1721 (resolver interior in the trace), #1720 (ledger over accounts), census L2
`then` → #1722 (`mwdev_diagnose` v1), #1723 (probe + reliance metric)
`later` → #1722 conformal v2, #1723 patch sweep, #1724 rungs 1+

## 10. Bounds

- Accounts explain only this repo's stack. Cross-engine comparisons keep the distance protocol,
  because an external arm has no interior to read. Comparative tools answer "where do we stand",
  diagnostic tools answer "why did this row diverge", and neither replaces the other.
- The census's L1 is necessary for relevance but never sufficient. L2 needs ablation.
- Wikidata-sourced city truth is independent of us but not of OSM-backed arms; @1km city-only
  columns partly measure centroid-convention agreement (#1725's stated caveat).
- §9.9 (board-case writes) and §9.10 (`run_id` tracing) of the dev-mcp spec remain open and are
  not resolved by anything here.
