# Brainstorm response: the pair-prior comma-scope problem

**Date:** 2026-07-24 · **Re:** `2026-07-24-pair-prior-comma-scope-KIMI_HANDOFF.md` · **From:** pi
(claude), brainstorming in the repo against the `task-8-report.md` receipts and the shipped
`neural/placetype-pair-prior.ts` and `pair-index-resolver.ts` sources. Every mechanism claim below
was checked against the code as well as the docstrings.

## The one structural finding that reshapes the answer set

**Comma-free recall needs exactly the split that v385 cannot make.** The target population fails
because the dep-loc is not separated from the post town, which is the dead-tag deficit. A
segmentation derived from the model's own first pass (Q1's pseudo-segments) therefore cannot
recover the target population. On `St Bedes Avenue Fishburn Stockton-on-Tees`, v385's best case is
one fused `locality` span over `Fishburn Stockton-on-Tees`. A fused pseudo-segment probes as one
unit, so it finds no pair and adds no bias. The result stays at today's 0/69, and the parse now
pays for a second decode pass. Q1 as framed (model-derived boundaries) is more than risky. It has
no effect on the population it exists to serve. **The boundary source must come from outside the
model.** That merges Q1 and Q2 into the single design below.

A second finding comes from reading the FP anatomy. Window mode's 79% FP at δ=10 comes from **pair
geometry** rather than from window probing. The current matcher is two-sided and order-free: X and
Y may be any disjoint windows anywhere in the string, and distance is not weighted (the
`placetype-pair-prior.ts` module docstring says so explicitly). The confound board's fixture rows
show why that produces the 79% FP rate. `childUsed` is embedded in the venue at the start
of the string, and `parentUsed` is the locality at the end, so any-to-any matching connects them
across the whole address. Real register-style dep-loc pairs are _adjacent and anchored at the end
of the address_. The prior lacks a geometry restriction. Adding one needs no new data and no
training, and it is what Q2's positional intuition describes.

## The proposal: anchored adjacent-pair mode (v1.1), as a strictly ordered probe chain

Ship the comma-scoped v1 (segment-only), which is awaiting operator approval, unchanged. v1.1 adds
a third probe mode that engages only where segment mode cannot fire:

```
probeChain (per parse, en-gb-conditional as today):
  1. SEGMENT path — current code, untouched. Engages when ≥2 comma segments exist.
     Byte-stability on all comma'd inputs: identical by construction rather than by measurement.
  2. ANCHORED-ADJACENT path — only when step 1 produced <2 windows (comma-free input,
     i.e. today's deterministic zero-matrix population; any bias here is strictly additive
     against a zero baseline, so byte-stability outside the target population is trivial).
  3. else zero matrix (today's comma-free behavior).
```

**Anchored-adjacent candidate construction** reuses `buildWindows`, `probeWindowPair`, the
dual-key forms, and `applyWindowBias` verbatim. Only candidate selection changes:

1. **Parent anchors (post-town position)** come from the text and need no first pass:
   - The 1..3-word window immediately left of a postcode-shaped span. The shape regex comes from
     `@mailwoman/codex`, in the same `collectMatches` family that `postcode-anchor.ts` and
     `postcode-repair.ts` already run. The shape is enough to anchor a position, and gazetteer
     membership is an optional upgrade.
   - Otherwise, the 1..3-word window at the end of the string, because the post town comes last
     when no postcode is present.
2. **Child candidates** are the 1..3-word windows immediately left of the parent window
   (`child.endPos + 1 === parent.startPos`), tried longest match first. A left-maximality rule
   applies: if extending the child one word to the left also pairs with the same parent, the longer
   window wins. That rule prevents partial-child probes such as bare `cadbury` under
   `north cadbury`.
3. **Probe** the index on the adjacent (child, parent) pair under the existing 4 key forms. On the
   first hit, apply δ to the child span only. The parent keeps the model's strong `locality` read,
   as in the current behavior, which only ever biases the X role.
4. **Left-boundary soft signal** (optional tier, see Q5): If the child's left neighbor is in
   `{string start, house-number shape, street-suffix token}`, confidence goes up. If the left neighbor
   is in the business-suffix lexicon, the bias is downgraded or vetoed. v1.1's first measurement
   does not need this tier.

