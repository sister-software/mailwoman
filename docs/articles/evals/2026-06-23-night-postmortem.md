# Night shift — 2026-06-23 (trade-show readiness: prove the bar + the category difference)

_Living document — sketched during the shift, finalized at hand-off (15:00 UTC). Plan:
`nightshift/2026-06-23-NIGHT-SHIFT-PLAN.md`. The arc: a DeepSeek consult reframed the night from an
internal-metric push (#370's +12pp) to a competition plan — a fair head-to-head benchmark vs
Nominatim/Pelias + the one capability they structurally lack (calibrated confidence). Zero-GPU,
coordinate-graded._

## 🌅 Morning handoff — needs your eyes (priority order)
1. **Merge #774 — un-reds main.** Two fixes: the yarn.lock `@mailwoman/spatial` sync (pre-flight
   `--immutable` blocker) AND a **reconcileCoverage regression** that was already RED on main —
   `f970bc42 "Clean up types"` guarded a bucket increment with `if (counts[bucket]) counts[bucket]++`,
   so the first entity in each bucket never counted (enrolled read 0 not 1; registry/reconcile.test.ts
   red, blocking every PR). Restored the plain increment; test 8/8. **Self-merged once CI green** (a
   red main blocks all night work — flagged here, not silent).
2. _(in progress — benchmark + confidence demo; filled at hand-off)_

**Production: unchanged** — everything behind PRs; $0 GPU; no model/demo/canonical swap.

## What shipped (running)
- **Un-red main (#774)** — lockfile sync + the reconcile regression fix. The pre-flight earned its keep:
  `yarn install --immutable` caught the lockfile drift, and chasing it surfaced the reconcile red that
  the v4.13.0 CI hadn't (the Test job doesn't run --immutable, and f970bc42 landed after).
