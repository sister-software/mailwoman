# Brainstorm response: the pair-prior comma-scope problem

**Date:** 2026-07-24 · **Re:** `2026-07-24-pair-prior-comma-scope-KIMI_HANDOFF.md` · **From:** pi
(claude), brainstorming in-repo against `task-8-report.md` receipts and the shipped
`neural/placetype-pair-prior.ts` / `pair-index-resolver.ts` sources. Every mechanism claim below
was verified against the code, not the docstrings alone.

## The one structural finding that reshapes the answer set

**The split comma-free recall needs is exactly the split v385 provably cannot make.** The target
population's failure is "dep-loc not separated from post town" — that IS the dead-tag deficit. Any
segmentation derived from the model's own first pass (Q1's pseudo-segments) therefore cannot
recover the target population: on `St Bedes Avenue Fishburn Stockton-on-Tees`, v385's best case is
one fused `locality` span over `Fishburn Stockton-on-Tees`, and a fused pseudo-segment probes as
one unit — no pair, no bias, same 0/69 as today, now with a second decode pass paid for it. Q1 as
framed (model-derived boundaries) is not merely risky, it is structurally inert on the population
it exists to serve. **The boundary source must be non-model.** This collapses Q1 and Q2 into a
single design, below.

Second, quieter finding from reading the FP anatomy: window mode's 79% FP at δ=10 is not a
window-probing problem, it is a **pair-geometry problem**. The current matcher is "two-sided,
order-free" — X and Y may be ANY disjoint windows anywhere in the string, distance unweighted
(`placetype-pair-prior.ts` module docstring, explicit). The confound board's own fixture rows show
why that floods: `childUsed` is embedded in the venue at string START and `parentUsed` is the
locality at string END — any-to-any matching connects them across the whole address. Real
register-style dep-loc pairs are _adjacent and suffix-anchored_. The geometry restriction is the
missing mechanism, it needs no new data and no training, and Q2's positional intuition is exactly
it.

## The proposal: anchored adjacent-pair mode (v1.1), as a strictly ordered probe chain

Ship the operator-pending comma-scoped v1 (segment-only) unchanged. v1.1 adds a third probe mode
that engages ONLY where segment mode is structurally inert:

```
probeChain (per parse, en-gb-gated as today):
  1. SEGMENT path — current code, untouched. Engages when ≥2 comma segments exist.
     Byte-stability on all comma'd inputs: identical by construction, not by measurement.
  2. ANCHORED-ADJACENT path — only when step 1 produced <2 windows (comma-free input,
     i.e. today's deterministic zero-matrix population; any bias here is strictly additive
     against a zero baseline, so byte-stability outside the target population is trivial).
  3. else zero matrix (today's comma-free behavior).
```

**Anchored-adjacent candidate construction** (reuses `buildWindows`, `probeWindowPair`, the
dual-key forms, and `applyWindowBias` verbatim — the delta is candidate SELECTION only):

1. **Parent anchors (post-town position), textual, no first pass needed:**
   - the 1..3-word window immediately LEFT of a postcode-shaped span (shape regex per
     `@mailwoman/codex` — the same `collectMatches` family `postcode-anchor.ts`/`postcode-repair.ts`
     already runs; shape suffices for a POSITION anchor, gazetteer membership optional upgrade), or
   - the string-final 1..3-word window (post town is string-final when no postcode is present).
2. **Child candidates:** the 1..3-word windows immediately left of the parent window —
   `child.endPos + 1 === parent.startPos`, longest-match first, with a left-maximality rule
   (if extending the child one word left ALSO pairs with the same parent, the longer window wins;
   kills partial-child probes like bare `cadbury` under `north cadbury`).
3. **Probe** the index on the adjacent (child, parent) under the existing 4 key forms. First hit →
   δ on the child span only (parent stays the model's strong `locality` read — unchanged from
   current behavior, which only ever biases the X role).
