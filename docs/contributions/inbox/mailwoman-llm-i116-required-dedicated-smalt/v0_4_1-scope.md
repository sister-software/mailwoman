# v0.4.1 — diagnose v0.4.0's mixed-result + retry

**Draft for operator review.** Drafted by the v0.4.0-ship agent
post-iteration. Will get polished and opened as a real GitHub issue by
the operator on return.

## Context

PR / branch `issue-116-phase-2-x-v0-4-0` shipped v0.4.0 to packaged
artifacts (no npm publish) with a mixed result on the golden v0.1.2 set:

| tag | v0.4.0 ship | v0.3.0 | Δ |
|---|---:|---:|---:|
| country | 0.21 | 0.28 | **−0.07 regression** |
| region | 0.19 | 0.18 | +0.01 |
| locality | 0.27 | 0.27 | flat |
| postcode | 0.69 | 0.76 | **−0.07 regression** |
| venue | 0.39 | 0.39 | flat |
| street | 0.30 | 0.27 | +0.03 win |
| house_number | 0.79 | 0.78 | +0.01 |

Issue #116's success metric (clear progress on ≥ 2 of {coarse F1, fine F1,
calibration, training stability}) is **NOT cleanly met**.

The shipped recipe was the §4-only ablation — v0.3.0 dual-loss base
(per_sequence CRF NLL × crf_loss_weight=0.05) + the §4 source-weight
rebalance (drop usgov-nad 2.0→1.0; bump wof-admin+wof-postalcode 1.0→2.0).
The two main v0.4.0 levers — §1 per_token CRF NLL norm with
crf_loss_weight=1.0, and §3 class-weighted CE — both destabilized the
training in every LR + ablation combination tested.

Full iteration retrospective in `LOG.md` (entry dated 2026-05-23 06:25)
and in the corresponding session-notes.md.

## Scope of v0.4.1

Three orthogonal threads, in descending confidence that they'll move the
needle:

### Thread A — source-weight tweak + decoder span trimming

**A diagnostic on the shipped checkpoint** (see
`.playpen/control/drafts/v0_4_0-regression-diagnostic.md`) characterized
the two regressions:

- **postcode (-0.07)**: ~70% of the FN count is house-number / postcode
  confusion in "postcode-first" patterns ("47110 City…", "ND 58701, street…").
  NAD's downweight 2.0 → 1.0 removed exposure to these patterns. Plus
  ~25% of postcode FP count is BIO-segmentation slip ("`T 05760`",
  "`, 2222`") — surface strings include a leading punctuation token.
- **country (-0.07)**: similar BIO-slip ("`FRANCE`" vs gold "`France`"
  is a case-mismatch penalty, not a real wrong-answer) + non-Latin
  transliteration adversarials (already a known v0.3.0 failure mode).

Concrete v0.4.1 work:

1. **Source-weight tweak**: `usgov-nad: 1.0 → 1.5`. Partial restore —
   keeps §4's overdomination cap but recovers the postcode-first
   exposure. Estimated sampled mix: ~62% NAD (vs v0.3.0's 75%, v0.4.0's
   50%). Other source weights unchanged.

2. ~~Decoder span trimming~~ — host-claude is landing this directly to
   main as a sidecar (no retrain required). Strips leading/trailing
   non-alphanumeric chars from `AddressNode.value` after the decoder
   builds the span; preserves `start`/`end` for downstream consumers.

3. **Case-insensitive eval equality**: "FRANCE" == "France" shouldn't
   count as a regression. Loosen `eval.py`'s strict equality OR
   canonical-normalize gold + pred on both sides.

Estimated impact: postcode F1 recovers to ~0.75-0.78 (vs current 0.69);
country F1 to ~0.27-0.30 (vs current 0.21). Both would close most of
the v0.4.0 regression gap vs v0.3.0.

Acceptance: a single retraining run with the adjusted source weight +
the span-trimming + case-norm changes, with golden eval at step 5000
showing country and postcode F1 within ±0.02 of v0.3.0.

### Thread B — corpus-side investigation of §1's CRF instability

Issue #116's text itself names this fallback:

> "If after the changes in §1 + §2 the training is still divergence-prone
> at step ~2K, that's a v0.4.1 corpus-side investigation (corpus-v0.3.0
> has 677M rows — there may be a small high-loss adapter slice that's
> amplifying CRF gradient spikes)."