- **PRIMARY A — competitive benchmark (#775).** Harness + scorecard + US golden. The honest verdict
  (US win 99 vs 84, EU trail, the 15–22pp metric-overstatement correction). _Behavior/docs PR — left
  for operator merge._
- **PRIMARY B — live calibrated-confidence showcase (#776).** Re-fit the isotonic calibration on the
  SHIPPED v4.13.0 model (the bundled table was the stale v4.0.0 fit, the wrong mapping): held-out
  **ECE 0.060 → 0.0055** (10.9×), Brier 0.029 → 0.024. The model is *under*-confident. New
  `<CalibrationShowcase/>` draws the reliability + abstention curves live from the deployed model's own
  `calibration.json` (fresh table staged on R2; `cf-cache-status: DYNAMIC` so it propagated at once).
  Embedded in the calibration concept page; numbers refreshed so prose + visual agree. Docs build clean;
  SVG scale math replayed vs live data (caught + fixed a zoom-window clip bug before push). This is the
  trade-show centerpiece the benchmark pointed at: we can't claim "more accurate than Nominatim" on EU,
  but we can show the one thing a search index can't — a confidence you route on. _Operator merge._
  Render-verified end-to-end with Playwright (intercepting the R2 fetch with the local table): the
  component draws 24 circles (14 reliability dots + 10 abstention markers) + 2 polylines, zero page
  errors; and R2 serves `access-control-allow-origin: https://mailwoman.sister.software` on
  calibration.json (same as the working model-card.json), so it renders live in production too.
- **#370 — span-rescore, falsify then build (#777).** The benchmark localized the EU loss to *no-result*,
  not precision, so this attacks the no-result tail. Falsifier PASSED (the swap-case gold locality,
  postcode-disambiguated, lands p50 1.8 km from truth — real recall, not a same-name mirage). Built the
  rescore (raw-token enumeration + exact same-country gazetteer match); a diagnostic caught that
  shortest-span-wins was *backwards* (it grabbed the ambiguous prefix `Tomaszów` of gold
  `Tomaszów Mazowiecki`, 135 km off) — longest-wins fixed it. Coordinate-graded (#566, not the gold
  string): **78% of recoveries ≤25 km; lifts 136/259 = 53% of the EU no-result tail to a right-place
  coordinate**, at a cost of 33 (19%) >100 km mis-fires. PL fully solved (56/56, p50 1.8 km). Then
  **built the postcode-region consistency gate** in the same PR: resolve the postcode → point (the
  candidate gazetteer folds postcodes; the admin DB can't), reject matches >50 km off. IT flips
  4-wrong-207 km → 2-near-22 km; p90 206→145 km; conditional so it never hurts a locale it can't reach
  (PL untouched). Reach is bounded by candidate-DB postcode coverage (IT 97%, CZ/AU ~0) — a data limit
  that lifts as the gazetteer fills. Stays **default-off**; remaining before default-on = wire the gated
  `spanRescore` into production `resolveTree` + widen postcode coverage. _Operator merge; eval infra +
  the gated lever, no production wiring._
- **Competitive benchmark harness** (`scripts/eval/competitive-benchmark.ts`, PRIMARY A) — mailwoman vs
  Nominatim (public API) vs Pelias (geocode.earth, via the operator's git-excluded diag, dynamically
  imported so the committed harness degrades gracefully). Two-axis: resolve-rate @ coarse km threshold
  (the honest denominator, fair to centroids) + conditional accuracy; "no result" = miss. Early 4-row
  PT smoke: **mailwoman 100% / Pelias 75% / Nominatim 50% @25km** — coverage edge visible immediately.
  Full 150×7-locale run in flight.

## ⚠ THE SURPRISE — the competitive benchmark (needs operator eyes)
On clean OA held-out (150/locale, @25km right-place), **mailwoman trails BOTH competitors**: aggregate **mailwoman 59% / Nominatim 79% / Pelias 81%**. mailwoman wins only IT (92 vs 75/79); loses PL (42 vs 96/92), CZ (33 vs 88/68), AU (38 vs 97/76), AT (73 vs 97/89). This contradicted the smoke test AND our internal panel — so I ran it down:
- **Config handicap RULED OUT** (verify-before-verdict): mailwoman is ~44% across all three resolver configs — admin-only, admin+postcode-locality-intl, and the demo's actual candidate gazetteer (20h). The resolver isn't the cause.
- **Our internal "resolve-rate" OVERSTATES by ~15–22pp.** Internal PL resolve 62% but @25km right-place only 42%; CZ 52%→28%; AU 53%→32%. The gap = resolves that land >25 km (region-level / wrong same-name place). The honest right-place metric (what the plan + DeepSeek called for) reveals it. **This is the load-bearing finding: we've been grading ourselves on a lenient metric.**
- **Two confounds that soften the loss, NOT yet quantified:** (a) **the test set is OpenAddresses, which Pelias INDEXES as a source** — Pelias's 81% / p50 0.0 km is partly recall-of-its-own-data, not generalization (the home-field-advantage trap). (b) The set is clean/multi-order; the **MESSY subset** (typo/abbrev/no-postcode — where a calibrated parser should beat a search index) is NOT yet measured. That's the trade-show slice and the next test.
- mailwoman's real gap is **~45% no-result** on these messy EU addresses (parse-recall + coverage) vs Pelias ~1% / Nominatim ~20%. mailwoman's centroid (p50 1.3–1.8 km) is NOT the problem — @25km forgives it.

**THE RESOLUTION — US flips it to a good, honest story.** US @25km: **mailwoman 99% vs Nominatim 84%** (0% no-result vs 16% — OSM's US coverage gaps; TIGER + national situs win). So: **we dominate US, trail EU.** Messy: mailwoman degrades gracefully (59→49), Nominatim is robust (the "Nominatim chokes on messy" thesis is FALSE). Pelias's messy "6%" was a **geocode.earth 429 rate-limit artifact** (verified by direct query — every call now 429s) — verify-before-verdict killed a false "Pelias collapses" headline. Net trade-show framing: **lead with US dominance + calibrated confidence + deployability (30MB/browser/no-ES); present EU as the fast-improving frontier; never claim "more accurate than Nominatim" globally (false on EU, true on US — claim it precisely).** Scorecard: `docs/articles/evals/2026-06-23-vs-nominatim-pelias.md`. **Biggest internal takeaway: our resolve-rate metric overstated EU by ~15–22pp (counts >25km region-level resolves) — grade right-place @25km/PIP going forward.**

## What went well
- **Pre-flight discipline paid off twice in one chain** — the lockfile blocker → the hidden reconcile red.
- **Respecting the diag** — the geocode.earth integration stays in the operator's uncommitted file
  (git-excluded via `.git/info/exclude`); fixed only its `import` → `import type` (uncommitted) so it
  runs under the repo's strip-types loader. The committed harness never references geocode.earth.

## What could've gone better
- _(TBD)_

## Decisions made autonomously
- **Self-merge #774** (un-red main) — broad-trust grant + the "root-cause CI failures before piling on"
  mandate; a red main blocks every deliverable. Behavior/model PRs still wall-respected (operator GO).
- **Bundled the reconcile regression fix into the lockfile PR** — both are "un-red main" hygiene.

## Open questions / next steps
- The benchmark result decides the night's emphasis: if it confirms we clear Nominatim broadly, the
  marginal hour goes to PRIMARY B (the calibration-curve demo) over #370.
- PRIMARY B: the demo already tiers spans by confidence (`SpanHighlight.tier`); the new piece is the
  **calibration-curve** visualization + messy-input presets + the "Nominatim: no result" side-by-side.

## Numbers
_(filled at hand-off)_
