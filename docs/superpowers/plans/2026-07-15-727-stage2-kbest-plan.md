# #727 stage-2 — k-best semi-Markov span decode + resolver rerank (night-3 plan)

Supersedes the open decisions in `2026-07-15-v7-state-and-open-decisions.md` and extends
`2026-07-13-727-span-head-runbook.md` with the operator-ratified direction from the 2026-07-15
day conversation, plus night-3 measurements. Confidence marked per claim: **[measured]**,
**[operator]**, **[consult]**, **[hypothesis]**.

## Direction, ratified

From the 2026-07-15 operator conversation: **[operator]**

- **Delete stays delete.** The v7 excision removes the rules parser outright. The hybrid
  rules-fallback gate is off the table; no consumer may route through legacy rules. The
  plausibility guard survives as a direction-agnostic signal (PR #1133).
- **The architecture bet is one level up from tokens.** The encoder does context-sensitive
  weighing over tokens well; what's missing is the same concept over _phrases_ — joint scoring of
  whole segmentations, with a segment-level transition grammar ("must not follow", one level up)
  and **k-best hypotheses with comparable scores** instead of a single binary answer.
- **The arbiter for the k-best list is the resolver** (evidence-based: gazetteer coherence), not
  hand-weights. A rank-2 parse that resolves to a real place beats a rank-1 that resolves to a
  country centroid. Discipline: parse scores stay in one probability space; the rerank signal is
  measured resolution evidence only; rank-2-beats-rank-1 cases get logged as training data.
- **Anti-goals:** no cascade refiner model; no enumerated scheme templates; no per-hypothesis
  hand-tuned weights (the Pelias-blend antipattern — two oracles with incomparable confidences).

## What night-3 changed (all zero-GPU)

1. **Failure partition overturns the boundary narrative.** [measured] Of 122 parity street
   failures: the dominant class (80/122) is **bare fragments with NO house number** (66% fail
   rate) — a recall/polarity failure, not a boundary failure. Leading-number US-style inputs fail
   only 21.6%. Alphanumeric numbers (`16a`) are the worst form bucket (73.3%); multi-digit numbers
   are the BEST (17.3%) — which kills the digit-atomicity splice as a priority (the tokenizer
   shattering multi-digit numbers per-digit does not correlate with failure).
2. **The "empty street" class is mostly model refusal, not decode drop.** [measured] 26/34
   empty-street fails have no street-family label anywhere in the raw argmax (model emits
   locality/venue/O); 8 are viterbi flipping street away; 0 are lost to priors/repairs/tree-build.
3. **Word-consistency heal shipped default-ON (PR #1132).** [measured] The 2026-06-19 shelving
   ("vote amplifies noise, confidence gate is the path") was a mis-diagnosis: the regression was
   two bugs — the heal re-decoding already-consistent words against viterbi, and punctuation
   pieces joining vote groups. Fixed, the heal is a clean win with NO confidence floor: golden fr
   macro 42.2→51.5, us street 82.0→82.2, parity house_number .767→.808, postcode →1.000, street
   .543→.573, error-analysis 2pp gate PASS, presets 6/6.
4. **Diacritics confirmed "visibility, not regression."** [measured] With the heal on,
   resolve-locality is 100% on every scored diacritic locale (CZ 3/3, PL 2/2, PT 2/2, RO 3/3,
   SK 1/1) while street-tag surface exactness sits at 0.63–1.00. The city never goes wrong. The
   PT/RO splice case shrank but survives: RO `ț` byte-fallback words are heal-skipped by design.
5. **The falsifier probe ran (DeepSeek-designed, session 019f6471).** [measured]
   Segment-level semi-Markov Viterbi over the EXISTING v264 emissions (span score = summed
   B-/I- log-probs, empirical transition bigrams from golden-dev):

   | floor        | n   | token decode (ship) | seg-decode@1 | oracle@5 | oracle@10 |
   | ------------ | --- | ------------------- | ------------ | -------- | --------- |
   | street       | 267 | 0.584               | 0.453        | 0.663    | **0.749** |
   | house_number | 146 | 0.795               | 0.596        | 0.705    | 0.747     |
   | postcode     | 72  | 0.986               | 0.889        | 0.917    | 0.917     |

   Both pre-registered branches resolved: (a) naive decode hardening does NOT clear the residual
   (seg@1 < baseline) — a **trained** span scorer is necessary; (b) the correct street reading
   already exists in the top-10 segmentations 74.9% of the time (+16.5pt over shipped) — the
   k-best + resolver-rerank headroom is real and measured, not hypothesized.
   Probe: `scratchpad/probe-semimarkov.mjs`.

## Stage-2 design requirements (consult-reviewed, session 019f6471)

1. **FSemi-CRF span head** — enumerate spans (word-aligned, length ≤ 6 words), score
   (start, end, type) jointly, segment-level transition table, filtered by the stage-1 boundary
   head's probs (it stays as co-trained auxiliary AND the span pruner). [consult: prune to
   100–200 spans → decode ~free]
2. **The bare-fragment recall class is NOT fixed by the span head alone.** [consult] Chosen fix:
   **option C** — kind-classifier posterior fed as a soft feature channel (established infra:
   postcode anchor, country lexicon) + recall-weighted loss on street spans. Explicitly rejected:
   hard "must emit street" decode mask (kind errors become hallucinations); constrained-hypothesis
   injection into the k-best list (scores from different normalizations are incomparable — the
   Pelias-blend antipattern in miniature). Fallback if C plateaus: score-preserving unary-logit
   bias before decode, NOT a graph change.
3. **k-best decode** — k-way extension of the semi-Markov Viterbi recurrence over the pruned span
   graph. Scores within one input share the partition function → directly comparable for the
   reranker. [consult]
4. **Calibration** — raw joint log-probs rank fine WITHIN an input, but the ambiguity gate
   ("margin < τ → let the resolver decide") needs the isotonic pass on top-1/margin, reusing the
   existing span-confidence infra. Skipping it makes τ unpredictable across inputs. [consult]
5. **ONNX/browser** — encoder + boundary/span projections in the graph; span enumeration,
   filtering, and k-best decode in JS/WASM post-processing (mirrors the probe's decoder). No
   dynamic-shape ONNX ops; #378 SLO impact is the pruned-decode cost, ~negligible. [consult]
6. **fp32 for logsumexp/partition + final path scores; encoder can stay bf16.** The token-CRF
   bf16 NaN scar applies to the partition math, not the granularity. [consult]
7. **Alphanumeric house numbers** — expected to benefit directly from joint span scoring; if the
   class plateaus, add a char-ngram feature over the span surface (tiny, JS-computable).
   [consult, hypothesis]

## Eval additions (build BEFORE the head — instrument-blindness rule)

The night-3 conversation named why this architecture sat unbuilt: every gate scores top-1, so
hypothesis-space improvements were invisible. Before the first training run:

- **oracle-recall@k** (k = 1, 5, 10) on the parity floors — the probe's decoder IS the
  scaffolding (`scratchpad/probe-semimarkov.mjs` → promote to `mailwoman/eval-harness/`).
  Baseline registered above.
- **rank-2-beats-rank-1 rate** through the resolver (requires wiring k-best into a resolve loop —
  the plausibility guard PR #1133 is the first rerank signal).
- Standing floors unchanged (0.90/0.97 parse-tag parity; the 2pp golden gate; gauntlet;
  metamorphic). No silent gate drift: the k-best metrics ADD, they do not replace.

## Process changes (from the same conversation)

- **Architecture arcs get a protected lane**: multi-night bets are scheduled as their own
  workstream with acceptance criteria at arc scope, not re-litigated against nightly splice
  opportunities each evening.
- **Scar-tissue audit**: "CRF diverged" (v0.5.0, bf16, token-level) was treated as a standing
  verdict for ~200 versions; its conditions don't hold at segment granularity in fp32. When a
  ledger entry blocks a direction, re-check its conditions before citing it. (Tonight's
  word-consistency re-diagnosis is the same lesson: the 2026-06-19 "vote amplifies noise" verdict
  was actually two fixable bugs.)

## Sequencing

1. ~~Heal ship~~ (PR #1132), ~~plausibility guard~~ (PR #1133), ~~falsifier probe~~ — done night-3.
2. Promote the probe decoder to an eval-harness command (`mailwoman eval oracle-k`); register
   baselines in the ledger notes. [next session, ~small]
3. PT/RO tokenizer splice — fills the confirmed byte-fallback coverage gap; cheap, independent,
   and it feeds the span head's inputs too. Measure vocab growth vs #378 first (runbook stage-3
   note stands). [small, one training run]
4. **The span-head training arc** (multi-night, protected lane): stage-1 aux head kept; span
   scorer + segment transitions per the design above; kind-posterior soft channel + recall-weighted
   street loss (option C); fp32 partition math; export path + #378 check; k-best decode in
   neural/ + neural-web mirroring the probe.
5. Wire resolver rerank behind a flag; measure rank-2-beats-rank-1 + coordinate parity; the
   plausibility guard becomes a rerank feature, not a router.
6. Re-run the v7 parity floors. The floors gate the excision swaps exactly as plan-2 wrote them;
   if the arc clears them, `hold/v1-parse-neural-gate-blocked` unblocks mechanically.

## Open for the operator

- Ratify the protected-lane framing (item 4 will span multiple nights; the nightly cadence should
  treat it as one arc, not re-decide it nightly).
- The parity floors stay the acceptance criterion for the swap (option (a) of night-2's decision
  1); the coordinate-parity evidence now rides UNDER the floors as diagnosis, not as a
  replacement gate. If the span arc stalls below 0.90 street with everything above shipped, the
  floor-vs-coordinate-gate question reopens WITH data.
