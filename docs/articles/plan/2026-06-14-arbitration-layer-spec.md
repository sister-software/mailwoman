# Arbitration layer spec (#478) — pipeline ≥ v0 by construction

_2026-06-14. The arbitration capstone, re-specced after the reconcile retirement (#566), the grouper
fix (#565), and the coarse-placer (#244) reshaped the landscape. The original #478 issue is substantially
stale — its "untested / unwired / mock" framing predates this work. This is the current state, the
design, and — the load-bearing correction — the gate the reconcile retirement proved we need._

## Why this matters (unchanged)

Parity is a **pipeline property, not a model property**. The arena scorecard's `v0-only` column (whole
parses the old rules system gets that the neural pipeline drops) is the gap. Calibrated per-component
arbitration closes it **by construction** — the pipeline keeps whichever source is right per component,
so it can't score below v0 on any component v0 wins.

## Status audit — what the stale issue gets wrong

| #478 piece | issue says | actual state (2026-06-14) |
| --- | --- | --- |
| 1. Policy registry + config | "`applyPreferenceFilters` has zero tests; no config surface" | **DONE.** `core/policy/registry.test.ts` covers the dedup core (preferred-mode drop/fallback, merged survival, below-threshold no-trigger, both modes); `core/policy/from-config.ts` + `from-config.test.ts` are the loadable per-locale per-tag config surface. Wired into `core/parser/AddressParser.ts` via `proposal-pipeline.ts`. |
| 2. Reconcile top-k | "`ClassifierCandidate` is a mock; no production path emits it" | **DONE.** `core/pipeline/runtime-pipeline.ts` joint path emits real top-k via `parseWithLogits` + `aggregateSpanLogits`. |
| 3. Input-shape routing | "in docs since #15, unwired" | **OPEN.** The routing prior (clean→rules, noisy→neural, both-weak→abstain) is not wired as an arbitration prior. The signals exist: `kind-classifier`, `query-shape`, and now the `#244` coarse-placer (the abstention tier, M1+M2 shipped). |
| 4. Calibrated arbiter | "use the calibrated posterior" | **PARTIAL.** Isotonic calibration shipped (#59/#367) + the conformal interp radius (#569); the policy registry compares on `confidence`, but a unified calibrated-posterior currency across rule/neural sources is not yet the arbiter. |

**The two latent dependencies the issue names — and their current state:**

- **`parse()` vs `parseWithLogits()` divergence** (deep-dive §2.1): `parseWithLogits` (what reconcile
  consumes) skips the postcode/unit repair that `parse()` runs, so reconcile sees **unrepaired** labels.
  This must land first — a shared `buildTokens()` so both paths repair identically. **Still open.**
- **The grouper bundled the house number** (#565): FIXED this session. The grouper now proposes the bare
  street phrase, so reconcile separates street + house_number (US precondition 20% → 91.7%). Reconcile is
  viable again — but it is **OFF by default** (#566) until the gate below clears.

## The landscape shift this session — and why it rewrites the gate

#566 retired joint-reconcile as the default after an audit found it **broke the street+house_number
precondition on 77–84% of US addresses and fixed 0%** — worse-or-flat on every tag, venue included. The
catastrophe was **invisible for weeks** because every eval grades **raw neural** (`classifier.parse`),
never the assembled pipeline. That is the single most important input to this spec:

> **An arbitration layer that "can't score below v0 by construction" is only true if you GRADE THE
> ASSEMBLED PIPELINE against truth. Grading raw-neural per-tag F1 will hide an arbitration regression
> exactly as it hid the reconcile one.**

So #478's pre-registered gate, as originally written (arena re-run), is necessary but **not sufficient** —
it must run the assembled pipeline, and it must include the non-circular precondition/coordinate metrics
the geocoder campaign added, not just per-tag F1.

## The design

Arbitration is a per-component decision over candidate proposals from N sources (rule, neural, merged),
priored by input shape, decided on calibrated confidence, with abstention as a first-class outcome.

1. **Input-shape router (the prior).** `kind-classifier` + `query-shape` classify the input; the `#244`
   coarse-placer adds (script, coarse-region, OOD-abstain). The prior sets per-component default modes:
   - *clean structured address* → `rule_preferred` (v0's home turf).
   - *noisy / OOD-script / low rule-confidence* → `neural_preferred`.
   - *both sources weak OR coarse-placer abstains* → **abstain** to the resolver/admin tier (the
     geocoder's honest-radius downgrade, #244 + the interp calibration #569) rather than emit a confident
     wrong parse.
2. **Policy registry (the per-component decision).** The router's prior is overlaid by the loadable
   `from-config` policy (per-locale per-tag `mode` + `confidence_threshold`), so a tag can be A/B'd
   without code edits. `applyPreferenceFilters` is the dedup core — keep the preferred source when it has
   a survivor, fall back otherwise.
3. **Reconcile (the span-level joint decode).** With #565 landed and the repair-divergence fix, reconcile
   is a *candidate-producing* stage feeding the registry, not a silent default. Its value is OOD locales
   (it keeps a mangled street string intact); its danger is the US fusion (now fixed).
4. **Calibrated confidence (the currency).** All cross-source comparison uses the calibrated posterior
   (#59 isotonic), never raw logits — the only way rule-confidence and neural-confidence are comparable.

The two arbitration *sites* — the `AddressParser` proposal-pipeline (rule/neural via the policy registry)
and the `runtime-pipeline` (neural reconcile/argmax) — should converge on **one** registry-driven
arbitration applied to the union of candidates. Unifying them is the bulk of the remaining wiring.

## The gate (pre-registered, corrected)

Re-run with arbitration on, **grading the assembled pipeline** (not raw neural):

- **Arena capability** (the original #478 gate): `v0-only` → ~0 in every arena (clean/noisy/edge); every
  v0 win captured. `neural-only` retained. `both-fail` unchanged-or-better.
- **Assembled-pipeline precondition + coordinate** (the #566 lesson, the non-negotiable addition): on the
  non-circular holdouts (Travis E-911 + OA), street+house_number+postcode precondition does not regress
  vs argmax; geocode within-100m and the calibrated-radius coverage hold.
- **Per-locale F1 floors hold.** Demo presets stable.

Re-promoting reconcile to default is gated on this — specifically the precondition row, the one the
original re-gate (#427) omitted.

## Sequencing

1. **Land the repair-divergence fix** (shared `buildTokens()`) so `parseWithLogits` repairs like
   `parse()`. Prerequisite for any reconcile re-promotion.
2. **Wire the input-shape router** as the per-component prior (kind-classifier + query-shape + #244).
3. **Unify the two arbitration sites** on the policy registry over the candidate union.
4. **Run the corrected gate.** Promote per-component modes only where the assembled-pipeline gate clears.

## Scope guard (unchanged)

No retrain. No new classifiers. Wiring + tests + config over machinery that exists. The coarse-placer
(#244) is the one genuinely-new model and it is already built (M1+M2); here it is consumed as a routing
signal, not trained.

_References: `2026-06-10-DEEP-DIVE-REVIEW.md` §2; the reconcile retirement
`docs/articles/evals/2026-06-14-reconcile-retirement.md`; the interp calibration
`docs/articles/evals/2026-06-14-interp-radius-calibration.md`; the coarse-placer
`docs/articles/evals/2026-06-14-coarse-placer-milestone-1.md`._
