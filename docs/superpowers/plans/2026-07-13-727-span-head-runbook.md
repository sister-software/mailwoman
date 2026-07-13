# #727 span-head arc — night-2 runbook (post-fork)

**Why now:** the fragment campaign's data levers exhausted at the twin↔US-recall trade (treadmill
fork, `2026-07-13-day-parity-campaign-fork.md`, #1102). Two residual classes have #727's shape:
boundary placement (street absorbing trailing digit-tokens; digit-piece fertility) and the
bare-name polarity bind (context-free tag assignment is a capacity fight under flat BIO). The
research desk (GLiNER NAACL'24, Filtered Semi-Markov CRF, Yin'23 BiLSTM-CRF-beats-transformers on
messy input) points at structured span prediction.

## Staged path (cheapest falsifier first — the #825 lesson)

0. **Fork option (a) — DONE (v256, 2026-07-13).** Schedule, not capacity. v257 (full 8k gentle)
   became the first stable candidate. Residual = the boundary-absorption class, so stage 1 proceeds.
1. **GLiNER-lite probe — DONE, CONFIRMED POSITIVE (v260, 2026-07-14).** Added a training-only
   span-boundary aux head to `model.py` (`use_span_boundary_head`): per-token BCE on span START
   (B-*) + END (entity token whose successor doesn't continue it), supervised from the BIO labels,
   fp32 BCE, weight 0.5. init_from stable v257, 2k. **Result: US region→street flips 5 → 2** (3 of
   the VT cases fixed), gauntlet regression + metamorphic BOTH still PASS, aggregate parity street
   flat (boundary cases are a small slice of the 267 slots — the win is in the targeted class).
   Inference-invariant (head off the logits path, never exported → no #378 SLO cost — that is what
   made it the cheap falsifier). The hypothesis held: span-consistency pressure fixes boundary
   absorption without touching the BIO head. **v2.6.1 (full 8k, same head/weight) running** to test
   whether it deepens + lifts aggregate street.
   **Stage-1 CONCLUSIVE (2026-07-14):** the simple head plateaus at 3/5 boundary cases (flips 5→2)
   on BOTH knobs — v2.6.0 (2k, w0.5), v2.6.1 (8k, w0.5), v2.6.2 (2k, w1.5) are IDENTICAL on the
   boundary class (2 flips: `VT 05068, New St` + `n main st nd 58852`) and aggregate parity street
   (0.5281), and w1.5 slightly hurt house_number (0.767→0.753). So the partial win is real, stable,
   and free — but the residual is NOT weight- or duration-limited. The 2 stubborn cases are
   multi-boundary (region between a postcode and a street), which start/end pressure alone can't
   resolve; that is genuinely FSemi-CRF territory.
2. **FSemi-CRF head** — the confirmed next arc (stage-1 exhausted the cheap lever). The full #727
   design: span enumeration + filtered semi-Markov decode, so the model scores whole (start, end,
   type) spans instead of per-token tags. Architecture change: new export path, #378 browser-SLO
   check, capability-manifest rework — a deliberate multi-night arc, not a probe. Keep the stage-1
   span-boundary head (`use_span_boundary_head`) as a co-trained auxiliary; it's free and helps.
3. **Fertility follow-up (orthogonal, cheap):** the 2 stubborn cases pair a region with a postcode
   digit-run; a digit-atomicity tokenizer pass (splice whole-number pieces) may help independent of
   the head. Measure vocab growth vs #378 first.
4. **Fertility follow-up (EuroBERT lens):** digit-piece fertility drove the boundary-bleed class;
   a digit-atomicity pass over the tokenizer (splice whole-number pieces 1..999?) is a cheap
   orthogonal probe — but vocab growth vs #378 SLO must be measured first.

## Standing constraints

One variable per run. fp32 for any CRF/transition learning (bf16 NaN scar). Grade with
`--weights-cache` package-shaped dirs only. Floors and the 2pp gate are immutable; the triaged
gold's default-flip awaits operator ratification. Treadmill guard applies across THIS arc too:
two opposite-direction failures = stop and fork, don't tune.

## What unblocks when floors pass

`hold/v1-parse-neural-gate-blocked` (swap wiring, verified) → plans 4–5 → v7. The whole excision
tail is mechanical from that point; nothing else is waiting on anything but the model.
