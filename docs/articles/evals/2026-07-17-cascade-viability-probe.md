# 2026-07-17 — Cascade-viability probe: shape-routed delegation is falsified; "easy-looking" is the hardest class

The delegation vision under test: a query-shape front stage that handles easy shapes deterministically
(no encoder pass) and escalates the rest to the full model — the cascade form of the mixture idea, made
principled by calibrated confidence. This probe measures it on the four standing arenas: what fraction a
confidence-gated front tier would absorb, how often its deterministic parse matches gold, and how often
the full model matches gold **on those same rows**. Runner: `scratchpad/cascade-probe.run.ts` (kinds via
`classifyKindSync` at confidence ≥0.7; handlers: `postcode_only` → the format-hit span, `locality_only` →
bare locality or the doubleton split at a trailing region abbreviation).

## The numbers

| arena            |            absorbed | front-tier exact | model exact (same rows) |
| ---------------- | ------------------: | ---------------: | ----------------------: |
| golden-us (2660) |          209 (7.9%) |            0.124 |                   0.689 |
| golden-fr (1546) |           34 (2.2%) |            0.000 |                   0.559 |
| golden-adv (49)  |            4 (8.2%) |            0.500 |                   0.750 |
| parity (376)     |         105 (27.9%) |            0.095 |                   0.390 |
| **overall**      | **352/4631 (7.6%)** |        **0.108** |               **0.588** |

The front tier is **5× worse than the model on the very rows the shape detector calls easy** (0.108 vs
0.588 exact). Latency upside, even if it were free: 7.6% of encoder passes ≈ 0.5 ms saved per average
query. Falsified on both axes at once.

## The mechanism — shape simplicity IS semantic ambiguity

The failure samples say why, and it is not a tunable defect:

```
"Hummingbird Ln VT"        detector: locality_only → front tier: locality "Hummingbird Ln"
                           gold: street "Hummingbird Ln", region VT
"Finel Hollow Road, VT"    doubleton split → locality "Finel Hollow Road"
                           gold: STREET "Finel Hollow Road"
"Vermont, USA"             detector: locality_only → gold: region + country
```

The inputs that LOOK easy — short, undecorated toponyms — are exactly the class the entire Track B /
fr-fragment arc has been about: **a bare name gives no structural evidence of whether it is a street, a
locality, or a region.** Deciding that requires knowing which names are which — the atlas or the model —
which is precisely what a shape detector, by construction, does not have. On this domain, ease-of-shape
and ease-of-parse are anti-correlated: long inputs are self-disambiguating (a house number licenses the
street, a postcode anchors the locality); short inputs are pure ambiguity. **The model earns its keep
most on the smallest queries** — the opposite of the cascade's premise. Note the model itself scores only
0.588 on the absorbed rows: they are hard for everyone; the front tier just makes hard rows 5× worse.

This is the third instrument to convict shape-conditioned routing this week: the queryShape locality bias
(M1: −7.8 locality, venue absorption), the deletion counter-case (`New York, NY` needing the bias), and
now the cascade probe. The consistent shape: **conditioning behavior on a shape detector fails wherever
the shape is ambiguous, and the ambiguous cases are the ones that matter.**

## What survives

- **`postcode_only` fronting** is fine but nearly empty here (2 rows; more in autocomplete traffic) and
  the postcode binary already serves it downstream — no architecture change needed.
- **Atlas-verified fronting** — absorb a bare name only after a candidate-table hit confirms it is a
  known locality — is the one honest form left. But that front tier is a gazetteer lookup, i.e. the
  resolver; the model + atlas channel already perform that arbitration with learned weighting (M1 priced
  the channel at +10.4). Building it as a bypass buys ~0.5 ms and a second code path to keep honest.
- The scoped doubleton bias (PR #1148, four-line guard on a soft prior) remains the template for where
  shape knowledge helps: small, priced, scoped — inside the model's decode, not in front of it.

## Verdict

Do not build the shape-routed cascade. Keep the single-model + soft-channels architecture; spend the
delegation instinct on the resolver-as-arbiter direction (#727 stage-2), where the atlas judges _parses_
rather than _routing inputs_. The probe cost one eval sweep and closes the question with receipts.
