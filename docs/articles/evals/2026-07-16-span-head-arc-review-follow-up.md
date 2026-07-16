# REPLY 3: adjudication and the converged plan

**Re:** _The segmentation thesis_ + REPLY (reviewer A, with addendum) + REPLY_2 (reviewer B)
**Date:** 2026-07-16

The three reviews converge on the architecture verdict: the span head is sound, the list is the
product, the resolver-as-arbiter is dead for the class that needs arbitration, and the highest-EV
next move is data, not architecture. What remains are two factual corrections, one open gate
question, and a sequencing decision. This settles all four.

---

## 1. Corrections adopted

**"Generative" → discriminative.** Reviewer B is right: the semi-Markov CRF is a conditional
(discriminative) model — a distribution over segmentations _given the input_, normalized by the
partition function. Reviewer A's substantive point survives the label fix untouched: the artifact
is a **segmentation distribution**, and consumers plug into the list rather than into a single
decode. We adopt the reframing with the corrected term.

**MBR, corrected to its deployable form.** Reviewer A's formulation scored candidates against gold
`y*`, which only exists in eval — reviewer B is right that this isn't shippable as written. But the
deployable approximation doesn't need gold: **consensus MBR** scores each k-best candidate by its
expected agreement with the _rest of the list_ under probabilities renormalized over the k-best list:

```
risk(ŷ) = Σⱼ p(yⱼ) · (1 − street_span_agreement(ŷ, yⱼ))     over the k-best list itself
```

Pick argmin. No gold, no training, and the partition function already gives the within-input
normalization MBR would need if the runtime exposes full sequence log-probs; otherwise this is a
k-best consensus heuristic using renormalized k-best scores. Intuition for why this can beat
Viterbi here: when the correct street reading appears in slightly different boundary variants
across ranks 2–5, those variants vote for each other's shared span while the rank-1 locality-refusal
stands alone. Failure mode: a majority-wrong cluster can outvote a lone correct candidate. It goes
into the diagnostics tier, pre-registered: MBR@1 vs seg@1 on parity and Paris, same instruments.

## 2. The gate question (thesis §8 Q3) — settled for now

Reviewer B's earlier suggestion (coordinate-acceptability as the honest gate) meets reviewer A's
counter: on bare fragments the coordinate gate degenerates into the parse gate — no locality means
centroid geocode means wrong by construction. Both are right about different classes. Resolution:
**keep 0.90 parse-tag as the excision gate, add coordinate-acceptability as a diagnostic.** If the
diagnostic shows failures are recoverable downstream while tag parity fails, that reopens the
question — with data instead of taste. Until then the gate debate is moot: no candidate gate passes
while the polarity class stands, so the gate isn't the blocker. The polarity class is.

## 3. Name-index channel — scope narrowed

Adopted with reviewer B's constraint as a hard rule: **positive bias only, never a veto.** Negative
evidence from an incomplete register recreates the Pelias deletion in soft form — real unseen
streets get punished globally, which is §6's scar tissue with extra steps. Reviewer A's locale-tier
matrix is required before implementation (BAN: yes; BAG: yes; TIGER: spatial, needs state scoping,
which re-introduces a locality dependency; ZZ: absent). Score comparability with the CRF's
normalization gets checked in review, per the thesis's own incomparable-scores antipattern.

Longer-view framing: BAN is the first proving ground, not the abstraction. The abstraction is a
source-tiered street-name evidence provider:

```
StreetNameEvidenceProvider.lookup(surface, locale, scope?)
  → { exists, confidence, source, sourceTier, scopeLevel, frequency }
```

Tier A sources (authoritative street/address registers: BAN, BAG-like systems) can support eval,
augmentation, and positive name-index bias. Tier B sources (road/address-range data: TIGER) can
support scoped evidence only; global `"Main St"` evidence is weak, while `"Main St" + state/ZIP`
may be useful. Tier C sources (admin gazetteers such as WOF) support locality/region/country
evidence, not street existence; they are the famous-street-as-place trap. Tier D sources (OSM-like
broad data) are useful for experiments and coverage gaps, but licensing, attribution, and local
quality must gate product use. No tier supplies global negative evidence.

## 4. Option C — demoted, and conditioned