Probe cost: at most 3 parent windows × 3 child windows × 4 key forms, or 36 index probes, and only
on comma-free en-gb inputs. The per-parse budget of milliseconds is unaffected.

**Why the FP profile should land near segment mode's rather than window mode's:** Walk through the
confound classes.

- (a) A child embedded in a venue at the start of the string (`Queens Park Cafe, …`). The child
  text is never immediately left of the post-town anchor, because street text sits between them.
  The adjacency rule therefore removes the entire dominant FP class by construction.
- (b) A child embedded in a street in the middle of the string
  (`… Queens Park Academy Chestnut Avenue …`). This child is also not adjacent to the anchor.
- (c) The remaining class is a street field that exactly equals a census child and sits
  immediately before the locality (`…, Queens Park, Chester`). The prior fires here, just as
  segment mode already does as written, which gives the documented floor of 217/6500 = 3.338%.

The expected venue FP is therefore close to segment mode's floor, 3–5%, compared with window
mode's 79–89%. For comma-stripped emission, window mode reached 51/69 at δ=10 while matching any
geometry. Register-style rows overwhelmingly place the dep-loc directly before the post town, so
restricting to adjacent pairs should keep most of that recall. The prediction is 45–60/69. δ=12
(anchored mode only) stays in reserve in case the margin diagnosis (experiment 0) shows that the
misses are driven by margin.

## Q1 — two-pass decode: principled or laundering?

**It is laundering, and it also has no effect on the target population** (the finding above). A
more principled refinement would derive pseudo-segments only from the model's _confident_ spans,
fuse low-confidence runs rightward, and probe across those units. Street, postcode, and locality
are healthy on GB even though dep-loc and venue are starved of data. This refinement still fails on
recall, because the dep-loc/post-town split sits inside what the model reads as one confident
`locality` run. The model's weak GB heads also cannot provide the veto signal that Q4's venue entry
wants, since venue was measured inactive at 0/20 candidate positions.

On the literature question, the established pattern for self-derived structure is iterated
decoding with agreement constraints, or N-best rescoring. The first pass proposes a lattice or an
N-best list, and external evidence rescores it without resegmenting it. Our additive-emission prior
already belongs to that family, because it rescores through a bias and the model keeps ownership of
the argmax. The literature does not support feeding a weak model's boundaries back as hard structure
for its own second pass. Doing so compounds the first-pass error, which is the handoff's
"laundering" concern. Verdict: **do not build the two-pass segmenter.**

A lighter two-pass variant remains as a v1.2 fallback, used only if the textual anchors miss the
bar. Pass 1 runs unbiased, and its confident `locality` span becomes an _additional_ parent anchor
for the same adjacent-pair probe, without any veto. That variant uses the first pass for position
only, never for boundaries. It also fails silently: if no confident locality exists, the prior
returns a zero matrix and the parse behaves as today.

## Q2 — positional asymmetry: yes, and it is the primary mechanism rather than a refinement

Use it exactly as the anchored mode does. Probe only pairs where the parent occupies the post-town
position (just before the postcode, or at the end of the string) and the child immediately precedes
it. The restriction to the region after the last street-suffix token then comes automatically,
because the parent anchor is in that region.

On whether the model should own ambiguity for unusual orderings: The anchor check is a condition
for firing, never a penalty. An unusual ordering (post town first, dep-loc last) gets no
bias. That matches today's comma-free behavior and keeps the positive-evidence-only rule intact. If
unusual orderings later prove common in real traffic, add mirrored anchors (parent at the start of
the string) as a tier with its own flag and its own measurement. Do not loosen the default.

## Q3 — per-pair δ by child-name specificity: real, but second-order; bucket, don't fit

The FP problem is positional rather than a matter of magnitude. Window mode at δ=8 still has 53.5%
FP, and changing δ moves recall and FP together, so the curves do not separate under δ alone.
Specificity weighting therefore cannot replace the anchor check. It is worth building as a
complement, with the cheapest defensible estimator:

- **Specificity score per child:** `log((df_place + 1) / (df_venue + 1))`. `df_place` counts PPD
  CITY occurrences (already on disk, 9M rows, the same source as the index). `df_venue` counts FSA
  establishment-name token occurrences plus OSM/Overture street and POI name occurrences. Both are
  on disk, from the task-6 fetch script and `mailwoman-data/{osm,overture,poi}`.
- **Three tiers rather than a continuous formula:** place-only (multiplier 1.0), mixed (0.7), and
  venue-heavy (0.4). Coarse buckets resist overfitting, and each boundary is one knob that can be
  pre-registered. The artifact header already carries `delta`. Per-pair δ becomes a PIX1
  schemaVersion-2 record extension (a u8 tier per pair, which the reader maps to a multiplier), and
  it stays fully backward-compatible.
- Sequencing: Build the anchored mode first. Add tiers only if the measured residual FP exceeds the
  bar. Pre-register that decision rule, and do not build the implementation in advance.

PMI versus the count ratio: The ratio is the plug-in PMI estimator up to the shared
context-marginal constant. With two contexts and add-one smoothing, the two are equivalent in
practice at this vocabulary size. Start with the ratio.

## Q4 — first-pass-span veto: yes as the secondary mechanism, fail-open, child-side only

This veto adds something that Q1's segmentation does not. It targets the _residual_ class, a
street field that exactly equals a census child and sits next to the anchor. The anchor check
cannot reject that configuration, because its geometry really does match. The discriminator in that
case is whether the model reads the occurrence as `street`, and the street head is healthy on GB,
unlike venue.

Interface: Veto a child candidate only when the first-pass argmax over its span is `street`,
`house_number`, or `unit`, with a margin above a calibrated threshold.

- **Fail open.** If the read is uncertain, allow the bias, so recall never depends on the weak heads.
- **Veto the child side only.** Never veto the parent, because reading the post town as `locality`
  is the desired result.
- **Exclude `venue` from the veto set.** It was measured inactive at 0/20, so including it adds
  surface area without adding signal.

Cost: one extra decode pass on comma-free en-gb inputs only, or fold the veto into the v1.2
two-pass variant. Sequencing: apply the same pre-registered decision rule as Q3, and
implement it only if the anchored mode alone has FP above 5%.

## Q5 — determiner/shape check: mostly redundant; one narrow reuse survives

As a standalone check, it is the marker list at a larger scale, and it fails for the same reason.
Task 6 concluded that fixed successor tables never worked as a venue-boundary detector. The
`The X Arms` determiner cue covers a minority of the board and would require ongoing lexicon
maintenance. **Skip the general shape check.** One narrow reuse survives. The poi-taxonomy
business-suffix lexicon can serve as a _successor_ veto that generalizes `STRUCTURAL_MARKER_WORDS`
(`queens park` followed by `cafe` suppresses the bias). It can also serve as a _left-neighbor_
downgrade in the anchored mode's optional tier. Both uses are positional: they treat the lexicon as
evidence about where compounds end, and neither judges the candidate's shape. Build them only
when a measurement shows the need, one lexicon entry class at a time, each with its own rationale
line, following the module's own discipline for widening.

## Q6 — ASR contextual biasing: the transplantable piece is the trie rather than the subtraction

The subtractive-cost trick has no clean analogue here, for a specific reason. It exists to charge
back boosts granted to _prefixes_ of a hypothesis that later leaves the trie. Our flat per-position
bias never grants partial credit, because a window either probes exact folded keys or gets zero.
The "hallucination off the trie" failure mode therefore cannot occur, and there is nothing to
subtract. In addition, non-autoregressive BIO+Viterbi decoding has no prefix-commitment point where
the charge would attach.

Two pieces do transfer directly:

1. **Trie-driven candidate generation.** Walk the token stream through a prefix trie of the index's
   child and parent key sets, and accept only maximal complete matches as candidates. This replaces
   the O(n·k) window enumeration with a longest match by construction, and it is the natural way to
   implement the anchored mode's left-maximality rule. About 15k keys make a tiny trie that is
   browser-safe and cheap on CPU.
