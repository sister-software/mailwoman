# Handoff: the pair-prior comma-scope problem (brainstorm request)

**Date:** 2026-07-24 · **For:** Kimi (external brainstorm) · **From:** the mailwoman placetype-pair
arc. Everything below is measured, current, and reproducible from
`.superpowers/sdd/task-8-report.md`; nothing is hypothetical unless marked.

## The system in three sentences

Mailwoman is a neural postal-address parser: a small (39MB int8, CPU) BIO sequence labeler over
SentencePiece pieces, Viterbi-decoded with a stack of soft "emission priors" added to the logits
before decode. The newest prior is gazetteer-backed: a 457KB index of 19,209 real (child, parent)
place pairs extracted from the HM Land Registry Price Paid dataset ("Fishburn" under
"Stockton-on-Tees" → `dependent_locality`), probed at decode time; a hit adds a calibrated logit
bias δ toward the tag. Doctrine constraint: **positive evidence only** — a pair's absence from the
index must never penalize anything, and the model keeps ownership of ambiguity (the prior
nudges, never dictates).

## Why the prior exists

`dependent_locality` is a dead tag: the shipped model (v385) was trained into never emitting it
(~93% of training rows carry no such tag). Five training-side fixes were tried and falsified with
receipts (data starvation, encoder drift, checkpoint anomaly, comma-ratio matching, two-phase LR
annealing) — every recipe that resurrects the tag also breaks one metamorphic invariance class
within the first 1k steps, stably and irreversibly. Then a zero-GPU sweep found the decode-side
answer: v385's classifier deficit for the tag is large but **uniform** (~7.0 logits mean, 4.95
min), so a δ that clears it clears everything at once:

|      δ | GB board (69 rows) emit / tag-correct | golden no-DL FP (51 rows) | venue-confound FP (6,500 rows) |
| -----: | ------------------------------------- | ------------------------: | -----------------------------: |
|      5 | 0/69 · 0                              |                         0 |                          0.39% |
|      7 | 35/69 · 32                            |                         0 |                          2.48% |
| **10** | **69/69 · 69/69**                     |                     **0** |                      **3.34%** |
|  12–15 | flat                                  |                         0 |                           flat |

δ=10 on the _untouched shipped model_ beats every trained candidate the arc produced. Ship track
opened — and then the pre-registered battery caught the flaw this document is about.

## The flaw: the prior is comma-conditioned by construction

The prior's production `probeMode` is `"segment"`: the input is split at commas, and (child,
parent) candidates are only probed **across distinct segments**. This was chosen deliberately —
the alternative (`"window"`, probe every adjacent token window) had catastrophic venue false
positives. Consequence, measured on the ship battery: strip the commas from the 69 board rows and
**emission drops from 69/69 to 0/69**. No segments → no probe → structurally inert. After an arc
spent fighting the _model's_ comma habits, the decode prior turns out to be the comma-dependent
component.

Fresh both-modes sweep (v385 + δ=10-class artifact, marker suppression on):

|   δ | mode    | as-written emit/correct | comma-stripped emit/correct | venue-FP% |
| --: | ------- | ----------------------- | --------------------------- | --------: |
|   8 | window  | 67/69 · 64              | 35/69 · 30                  | **53.5%** |
|   8 | segment | 68/69 · 64              | 0/69                        |      3.3% |
|  10 | window  | 68/69 · 68              | 51/69 · 49                  | **79.0%** |
|  10 | segment | 69/69 · 69              | 0/69                        |      3.3% |
|  12 | window  | 68/69 · 68              | 62/69 · 61                  | **89.4%** |
|  12 | segment | 69/69 · 69              | 0/69                        |      3.3% |