All three reviews now rank BAN augmentation above option C. Reviewer A's self-consistency critique
stands regardless: the kind classifier shares the encoder, so feeding its posterior back risks the
model agreeing with itself on exactly the failing class. If option C is ever built, it conditions
on the external `query-shape` structural signal, not the learned kind head.

## 5. The converged sequence

Everything below Tier 2 is gated on what the tiers above it show. Falsifiers pre-registered here.

**Tier 0 — documentation, before the next draft.**
Edit §2's governing claim from "no mechanism to constrain the next token" to: _nothing in the
objective or decode rewards segment-level coherence, and the prior on bare toponyms is wrong._
Same evidence, no false claim about representations. Also implement reviewer A's harness baseline
assertion (>10% deviation from the last registered baseline refuses to produce a report) — before
Tier 1, so the diagnostics below can't ship a broken number. Both §7 near-misses would have been
caught by it.

**Tier 1 — no-training diagnostics, in parallel.**

- **(a) Regression-class cross-tab** on parity: token-correct/span-wrong vs token-wrong/span-correct,
  per fixture. +2 net overall against +15 on Paris means the span decode is losing somewhere;
  name the class before shipping. An hour of analysis on existing results. _Falsifier for
  shipping-by-default: if the regression class is "street hallucinated where none exists," that's
  a new failure mode and the flag stays on._
- **(b) Gazetteer-off run** on Paris bare/famous. If famous streets sit in WOF as places, the
  channel injects the locality vote and the resolver reinforces the model's error — a learned
  feedback loop, the Pelias trap in soft form. One command on existing fixtures.
- **(c) BAN-sampled bare-fragment eval**, thousands of fixtures, CIs on every class. Turns the
  per-class table from anecdote into evidence (3/15 has a 95% CI of roughly 4–48%), and settles
  reviewer A's taxonomy question — whether the 17 refusals and 13 truncations are one
  particle-triggered behavior or two — at a scale where the split is legible. The label policy is
  fixed up front: the full street phrase is `street`, including affix, particle, apostrophe,
  hyphenated compound, and date-name material (`Rue de`, `Avenue des`, `11-Novembre-1918`, etc.).
- **(d) Consensus-MBR@1** over the existing k-best, formulation in §1 above.

**Tier 2 — the BAN bare-street training shard.** 5–10% mix, short schedule, graded on the Tier-1c
eval set. The same extraction script may produce both train and eval, but the split must be
source-disjoint by normalized street surface before sampling, not merely row-disjoint. Add a
full-address/contextful regression guard alongside the bare-fragment read; the shard only ships if
it improves fragments without degrading normal addresses. _Pre-registered read: if the 17
locality-refusals flip to street, the training-distribution hypothesis holds and option C becomes
reinforcement, not rescue. If they don't move, the hypothesis is falsified and option C is
vindicated as the correct level. Either result decides something the current analysis cannot._

**Tier 3 — conditional on Tiers 1–2.** Name-index rerank (positive bias only) to collect list
headroom; option C (external kind signal) only if polarity survives augmentation; MBR as the
default consumer only if Tier-1d shows a real margin. Tune any name-index bias on held-out dev,
not the Paris target fixture; positive-only evidence can still over-rank street readings if the
offset is hand-fit to the known failures.

## 6. Ship decision

Unanimous across reviews: the span decode ships **behind a flag**, valued for the list and the
target class (+23.8pp Paris, oracle@5 0.905, +0.5% latency), not for rank-1 parity (+0.75pp, inside
noise). It becomes the default path when a consumer collects the headroom — and Tier 1a decides
whether the flag has a regression cost we haven't named yet.

---

One closing note on the meta-question that started this thread. Three reviewers looked at this and
none found an ML-101 error — they found a discriminative/generative label, an eval-only loss in a
proposal sketch, and a framing sentence. The instrument checks in §7, the pre-registered gates, and
the digit-atomicity kill are the opposite of not knowing the fundamentals. The blocker was never
"encoder too small": it's three interacting issues — a training distribution that underrepresents
bare streets, an objective that rewards token correctness over span utility, and resolver evidence
that is blind exactly where arbitration is needed. The plan above tests them in that order.
