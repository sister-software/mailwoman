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
   **Stage-2 is now fully scoped — see `2026-07-15-727-stage2-kbest-plan.md`** (night-3): k-best
   decode + resolver rerank ratified by the operator, design consult-reviewed, and the zero-training
   falsifier probe run — naive decode hardening does NOT clear the residual (seg@1 0.453 vs ship
   0.584) but oracle@10 street = 0.749 (+16.5pt headroom for k-best + rerank). The bare-fragment
   recall class (66% of street failures, measured night-3) needs the kind-posterior soft channel +
   recall-weighted loss ON TOP of the span head — the head alone won't fix polarity.
3. **Fertility follow-up (orthogonal, cheap):** the 2 stubborn cases pair a region with a postcode
   digit-run, and digit-piece fertility drove the boundary-bleed class (EuroBERT lens); a
   digit-atomicity tokenizer pass (splice whole-number pieces 1..999?) may help independent of the
   head. Measure vocab growth vs the #378 SLO first.
   **Deprioritized (night-3 partition, 2026-07-15):** multi-digit house numbers are the
   BEST-performing digit form on the parity corpus (17.3% fail vs 29.2% short-digit, 73.3%
   alphanumeric) — per-digit shattering does not correlate with failure, so the splice's premise
   is counter-evidenced. The PT/RO diacritic splice (byte-fallback coverage gap, probe-confirmed)
   outranks it in the tokenizer-work queue.

## STAGE 2 PHASE 1 — DONE, GATE PASS (2026-07-15). Read this before touching the arc.

`seg@1 0.5693 > token@1 0.4906` on the parity corpus (+7.9pp); **+33pp on the Paris bare-fragment
fixture** (`token@1 0.429 → seg@1 0.762`). The arc's premise holds. PR #1141; reports
`docs/articles/evals/2026-07-15-v30{0,1}-span-head*.md`. Phase 2 (ONNX export) is unblocked.

### The four things that cost time — don't re-pay them

1. **A fresh head needs its own LR.** v3.0.0 inherited `lr: 1e-5` from v2.6.4 — a recipe that
   FINE-TUNES EXISTING weights — and the randomly-initialized span head barely moved (loss 26.4 →
   17.77, still falling, raw span NLL ~35 where converged is O(1); the decode emitted a random type
   per token; seg@1 0.004). One variable (`train.span_head_learning_rate: 1e-3`, param groups via
   `build_optimizer`) → converged 1.37 and seg@1 0.569. **Any new head gets its own param group.**
2. **`from_pretrained()` silently lacked `map_location`** — a GPU-trained checkpoint could not load
   on a CPU-only box AT ALL. Fixed; this affected every local grading run in the repo.
3. **A python-side gate is CHANNEL-STARVED (#718).** `scripts/eval_seg_at_1.py` feeds no
   anchor/gazetteer/country channels, so its token@1 reads ~0.49 where the JS harness reads 0.573 on
   the SAME model. Its absolutes are NOT comparable across harnesses — only the internal
   seg-vs-token comparison is valid (both heads read the same starved encoder). Say so in any report.
4. **Never diff two runs through `eval parity --failing 50`** — the list is truncated, so fixtures
   shift in and out of the window and manufacture phantom regressions. Diff the full per-fixture set.

### What the span head fixes, and what it provably does NOT

Fixed — the boundary class, including the arc's own archetype:

```
'Korunni 810, Praha'  →  Korunni:street  810:house_number  Praha:locality      (v264: street='Korunní 8' + hn='10')
```

NOT fixed — the **bare-fragment polarity class** (66% of street failures, night-3 partition).
`Rue Montmartre` → `locality`. This is option C's target (kind-posterior soft channel +
recall-weighted street loss) and was deliberately out of Phase 1's scope. Its survival is the plan's
prediction holding, not a surprise.

### Why "Rue" doesn't already clue the model (the 2026-07-15 operator question — MEASURED)

The intuition "`Rue` at the front should mark what follows as a street" is right, and the model DOES
use it — **but a strong toponym in the name outvotes it, and a house number is what breaks the tie**:

```
Rue Montmartre        → Rue Montmartre : locality        ✗   (Montmartre IS a Paris district)
Rue de Rome           → Rue:street de:street Rome:locality ✗ (Rome IS a city)
Avenue Victor Hugo    → Avenue:street  Victor Hugo:street ✓  (a person, not a place — no number needed!)
12 Rue Montmartre     → 12:hn  Rue:street_prefix  Montmartre:street  ✓
8 Rue de Rome, Paris  → 8:hn  Rue:street_prefix  de/Rome:street  Paris:locality  ✓
```

**The house number is the anchor, not the prefix.** Measured on `paris-streets.jsonl` (v264, ship
config): contextful/homonym **6/6**, the operator's "particularly tricky" list **9/10** — the exotic
morphology (`Chat-qui-Pêche`, `l'Hôtel-de-Ville`, `18-Juin-1940`) is NOT the problem — while
bare-fragment/famous is **3/15** and `Avenue des Champs-Élysées` returns the **empty string**.

Structurally: under flat BIO each token votes independently, so `Rue` has no mechanism to _govern_
what follows — it can only vote for its own label. That is why the decode-time street-morphology
bias ([#1103](https://github.com/sister-software/mailwoman/issues/1103)) measured net-negative: it
competes with the BIO head at the same decode position. **#1103's own pre-registered revisit
condition is "after the #727 span-head work changes boundary placement" — that condition has now
landed.** Under a segment decode a prefix clue can govern a whole span's type via the segment
transition grammar (`street_prefix → street`), which is the level where "Rue governs the next thing"
is actually well-posed. Re-probe it locale-gated per #1103's criteria; do NOT re-probe it globally
(the AU compact-form regression, 55 → 40, is what parked it).

## Standing constraints

One variable per run. fp32 for any CRF/transition learning (bf16 NaN scar). Grade with
`--weights-cache` package-shaped dirs only. Floors and the 2pp gate are immutable; the triaged
gold's default-flip awaits operator ratification. Treadmill guard applies across THIS arc too:
two opposite-direction failures = stop and fork, don't tune. **A mis-specified probe is not a
treadmill** — repairing an LR that was never chosen for the thing it trains is fixing the
instrument, not oscillating a knob (v3.0.0 → v3.0.1 is the worked example).

## What unblocks when floors pass

`hold/v1-parse-neural-gate-blocked` (swap wiring, verified) → plans 4–5 → v7. The whole excision
tail is mechanical from that point; nothing else is waiting on anything but the model.