4. **Left-boundary soft signal** (optional tier, see Q5): child's left neighbor ∈ `{string start, house-number shape, street-suffix token}` upgrades confidence; left neighbor ∈ business-suffix
   lexicon downgrades/vetoes. Not required for v1.1's first measurement.

Probe cost: ≤3 parent windows × ≤3 child windows × ≤4 key forms ≈ ≤36 index probes, only on
comma-free en-gb inputs. Per-parse milliseconds constraint untouched.

**Why this should land near segment mode's FP profile, not window mode's:** enumerate the
confound anatomy. (a) Venue-embedded child at string start (`Queens Park Cafe, …`): the child text
is never immediately left of the post-town anchor — street text intervenes — so the adjacency rule
removes the entire dominant FP class by construction. (b) Street-embedded child mid-string
(`… Queens Park Academy Chestnut Avenue …`): same, not adjacent to the anchor. (c) The residual
class — street field verbatim-equal to a census child, sitting immediately before the locality
(`…, Queens Park, Chester`): fires, exactly as segment mode already does as-written (the 217/6500
= 3.338% documented floor). Expected venue-FP: ≈ segment's floor, 3–5%, versus window mode's
79–89%. Expected comma-stripped emit: window mode got 51/69 at δ=10 with ANY-geometry matching;
register-style rows are overwhelmingly adjacent dep-loc→post-town, so restricting to adjacent
pairs should retain most of it — predict 45–60/69, with δ=12 (anchored-only) in reserve if the
margin diagnosis (experiment 0) says the misses are margin-driven.

## Q1 — two-pass decode: principled or laundering?

**Laundering, and worse: structurally inert on the target population** (the finding above). The
refinement that WOULD be principled — derive pseudo-segments only from the model's CONFIDENT spans
(street/postcode/locality are healthy on GB even though dep-loc/venue are starved), fuse
low-confidence runs rightward, probe across those units — still fails recall, because the
dep-loc/post-town split lives inside what the model reads as one confident `locality` run. The
model's GB-weak heads (venue measured inert at 0/20 candidate positions) also can't be the veto
signal Q4's venue entry wants.