Window mode's comma-free recall is real (62/69 at δ=12) and its FP is disqualifying, worsening
with δ. Neither mode alone works. The current decision (operator-pending): ship segment-only as a
comma-scoped v1 (strictly additive; comma-free inputs = today's behavior), and design the
comma-free story properly. **That design is what we want to brainstorm.**

## Concrete rows

**Succeeds (segment mode, as written) — the target population, register-style GB addresses:**

- `St Bedes Avenue, Fishburn, Stockton-on-Tees` → Fishburn = dependent_locality (pair
  "fishburn"/"stocktonontees" in the index)
- `41 Hightree Drive, Henbury, Macclesfield, SK11 9PD` → Henbury = dependent_locality
- `Beulah Hill, Fishburn, Stockton-on-Tees, TS21 3AB` (the knife-edge row: post-bias margin
  ~0.2 logits at low δ; comfortable at 10)

**Fails (segment mode, commas stripped) — the same addresses, the gap population:**

- `St Bedes Avenue Fishburn Stockton-on-Tees` → 0 emissions, prior never probes
- `41 Hightree Drive Henbury Macclesfield SK11 9PD` → same

**Window-mode false positives — the confound class (real FSA venue-register rows; venue/street
names are BUILT from real place names, so naive windows hit real index pairs):**

- `Queens Park Cafe, Queens Park, Chester, OL10 1JR` — "Queens Park" is a real child under real
  parents; window mode tags fragments of the VENUE/STREET as dependent_locality
- `Queens Park Academy, Queens Park Academy Chestnut Avenue, Chester, MK40 4HA` — same shape
  inside a street span
- `Cosheston Voluntary School, Cosheston Vc Primary School, Pembroke Dock, SA72 4UN` —
  "Cosheston" is a genuine hamlet name occurring inside two venue spans

**Correctly untouched (both modes) — no-dep-loc golden rows:**

- `15 Leewood Crescent, Norwich, NR5 0DA` → FP 0/51 at every δ tested, both modes

## Suppression mechanisms: what exists, what was tried and rejected

- **Live (window mode, always-on):** `STRUCTURAL_MARKER_WORDS` = `{house, road, street, flat, court}` + a house-number-shape successor check — a candidate window immediately followed by one
  of these is suppressed. Evidently far too weak (79% FP at δ=10 WITH it on).
- **Tried and rejected:** a veto keyed on the model's own `B-venue` logit at the candidate
  position — measured **inert** (venue logit won at 0/20 candidate positions; v385's venue head
  is itself starved on GB). Not available as a signal.
- **Not yet tried:** everything in the questions below.

## Hard constraints for any proposal

1. Positive evidence only; the model owns ambiguity (soft bias, never a hard segmenter).
2. No training required (training-side is a separate, currently-stopped track; a proposal MAY
   include an optional training leg but must not depend on one).
3. CPU, per-parse milliseconds; the index is a flat binary probed by folded string keys.
4. Byte-stability outside the target locale, and outside pair-hit positions within it.
5. Anything shipped must be measurable on the boards above with a pre-registerable bar.

## Specific questions

1. **Boundary hypotheses without commas.** We have non-comma boundary sources at decode time: the
   model's own first-pass BIO span predictions, capitalization runs, the `phrase-grouper` stage's
   proposed units, postcode/house-number anchors (both ends of a GB address are usually
   unambiguous). Is a **two-pass decode** — parse once unbiased, derive pseudo-segments from the
   predicted span boundaries, then probe the prior segment-wise against those and re-decode —
   principled, or does it just launder window mode's FP problem through the model's own (weak on
   GB) boundaries? Any known-good pattern from constrained decoding literature for this
   "self-derived structure" loop?
2. **Positional asymmetry.** In register-style GB addresses the dependent locality sits
   immediately BEFORE the post town, and the venue/street confounds sit at the START of the
   string. Window mode currently probes all positions uniformly. How would you exploit
   position-in-sequence (e.g., only probe windows in the suffix region after the last
   street-suffix token / before the postcode anchor) without breaking the "model owns ambiguity"
   rule for genuinely odd orderings?
3. **Index-side specificity weighting.** 19,209 pairs, flat δ. Children like "Queens Park" are
   massively venue-ambiguous; children like "Holland Fen" are nearly unambiguous. Would a
   per-pair δ scaled by child-name specificity (document frequency of the child string in venue
   registers / street-name corpora — both on disk here) plausibly separate the curves? Any
   principled weighting you'd start with (PMI between child string and place-context vs
   venue-context)?
4. **Structural vetoes stronger than a marker list.** The confound windows are almost always
   INSIDE a span the model itself labels venue/street/house_number as-written. Veto any window
   that overlaps a first-pass span whose argmax is in `{venue, street, unit, house_number}` at
   confidence above a threshold? (Distinct from Q1: this uses the first pass only as a veto, not
   as a segmenter — failure mode analysis welcome.)
5. **The determiner/shape cue.** FSA confounds skew toward `The X Arms`, `X Academy`, `X Cafe` —
   head-noun-final English compounds. Is a lightweight shape gate (definite article prefix,
   business-suffix lexicon from our poi-taxonomy synonym table) worth the brittleness, or is
   this the marker-word list again at larger scale (and doomed the same way)?
6. **ASR contextual-biasing prior art.** Shallow fusion with prefix-trie subtractive costs
   handles exactly this "boost listed entities without hallucinating them" problem. The
   subtractive-cost trick (charge the boost back if the hypothesis leaves the trie) has no
   analogue in our flat per-position bias. Is there a clean adaptation to non-autoregressive
   BIO+Viterbi decoding?
7. **Is comma-scoped v1 + hybrid v1.1 even the right frame?** Alternative framing: treat
   comma-free GB as an INPUT-NORMALIZATION problem (the #690 all-caps precedent: normalize OOD
   input toward the training distribution — i.e., re-INSERT boundary commas from a cheap
   segmenter before the parse) rather than a prior-probe problem. Where would you place that
   bet, and what's the cheapest experiment that would falsify the weaker option?

**One number any proposal gets graded against (pre-registered before we run anything):**
comma-stripped GB board ≥ 50/69 emit with ≥ 90% tag-correct, venue-confound FP ≤ 5%, golden no-DL
FP = 0, presets/golden byte-identical. Segment-mode's as-written numbers must not regress.