The §1 per_token CRF NLL normalization hypothesis — that per-token
scaling brings the CRF NLL to CE magnitude so the dual loss is
self-balancing at crf_loss_weight=1.0 — was empirically falsified. At
every LR tested (5e-4, 3e-4, 1.5e-4) §1 destabilized training.

A diagnostic pass over corpus-v0.3.0 looking for high-loss slices would
identify whether a specific adapter (likely a fine-label-only adapter
like NAD or TIGER's street-only ADDRFEAT segments) is producing
gradient spikes that the per-token-normalized CRF NLL still can't
dampen.

Concrete sub-work:
1. ~~Build the `mailwoman corpus-audit` tool~~ — already shipped to `main`
   as `corpus/scripts/audit.ts` + `corpus/scripts/audit.test.ts` (per
   host-claude message 2026-05-23 07:42; not visible from this branch
   yet — pull when starting v0.4.1)
2. Extend it (or pair it with a separate diagnostic) to measure
   per-adapter loss + gradient-norm distribution during training
3. Run against corpus-v0.3.0 + a §1-enabled training run
4. If a high-variance adapter is found, decide: prune / downweight /
   shard-filter

Acceptance: a per-adapter gradient-norm table + an operator-go decision
on whether to rebuild corpus to v0.3.1 with adjusted shards.

### Thread C — schedule / class_weight ratio redesign

If threads A + B don't surface a single corpus-side fix, the next angle
is the training schedule itself. The v0.4.0 iteration surfaced two real
process improvements:

1. **The cosine-decay-masking-divergence meta-bug.** The verdict-smoke
   framework (max_steps=3000 cosine schedule) gave a false-positive PASS
   on cw-only, because by step 2750 the LR had decayed to near-zero and
   the divergence band was never re-entered. The same cw-only recipe at
   max_steps=50000 diverged at step 2250.

   Fix the verdict-smoke framework: either use a constant-LR schedule
   for smoke runs, OR set max_steps high enough that the cosine tail
   doesn't dominate (e.g. max_steps=10000 keeps LR > 60% of peak for
   the relevant range).

2. **The class_weights ratio is too aggressive.** v0.4.0's class_weights
   range 0.5..2.0 (4× ratio between fine and coarse). With average
   non-O token weight ~1.3, sustained training at lr=1.5e-4 still
   destabilizes. A milder ratio (e.g. coarse 1.3, fine 0.7 — 1.86×
   ratio) might give the coarse-recovery benefit without the
   destabilization.

Acceptance: at least one constant-LR run AND one milder-weights run
through max_steps=10000, with golden eval at step 5000 + 10000.

## Process improvements to land regardless of v0.4.1's training outcome

One clear win from the v0.4.0 iteration that should land in v0.4.1
independent of which thread above carries:

1. **Document the verdict-smoke framework's cosine-decay caveat.** Either
   in `docs/articles/plan/reference/STAGES.md` or as a new
   `docs/articles/plan/reference/VERDICT_SMOKES.md`. Any future
   verdict-smoke design has to know the lr=peak-band needs sustained
   exposure for the smoke to be predictive.

(The corpus-audit tool from the original TODO has already shipped to
main — `corpus/scripts/audit.ts`. Independently usable now.)

## Out of scope for v0.4.1

- Tokenizer retraining (v0.1.0 tokenizer is fine through Stage 2).
- New corpus sources beyond `corpus/src/adapters/`.
- Stage 3 organization/POI venue disambiguation (still v0.5.0+).
- Re-attempting §1+§3 at lr=5e-4 — three runs proved lr=5e-4 is
  unreachable for this codebase regardless of recipe.

## Wall-clock estimate

- Thread A: 1-2 days (diagnostic + a single retraining run at adjusted
  source weights). High-confidence win if a clear pattern is found.
- Thread B: 3-5 days (corpus-audit tool + adapter analysis + possible
  v0.3.1 corpus rebuild). Higher risk but addresses the root cause.
- Thread C: 1-2 days (two retraining runs + golden eval).

## Suggested execution order

Operator decision; the host-side claude assistant suggests Threads A +
B in parallel (different focus areas, no conflict), then Thread C only
if neither lands a clear win.

## Related

- #57 — v0.3.0 ship
- #116 — this v0.4.0 ship
- PR `issue-116-phase-2-x-v0-4-0` — branch with the v0.4.0 retrospective
- `LOG.md` 2026-05-23 06:25 entry — full iteration retrospective
- `TODO.md` item #3 — `mailwoman corpus-audit` (Thread B prereq)