2. **A span-coherent boost at match completion.** This is already implemented in
   `applyWindowBias` (B- on the first piece, I- on the rest, Math.max). The arc arrived at the same
   mechanism independently, so keep it.

## Q7 — framing: comma-scoped v1 + hybrid v1.1 is right; input-normalization is the weaker leg, and cheaply falsified

The #690 all-caps precedent is real but does not transfer. Case folding preserves offsets, and
comma insertion does not. Inserting characters shifts every downstream character offset, and
`computeGroupSegments`, the repair passes, and span projection all depend on the pieces' offset
interface. The normalization approach would therefore have to remap offsets through the entire
decode path. It would also need a full metamorphic-invariance re-verification, because the
component would now edit user input. Worse, it attacks the same segmentation problem with the same
weak evidence. Comma insertion is Q1's pseudo-segmenter presented as a normalizer, one layer up and
with a larger scope. The prior-probe approach leaves the input untouched, which makes byte
stability hold by construction, and keeps the evidence additive, which follows the doctrine by
construction.

**Recommendation:** Pursue the prior probe. The cheapest way to falsify the weaker option is the
anchored-mode sweep itself. It is about 50 lines of candidate-selection change inside
`placetype-pair-prior.ts`, adds no dependencies, and runs on the existing zero-GPU harness against
the three committed boards. If it clears the bar, the normalization approach is dominated: it would
give equal recall with worse invariants at higher cost. If it fails, its miss anatomy shows exactly
which boundary evidence is missing, and that is also the spec a comma-insertion segmenter would
have to meet. The experiment is worth running under either outcome.

## Recommended experiment order (each zero-GPU, each pre-registered before it runs)

0. **Miss anatomy (diagnosis only, without code):** Of window mode's 18 comma-stripped misses at δ=10, count
   how many are marker-suppression artifacts (a child followed by a house-number shape), how many
   are margin, and how many are non-adjacent geometry. Of segment mode's 217 residual FPs, count how
   many are street fields that exactly equal a census child. These two numbers set the v1.1
   pre-registered bars and decide whether δ stays at 10 or moves to 12 (anchored mode only).
1. **Anchored-adjacent mode** as specified above. The proposed pre-registered bar, to be calibrated
   after experiment 0:
   - comma-stripped ≥50/69 emit with ≥90% tag-correct
   - venue FP ≤5%
   - golden 0/51
   - presets and golden us/fr byte-identical
   - segment-mode as-written numbers reproduced exactly (69/69, 217/6500). The probe-chain ordering
     makes this true by construction, so it is asserted. Re-measure it anyway.
2. **Only if the bar is missed:** Re-sweep at δ=12 in anchored mode only. FP depends on the anchor
   here, so the δ↔FP coupling that ruled out window mode should be much weaker. Measure it rather
   than assuming it.
3. **Only if FP exceeds 5%:** Add Q4's child-side confident-street veto (fail-open), then Q3's
   specificity tiers, in that order. The veto comes first because it uses positional evidence. The
   tiers come last because they are distributional and the most prone to overfitting.

## Pre-registered grading number, answered

Predictions against the handoff's bar:

- Comma-stripped emit: **50–62/69** at δ=10–12 in anchored mode. This is window mode's 51–62
  restricted to adjacent geometry, minus the gold rows that are not adjacent.
- Tag-correct: **≥95%**. Window mode's 96% at δ=10 should improve once cross-string geometry errors
  are removed.
- Venue FP: **3–5%**, from the residual street-equals-child class, close to segment mode's measured
  3.338% floor.
- Golden: **0/51**. The board carries no index pairs by construction, and every configuration
  measured so far scored 0.
- Presets and golden: **byte-identical**, because of the en-gb check and the comma-free
  applicability check. This is asserted and verified.
- Segment mode as written: **unchanged**. The probe chain tries segment mode first, and the
  anchored path cannot run when commas exist.

Two results are most likely to break the prediction. The first is the diagnosis of the 18 misses.
If marker suppression is removing real children, recall lands around 40/69, and the suppression
list needs a segment-aware review first. The second is a residual-FP anatomy showing that the
street-equals-child class is larger on comma-free input than as written. In that case, Q4's veto
moves from a contingency to the critical path.
