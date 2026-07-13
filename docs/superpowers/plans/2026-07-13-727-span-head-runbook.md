# #727 span-head arc — night-2 runbook (post-fork)

**Why now:** the fragment campaign's data levers exhausted at the twin↔US-recall trade (treadmill
fork, `2026-07-13-day-parity-campaign-fork.md`, #1102). Two residual classes have #727's shape:
boundary placement (street absorbing trailing digit-tokens; digit-piece fertility) and the
bare-name polarity bind (context-free tag assignment is a capacity fight under flat BIO). The
research desk (GLiNER NAACL'24, Filtered Semi-Markov CRF, Yin'23 BiLSTM-CRF-beats-transformers on
messy input) points at structured span prediction.

## Staged path (cheapest falsifier first — the #825 lesson)

0. **Fork option (a) first if unresolved:** the dynamics probe — v255 composition at lr 1e-5 /
   warmup 500, 2k steps, grade Dublin pin + flip counts ONLY. ~20 min A100. If BOTH survive, the
   constraint was schedule, not capacity, and the span-head arc waits; if the trade persists, it's
   capacity → proceed.
1. **GLiNER-lite probe (no architecture swap):** add a span-level auxiliary loss over the existing
   encoder (span-start/end scoring on pooled piece reps) at small weight, fine-tune 2k from v254,
   grade the SEPARATOR (span-exact vs tag-acc on fragment-dev) + the two residual classes. The
   hypothesis: span-consistency pressure fixes boundary-digit absorption without touching the BIO
   head. Config knob exists partially: `use_crf` scaffolding in model.py (crf diverged in bf16 —
   NaN protocol history says fp32 for any transition-learning retry).
2. **FSemi-CRF head** only if (1) moves the separator but plateaus below floors — the full #727
   design (span enumeration + filtered semi-Markov decode). Architecture change: new export path,
   browser SLO check (#378), capability-manifest rework. Multi-night.
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