On the literature question: the known-good pattern for self-derived structure is iterated decoding
with agreement constraints / N-best rescoring — the first pass proposes a LATTICE or N-best list
and external evidence RESCORES, never resegments. Our additive-emission prior is already in that
family (rescore via bias, model keeps argmax ownership). What the literature does not support is
feeding a weak model's boundaries back as hard structure for its own second pass — that compounds
the first-pass error, which is precisely the handoff's "laundering" worry. Verdict: **do not build
the two-pass segmenter.** A lighter two-pass variant survives as v1.2 fallback ONLY if textual
anchors miss the bar: pass 1 unbiased → use its confident `locality` span as an ADDITIONAL parent
anchor for the same adjacent-pair probe (veto-free, anchor-only). That uses the first pass for
position, never for boundaries, and keeps fail-silent semantics (no confident locality → zero
matrix → today's behavior).

## Q2 — positional asymmetry: yes, and it is the primary mechanism, not a refinement

Exploit it exactly as the anchored mode does: probe only pairs where the parent occupies the
post-town position (pre-postcode or string-final) and the child immediately precedes it. The
suffix-region restriction ("after the last street-suffix token") falls out for free — the parent
anchor IS the suffix region.

On "model owns ambiguity" for odd orderings: the anchor gate is a condition on FIRING, never a
penalty. A genuinely odd ordering (post town first, dep-loc last) simply gets no bias — identical
to today's comma-free behavior, positive-evidence-only doctrine intact. If odd orderings later
prove common in real traffic, add mirrored anchors (parent at string start) as a separately
gated, separately measured tier — do not loosen the default.

## Q3 — per-pair δ by child-name specificity: real, but second-order; bucket, don't fit

The FP problem is positional, not magnitude-driven (δ=8 window still 53.5% FP; δ changes recall
AND FP together — the curves don't separate under δ alone), so specificity weighting cannot
substitute for the anchor gate. As a COMPLEMENT it's worth building, with the cheapest defensible
estimator:

- **Specificity score per child:** `log((df_place + 1) / (df_venue + 1))` where `df_place` = PPD
  CITY occurrences (already on disk, 9M rows, same source as the index) and `df_venue` = FSA
  establishment-name token occurrences + OSM/Overture street+poi name occurrences (both on disk —
  the task-6 fetch script and `mailwoman-data/{osm,overture,poi}`).
- **Three tiers, not a continuous formula:** place-only (multiplier 1.0) / mixed (0.7) /
  venue-heavy (0.4). Coarse buckets resist overfitting, each boundary is one pre-registerable
  knob, and the artifact header already carries `delta` — per-pair δ is a PIX1 schemaVersion-2
  record extension (u8 tier per pair, reader maps tier→multiplier), fully backward-compatible.
- Sequencing: build the anchored mode FIRST. Add tiers only if measured residual FP exceeds bar —
  pre-register that decision rule, don't pre-build the machinery.

PMI vs the count ratio: the ratio IS the plug-in PMI estimator up to the shared context-marginal
constant; with two contexts and add-one smoothing they're operationally identical at this
vocabulary size. Start with the ratio.

## Q4 — first-pass-span veto: yes as the secondary mechanism, fail-open, child-side only

Distinct value from Q1's segmentation: it attacks the RESIDUAL class (street field verbatim-equal
to a census child, adjacent to the anchor) — the one configuration the anchor gate structurally
cannot reject, because the geometry genuinely matches. The discriminator there is exactly "the
model reads this occurrence as `street`" (healthy head on GB, unlike venue).

Contract: veto a child candidate only when the first-pass argmax over its span is
`street`/`house_number`/`unit` with margin above a calibrated threshold. **Fail-open** (uncertain
→ allow) so recall never depends on the weak heads; **child-side only**, never veto the parent
(post town locality is the desired read); exclude `venue` from the veto set (measured inert —
0/20 — including it adds surface, no signal). Cost: one extra decode pass on comma-free en-gb
inputs only, or fold into the v1.2 two-pass variant. Sequencing: implement behind the same
pre-registered decision rule as Q3 — only if anchored-alone FP > 5%.

## Q5 — determiner/shape gate: mostly redundant; one narrow reuse survives

As a standalone gate it IS the marker list at larger scale, and dies the same way (task-6's
verdict: fixed successor tables were never a venue-boundary detector). The `The X Arms`
determiner cue covers a minority of the board and invites lexicon-maintenance treadmill. **Skip
the general shape gate.** The narrow reuse that survives: the poi-taxonomy business-suffix
lexicon as a SUCCESSOR veto generalizing `STRUCTURAL_MARKER_WORDS` (`queens park` + `cafe` →
suppress), and as a LEFT-neighbor downgrade in the anchored mode's optional tier. Both are
positional uses of the lexicon — evidence about where compounds end — not shape judgments about
the candidate itself. Build only on measured need, one lexicon entry-class at a time, each with
its own rationale line, per the module's own widening discipline.

## Q6 — ASR contextual biasing: the transplantable piece is the trie, not the subtraction

The subtractive-cost trick has no clean analogue here for a load-bearing reason: it exists to
charge back boosts granted to PREFIXES of a hypothesis that later leaves the trie. Our flat
per-position bias never grants partial-credit — a window probes exact folded keys or gets zero —
so the "hallucination off the trie" failure mode is absent by construction; there is nothing to
subtract. (Also: non-autoregressive BIO+Viterbi has no prefix-commitment point where the charge
would attach.)

What DOES transplant cleanly:

1. **Trie-driven candidate generation.** Walk the token stream through a prefix trie of the
   index's child/parent key sets; only maximal complete matches become candidates. Replaces the
   O(n·k)-window enumeration with longest-match-by-construction, and is the natural implementation
   of the left-maximality rule in the anchored mode. ~15k keys → tiny trie, browser-safe, CPU
   trivial.
2. **Span-coherent boost at match completion** — already implemented (`applyWindowBias`: B- on
   first piece, I- on the rest, Math.max). The arc independently reinvented the right mechanism;
   keep it.

## Q7 — framing: comma-scoped v1 + hybrid v1.1 is right; input-normalization is the weaker leg, and cheaply falsified

The #690 all-caps precedent is real but does not transfer: case folding is OFFSET-PRESERVING;
comma insertion is not. Inserting characters shifts every downstream character offset — the
pieces' offset contract that `computeGroupSegments`, the repair passes, and span projection all
depend on — so the normalization leg pays an offset-remapping tax through the entire decode path,
plus a full metamorphic-invariance re-verification of a component that now EDITS user input.
Worse, it solves the same segmentation problem with the same weak evidence: comma insertion IS
Q1's pseudo-segmenter wearing a normalizer hat, one layer up with a bigger blast radius. The
prior-probe framing keeps input untouched (byte-stability by construction) and evidence additive
(doctrine by construction).

**Bet placement:** prior-probe. The cheapest falsifier of the weaker option is the anchored-mode
sweep itself — ~50 lines of candidate-selection delta inside `placetype-pair-prior.ts`, zero new
dependencies, runnable on the existing zero-GPU harness against the three committed boards. If it
clears the bar, the normalization leg is dead by domination (equal recall, worse invariants,
higher cost). If it fails, its miss anatomy tells you exactly which boundary evidence is missing —
which is also the spec a comma-insertion segmenter would have to meet. Either way the experiment
pays for itself.

## Recommended experiment order (each zero-GPU, each pre-registered before it runs)

0. **Miss anatomy (diagnosis, no code):** of window mode's 18 misses at δ=10 comma-stripped —
   how many are marker-suppression artifacts (child followed by house-number shape), how many are
   margin, how many are non-adjacent geometry? And of segment mode's 217 residual FP — how many
   are the street-verbatim-child class? These two numbers set the v1.1 pre-registered bars and
   decide whether δ stays 10 or goes 12 (anchored-only).
1. **Anchored-adjacent mode** as specified above. Pre-registered bar (proposed, calibrated after
   experiment 0): comma-stripped ≥50/69 emit with ≥90% tag-correct; venue-FP ≤5%; golden 0/51;
   presets + golden us/fr byte-identical; segment-mode as-written numbers reproduced exactly
   (69/69, 217/6500) — the probe-chain ordering makes that a construction property, asserted not
   re-measured... then re-measured anyway.
2. **Only on miss:** δ=12 anchored-only re-sweep (FP is anchor-gated, so the δ↔FP coupling that
   killed window mode should be much weaker — measure, don't assume).
3. **Only on FP >5%:** Q4 child-side confident-street veto (fail-open), then Q3 specificity
   tiers, in that order — veto first because it's positional evidence; tiers last because they're
   distributional and the most overfit-prone.

## Pre-registered grading number, answered

Predicted against the handoff's bar: comma-stripped emit **50–62/69** at δ=10–12 anchored
(window's 51–62 restricted to adjacent geometry, minus non-adjacent genuine rows); tag-correct
**≥95%** (window's 96% at δ=10 improves when cross-string geometry errors are removed); venue-FP
**3–5%** (residual street-verbatim class ≈ segment's measured 3.338% floor); golden **0/51**
(board carries no index pairs by construction — 0 at every configuration ever measured);
presets/golden **byte-identical** (en-gb gate + comma-free applicability gate, asserted and
verified); segment as-written **unchanged** (probe chain tries segment first, anchored path is
unreachable when commas exist). The two numbers most likely to break the prediction: the 18-miss
diagnosis (if marker suppression is eating real children, recall lands ~40/69 and the suppression
list needs a segment-aware review first) and a residual-FP anatomy showing the street-verbatim
class is larger comma-free than as-written (then Q4's veto gets promoted from contingency to
critical path).
