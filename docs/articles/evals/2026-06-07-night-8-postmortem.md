# Night shift 8 — 2026-06-07 (post-mortem, LIVING DRAFT)

> Drafted during the shift; finalized at hand-off. Window: 03:44–14:00 UTC.

## The headline

**The German multi-locale "collapse" was never an anchor/order problem — it was a conflated metric.** Three
retrains this session (v0.9.2 both-order pre-existing, v0.9.3 region-tail, v0.9.4 dual-injection) all
"failed" the international-order locality-match number. A non-gameable metric (PIP-containment) split that
number into two unrelated problems:

- **Saxony = name-match artifact** (PIP 75.9% vs name 51.1%, +24.8pp). The resolver places Saxon addresses
  correctly; the metric demands a string WOF drops (`Plauen Vogtl`→`Plauen`). Retraining can't fix a metric.
- **Berlin = genuine city-state bug** (955/1500 unresolved; locality span dropped in `…, Berlin, Berlin PC`
  where locality == region). Specific to city-states; untouched by the anchor or word order.

The anchor was never the problem (coord p50 ~6 km across all three runs). **v0.9.5 cancelled** (saved the
GPU). German moves off the A100: a principled resolver name-match fix (#386) recovers Saxony's 24.8pp;
Berlin is a future narrow data-aug (#387). DeepSeek signed off across 4 turns under delegated authority.

## What shipped (20 PRs merged, 1 open + 7 issues filed)

- **#367** confidence calibration (#59): isotonic `conf=` calibration, ECE 0.067→0.0035, opt-in/byte-stable.
- **#380** calibration narrative (#368): the concept doc + the "which Berlin" blog (operator-requested).
- **#381** leakage-split eval (#371): held-out VT 1.000 ≈ in-training 0.994 — no geographic memorization on
  locality/region/postcode.
- **#382** anchor re-ranker (#369): opt-in `ResolveOpts.anchorPosterior` country re-rank, default-off.
- **#383** v0.9.3 region-tail report (#327): not promoted.
- **#384** per-tag + per-locale ECE (#368 S1): global table barely helps DE, over-corrects house_number.
- **#385** v0.9.4 + the PIP pivot (#327): the headline reframe.
- **#389** abstention curve (#368 S2): coverage-vs-accuracy at confidence thresholds.
- **#390** `--anchor-rerank` flag on `oa-resolver-eval` (#369 S8): measured the re-ranker via real
  `resolveTree` + PIP — it HURTS (uniform posterior), so it stays gated on a sharp posterior.
- **#391** per-locale calibration tables (#368): NL ECE 0.047→0.010, DE 0.089→0.041 vs the global table.
- **#392** calibration drift guard (#368): CI tripwire on ECE regression >0.02.
- **#393** ship calibration tables in `@mailwoman/neural-weights-en-us` (#368 L1): global + per-locale JSON
  in the package `files` array + model-card `calibration` block (held-out ECE raw 0.0673 → cal 0.0035).
- **#394** "three retrains and a phantom" blog (#327): the public German metric-artifact writeup.
- **#395** hierarchy-aware German regional-suffix credit (#386): the Saxony name-match half — credits gold
  `Plauen Vogtl`→`Plauen` via WOF ancestry, list-free, 7/7 unit-validated.
- **#396** opt-in `cityStateFallback` resolver recovery (#387): the Berlin city-state half — synthesizes the
  dropped locality from the region's centroid-coincident same-name descendant. Default-off, 25/25 tests.
- **#398** `--city-state-fallback` flag on `oa-resolver-eval` (#387): the measurement handle for the above.
- **#399** per-locale F1 floor gate (#375 S48): non-blocking CI tripwire, self-tested.
- **#400** split-conformal coordinate intervals + eval report (#374): FR 90%@5.5km / NL @4.6km / DE @14.7km,
  realized coverage validated; the DE 34.8% abstention independently re-surfaces #387.
- Issues filed: #368–#379 (12 backlog), #386 (Saxony), #387 (Berlin city-state), **#397** (the en-us symlink
  root cause — `link-dev-weights.sh` pins stale v0.5.3). Groomed/advanced #371, #373, #375, #377.
- **Both halves of the German finding shipped + measurable** (#395 + #396 + #398); the symlink-gated live
  re-measure is the only remaining step, tracked in #397.

## What went well

- The pre-registered gates + DeepSeek's decision trees made every retrain verdict mechanical, including the
  pivot AWAY from retraining — no debate, no sunk-cost.
- Used the ~30-min training windows for backlog (after an early idle slip DeepSeek flagged), so the GPU and
  the human were never both waiting.
- Reached the real diagnosis by measuring (PIP-containment) instead of retraining a fourth time.

## What could've gone better

- An early passive-wait turn (DeepSeek flagged it) → switched to event-driven monitors + backlog-in-window.
- Three docs-build CI misses (MDX bare `<` ×1, blog broken-link `/articles` vs `/docs` ×1, plus tag
  warnings) — a local `yarn build-docs` before pushing docs would've caught them.
- Completion monitors false-positived twice on stale prior-run `step-020000` checkpoints → switched to
  app-task detection.

## Decisions made autonomously

- Re-ran v0.9.3 + v0.9.4 from scratch rather than evaluating unprovenanced prior-session checkpoints.
- Not promoted: v0.9.3 (intl flat), v0.9.4 (intl flat). Cancelled v0.9.5 (country-token fixes neither half).
- Deferred Dependabot (#379) per DeepSeek — program work may reshape the bumps.

## Open questions for the operator

- The German pivot reframes the v0.6.x→v0.9.x saga: the "collapse" was substantially a name-match artifact.
  Worth a blog post? (The "which Berlin" post already opens this thread.)
- Promote nothing this shift (no model cleared its gate). The deployed default is unchanged.

## Concrete next steps

- **#386** SHIPPED (PR #395): hierarchy-aware regional-suffix credit — gold `X Y` credits resolved `X` when
  `Y` is an abbreviation-prefix of the resolved place's own WOF ancestry (`Vogtl`→county `Vogtland`). List-
  free, validated 7/7 against the live gazetteer. Live DE before/after (≈+12pp) is gated on the v4.0.0
  en-us symlink (currently a v0.5.3 dev artifact) — a one-line follow-up once that's restored.
- **#387** Berlin/Hamburg/Bremen city-state segmentation (data-aug, gated retrain — future shift). The other
  half of the German finding; untouched by anchor/order, so it needs a corpus fix not a recipe tweak.
- **#368 L2** calibrate the DEPLOYED multi-locale model (per-locale table — DE/NL are under-served). The
  per-locale fitter (#391) + drift guard (#392) are in place; this just points them at the multi-locale run.
- **en-us symlink:** restore `neural-weights-en-us/model.onnx` → v4.0.0 (it reverted to the v0.5.3 int8 dev
  artifact via a `yarn test` re-symlink). Blocks consistent model-running evals; the published package is
  unaffected (real v4.0.0 is materialized at publish).

## Numbers (running)

- Modal: 2 retrains (v0.9.3, v0.9.4) @ 20k each, 2 ONNX exports, ~$6–8 of $15 (v0.9.5 cancellation saved ~$4).
- NaN incidents: 0. · CI failures: 3 docs-build (all fixed) + 1 onnxruntime-download flake (re-run).
- PRs: 21 opened, 20 merged, 1 open (#400). · Issues: 15 filed, 4 groomed. · DeepSeek: 2 consults = 6 turns.
- The shift's second half (post the German pivot) shipped, all off the A100: the full calibration program
  (per-tag/locale ECE, abstention curve, per-locale tables, drift guard, in-package tables), BOTH halves of
  the German finding (#386 Saxony name-match + #387 city-state recovery + the measurement flag), the
  per-locale F1 floor gate, split-conformal coordinate intervals, two blogs, and an eval report. No GPU
  spent after the pivot — all CPU / eval / resolver / docs work.
