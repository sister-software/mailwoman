# 2026-07-01 — #825: the retrain that regressed, and the $0 tokenizer splice that fixed it

Day shift. The brief was simple: merge the night's PRs, then spend a generous GPU budget on #825 — the
Czech/Polish diacritic problem where addresses were geocoding to the wrong city. We spent the budget, the
retrain failed, and the fix turned out to need no GPU training at all — a tokenizer splice and an embedding
average. The interesting part is why.

## What we set out to do

#825 was filed as a retrain: add an OpenAddresses Slavic-diacritic shard so the model stops tagging
`č ř ž ą ł` tokens as `O`. The hypothesis was that Czech/Polish street and locality names were fragmenting
because the model had never seen them with house-number/street context — a training-data gap.

## The arc

**We built the ship candidate carefully — and caught a trap doing it.** The obvious move was to grade the
running probe (`v1.9.3-slavic-diacritic`). But that recipe was copied from `v1.9.2-multilocale-au` (v4.14.0),
which predates the #723 anchor-absorption fix. Grading it against v4.15.0 would have confounded the Slavic
shard with a reverted #723 — and #723 is coordinate-invisible, so the coord gate would never have caught it.
So we forked a clean candidate, **v196-slavic-anchor** = v4.15.0's recipe verbatim + the one new shard, off
the v4.15.0 corpus so it keeps #723. One variable. (Lesson banked: a shard recipe copied from vN-1 silently
inherits vN-1's bugs.)

**The mid-train read (40k) said US was untouched and CZ/PL was flat.** US coord p50 diff −0.002km,
CI [−0.02, 0]. CZ/PL wrong-city rate unchanged. The shard was proving genuinely US-safe but not moving the
coordinate.

**The coverage detour, and the eyeball that overturned our own aggregate.** The operator asked us to scope
whether CZ/PL was coverage-bound before deciding. The resolved-p50 aggregate (CZ 5.24km) *looked* like "right
city, just coarse — needs rooftop data." The eyeball said otherwise: ~40% of Czech addresses were landing in
the **wrong city entirely** (80–280km off), because the diacritic parse was broken — `Vysoká` read as
`Vysok`, `Čistá` as `istá`, localities truncated. The p50 had hidden a bimodal distribution. This is
verify-before-verdict firing on our own summary statistic: the aggregate wasn't the verdict, the evidence
was. CZ/PL was **parse-bound**, not coverage-bound, and coverage can't touch a wrong-city row.

**The research said we weren't alone.** A tokenizer probe confirmed the mechanism: the 48k SentencePiece vocab
has the diacritic *characters* but no multi-char *subwords* containing them, so every diacritic isolates its
own piece — CZ localities at 3.3× English fertility. This is the documented "tokenizer fertility tax." Four
parallel SOTA agents + a DeepSeek consult mapped the fix space: vocabulary expansion (byte-identical English
by construction), byte/char-level models (universal but latency-heavy), and a CharCNN front-end (cheap +
universal). The fix was tokenizer-side; the shard was the wrong lever.

**The 80k gate confirmed it — and then some.** v196 at full convergence: US held (p50 3.31, zero dilution),
PL flat, but **CZ regressed** — resolved-p50 5.24 → 82.89km, wrong-city 44 → 58%. At 40k CZ was flat; the
extra 40k steps at constant LR overfit the shard and broke the Czech parses. NO-PROMOTE. The retrain didn't
just fail to help — at scale it did harm. We only know because we graded the assembled coordinate; on
label-F1 the content-gap went 100→17% and the model looked fixed.

**The tokenizer splice fixed it at nearly zero cost.** We trained a Czech/Polish SentencePiece unigram, kept
only the pieces containing a non-ASCII codepoint, and appended them to the 48k vocab. Because a diacritic
piece can't match any span of an English string, English tokenizes byte-identically by construction — we
verified 0/2000 US rows changed. Mean-init the 10,582 new embedding rows from their old-tokenizer
constituents, a 2k-step fine-tune, and grade with the spliced tokenizer.

## The numbers

Same golden sets, same grader; the B columns are graded with the spliced tokenizer.

| metric | baseline v4.15.0 | v196 retrain (80k) | B splice + 2k FT | **B splice, mean-init only ($0)** |
| --- | --- | --- | --- | --- |
| US-2k coord p50 | 3.31 km | 3.31 (flat) | 3.31 (diff 0) | **3.31 (diff 0, CI [0,0])** |
| US region-match | 0.999 | 0.999 | 0.999 | **0.999** |
| CZ resolved-p50 | 5.24 km | 82.89 ✗ | 3.75 | **3.52** |
| CZ wrong-city (>20km) | 44% | 58% ✗ | 30% | **28%** |
| PL resolved-p50 | 2.37 km | 2.37 | 1.53 | **1.53** |
| PL wrong-city | 30% | 30% | 11% | **11%** |

Tokenization, before → after splice: `Vysoká` 4→1 piece, `Grudziądz` 6→1, `Świętokrzyska` 9→1, `Čistá` 5→2.
The eyeball confirmed the mechanism end-to-end — `Fr. Černého`, `Střížovice`, `Březová nad Svitavou` now parse
as whole names where the baseline truncated them to `Fr`, `St`, `B`.

