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
2. **Higher weight / FSemi-CRF head** — the escalation once v2.6.1 lands. If 8k@0.5 moves the
   boundary class further but plateaus, next is a weight sweep (0.5 → 1.0/1.5, one variable) on the
   cheap current head BEFORE the FSemi-CRF architecture (span enumeration + filtered semi-Markov
   decode — new export path, #378 SLO check, capability-manifest rework, multi-night). Escalate to
   FSemi-CRF only if the simple head's weight sweep plateaus.
3. **Fertility follow-up (EuroBERT lens):** digit-piece fertility drove the boundary-bleed class;
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
