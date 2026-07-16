---
title: "#727 Phase 4a — resolution reranking cannot collect the headroom, and the reason is structural"
---

# Phase 4a verdict — the rerank thesis has a circularity

**Status: VALID measurement (the instrument was checked first this time). Result: NULL, with a
mechanism.** The reranker is built, tested, and correct. Resolution evidence cannot adjudicate the
class the arc targets — not because the signal is weak, but because it does not exist for those
inputs.

## The measurement

Full geocode cascade — WOF admin + per-state situs/interpolation + **BAN national register** +
**BAN street-centroids (#1042)** + OSM rooftop. Wiring copied verbatim from
`mailwoman/eval-harness/gauntlet/harness.ts` (the cascade production actually runs).

| triaged parity (n=267) |                               | Paris fixture (n=63) |                                   |
| ---------------------- | ----------------------------- | -------------------- | --------------------------------- |
| seg@1                  | 0.5768                        | seg@1                | 0.7619                            |
| **rerank@1**           | **0.5768 (+0)**               | **rerank@1**         | **0.7460 (−1)**                   |
| oracle@5               | 0.7228                        | oracle@5             | 0.9048                            |
| fired                  | 1 fixture (0 fixed / 0 broke) | fired                | 1 fixture (0 fixed / **1 broke**) |

## Why — the instrument check that Phase 4a's first attempt skipped

**Evidence rate: the share of fixtures where ANY hypothesis reached street-level resolution.**

| locale                      | n    | evidence rate |
| --------------------------- | ---- | ------------- |
| US                          | 75   | **0.01**      |
| ZZ                          | 53   | 0.00          |
| FR                          | 29   | 0.03          |
| NL                          | 18   | 0.22          |
| DE                          | 13   | 0.23          |
| NZ / AU / NO / PT / PL / RO | 5–22 | **0.00**      |

Paris fixture, FR, with `ban/street-centroids-fr.db` present and loaded: **314 hypothesis geocodes →
`admin` 314, `street` 1.** An evidence rate of **1.6%**.

## The circularity

The arc targets **bare fragments** (66% of street failures, night-3 partition). A bare fragment:

- has **no house number** → the address-point tier cannot fire (it is keyed by number),
- has **no locality** → the street-centroid tier has nothing to scope a street lookup by,
- therefore resolves to an **admin centroid** — _identically, for every hypothesis in the k-best list_.

So the resolver returns the same evidence for the right parse and the wrong one. It is not that the
signal is noisy; **there is no signal**. Resolution evidence can only adjudicate addresses that are
already resolvable — which are largely the ones the parse gets right anyway.

The −1 on Paris is the whole story in miniature: the single fixture where evidence existed, the
reranker fired, and it was wrong.

## What this does and does not overturn

**Does NOT overturn:** the k-best headroom is real and measured — oracle@5 **0.723** (parity) and
**0.905** (Paris) against a shipped 0.573. The span decode genuinely puts the right answer in the
list. That stands.

**Does overturn:** the assumption — mine and the arc's, stated on 2026-07-15 — that _"the arbiter for
the k-best list is the resolver."_ For contextful addresses the resolver could arbitrate, but those
barely need it. For the bare fragments that need it, the resolver is blind. The arbiter has to be
something else.

## The direction this points (NOT chased here — that would be signal #3 on a losing streak)

The resolver answers _"where is this?"_ The useful question for reranking a bare fragment is
_"is this a street name at all?"_ — an **existence check against the gazetteer/BAN name index**, not
a geocode. `ban/street-centroids-fr.db` contains every FR street name; asking whether
`Rue de Rome` appears in it needs no locality and no house number.

That is a lexicon lookup, not resolution — a different signal with a different failure surface, and
it interacts directly with #1142 (the `matched` vs `importance` split: "is this a known name" is
_exactly_ the `matched` bit that today's multiply destroys). It earns a probe only with the same bar
the others got: a pre-registered gate and a measured win.

**Two signals have now failed** (plausibility veto: inert; resolution specificity: −16, rewards the
locality-reading failure mode). Per the treadmill guard, a third goes to the operator before it goes
to a branch.

## Phase 4 re-plan

- **4a rerank — DONE, negative.** Code stays (7 tests, sound); it is inert by default because
  `maxResolve` only vetoes country-centroids, which is a real if rare guard. It ships nothing on its
  own.
- **4b (isotonic ambiguity gate)** — still valuable, and now _more_ so: if evidence cannot pick the
  winner, calibrated confidence is what lets a caller know the answer is uncertain. Unblocked.
- **4c (option C: kind-posterior + recall-weighted loss)** — now the **primary** lever for the
  bare-fragment class, not a follow-up. It attacks the parse where evidence cannot.

**And the standing fact this does not change:** the v7 street floor is **0.90**. seg@1 is 0.577,
oracle@5 is 0.723. Even a perfect reranker would have landed short. The floors need 4c and/or more
training — the decode was never going to get there alone.