**The ablation is the punchline: the fine-tune was unnecessary.** We ran the splice + mean-init model *without
any fine-tune* and it matches or beats the fine-tuned version on every metric (CZ wrong-city 28% vs the
fine-tune's 30%; PL and US identical). The 2k fine-tune not only added nothing — it began drifting toward the
same overfit that killed v196. So the fix is a tokenizer splice plus an embedding average: no GPU training.
And because it leaves v4.15.0's encoder byte-for-byte untouched, US identity is a **guarantee** (encoder
unchanged + English input_ids unchanged → identical logits), not an observation — the freeze-encoder variant
we were going to build is what the mean-init already is.

Every gate passes: US non-inferiority (byte-identical), CZ improvement (p50 −1.70, CI wholly negative,
wrong-city 44→28), PL improvement (p50 −0.85, wrong-city 30→11), functional eyeball (no over-tagging).

## What worked

- **Grading the coordinate, not label-F1.** This is the whole story. The retrain's content-gap win (100→17)
  was real and would have shipped a coordinate regression. The wrong-city decomposition (tight / coarse /
  wrong-city buckets) is the honest metric for these locales and should be a standard part of the non-US gate.
- **Diagnostic before fix.** The $0 splice-and-verify (English byte-identical, fertility drop, `Vysoká`
  atomic) proved the mechanism before a single GPU dollar. The expensive retrain came first only because it
  was the pre-registered plan; the cheap tokenizer probe should have been the opening move.
- **Verify-before-verdict, twice.** The eyeball corrected our own aggregate p50 (parse-bound, not
  coverage-bound), and we re-graded the CZ regression in fp32 to rule out int8 quantization before blaming
  training. Both saved a wrong conclusion.
- **Parallel research that paid off.** Four SOTA agents + DeepSeek turned "we have a tokenizer problem" into a
  ranked, cited fix space with a named, English-safe recipe (FVT mean-init, the Chinese-LLaMA/EEVE lineage).

## What could have gone better

- **The retrain was the wrong first move, and it was expensive.** ~$25 of GPU to falsify a hypothesis a $0
  tokenizer probe could have flagged in an hour. The fertility check should have run before the ship
  candidate, not after. We reached for the pre-registered lever instead of the cheapest falsifier.
- **The 150-row CZ/PL eval sets are underpowered.** The CZ resolved-p50 CI was [−40, −0.34] — barely negative
  at the top, huge at the bottom. The wrong-city *rate* carried the verdict; the p50 was noise. A promote
  decision needs ~1k rows.
- **The first grade in each batch kept getting skipped** (heat throttle), forcing standalone re-runs. Minor,
  but it cost a couple of confused minutes each time.

## Lessons

1. **Fragmentation, not data.** For diacritic-heavy scripts, a data shard at a frozen tokenizer cannot fix
   span boundaries — the tokenizer decides the boundaries. Fix the tokenizer.
2. **The cheapest falsifier goes first.** The tokenizer fertility probe was $0 and decisive; it should have
   preceded the GPU spend, not followed it.
3. **Disjoint-codepoint vocab splicing is a real tool.** Appending only non-ASCII pieces to a unigram vocab
   keeps the source language byte-identical *by construction* — a guarantee, not a hope. Worth remembering for
   any future non-Latin extension (with the caveat that it does not scale to CJK, where char-level is the
   natural unit).
4. **A recipe copied from vN-1 inherits vN-1's bugs.** Diff the corpus and source-weights against the shipped
   recipe before launching, not after.
5. **Mean-init alone can be the whole fix.** The 2k fine-tune we assumed we needed added nothing — a good
   embedding average over already-trained constituents was enough for the existing tagger to read the now-
   atomic token. Run the mean-init-only ablation before spending a training run; the training might be dead
   weight (and here it started to overfit).

## Where this leaves us

The B vocab-splice is a clean promote candidate — the successor fix to #825. The ablation resolved the biggest
open question: the fix is **training-free** (splice + mean-init, no GPU) and US byte-identity is a **guarantee**
(the encoder is v4.15.0 untouched), which retires the freeze-encoder task before we built it. What remains is
mechanical: larger CZ/PL eval sets (150 rows is underpowered for a promote call), an int8 bundle-size check
against the browser SLO (the vocab growth is a real cost), reproducible build scripts for the splice +
mean-init, and a coordinated model+tokenizer version bump. The residual wrong-city (CZ 28% / PL 11%) re-opens
the coverage lever we correctly deferred — now downstream of a fixed parse. CharCNN was built and validated in
parallel and is parked as the CJK-forward path (the one place vocab-splice won't scale). Tasks #289–#297.

## Ledger

| | |
| --- | --- |
| Shift | Day, 2026-07-01, ~15:00–19:45 UTC |
| Models trained | 2 (v196 ship candidate 80k; v1.9.7-bsplice fine-tune 2k) + the v193 probe finishing |
| Total Modal GPU | ~$25–30 (retrain dominates; the winning fix — splice + mean-init — needed 0 training, just an export) |
| Promotions | 0 shipped — v4.15.0 remains default; B is a candidate pending the checklist |
| Regressions shipped | 0 |
| NaN / divergence | 0 |
| Net result | #825-as-retrain falsified; an English-safe CZ/PL fix found and validated |
