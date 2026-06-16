# Postmortem — the coarse-placer arc, M1 → default-on → v4.9.0 (2026-06-14 day shift)

_The collaborative day-shift continuation of [night 15](./2026-06-14-night-15-postmortem.md). Night 15
shipped the coarse-placer as an int8 **model** (#581) — a 0.79 MB linear country router that nothing
consumed yet. This shift wired it into the geocoder as a **soft country prior**, proved it safe at every
step, flipped it **on by default**, and shipped the whole thing to npm as **v4.9.0**. Five PRs in a clean
stack (#606, #608, #609, #610, #611), each gated and merged on green; one DeepSeek consult; the broken-then-
fixed v4.8.0/4.8.1 release saga as the lead-in. The operator was at the keyboard throughout — every merge and
the default-on flip were authorized, not self-granted._

## What shipped

**Lead-in — the v4.8.x release saga (the cautionary tale):**

- **v4.8.0** went out (coarse-placer M3 int8 + per-region interp calibration #593 + the #481 compiled-data
  fix #594 + char-level autocomplete; the repo went public, so sigstore provenance flipped on). It was
  **broken for clean installs.** The monorepo hoists dependencies, so three classes of defect that resolve
  fine in-repo all blew up a fresh `npm install mailwoman`: `@mailwoman/core` never declared 8 hoist-masked
  runtime deps; `wof/prepare` eager-imported the _unpublished_ `@mailwoman/resolver-wof-sqlite` and did
  `new Piscina` at module scope against an `_app_worker.mjs` the `files` glob never shipped. Nothing tested
  that path, so it shipped.
- **v4.8.1 (#596)** fixed it — declare the deps, ship `out/**/*.mjs`, lazy-`import()` + lazy-`Piscina` — and
  added the permanent guard: **`scripts/smoke-clean-install.mjs` (`yarn ci:smoke`)**, which packs every
  published workspace, installs the tarballs with **no hoisting**, and runs the CLI. The static dep-audit had
  been _insufficient_ (it missed the eager side-effect and the files-glob gap); pack-install-and-run is
  authoritative. This guard then paid for itself twice more this shift.

**The coarse-placer arc (the marquee):**

- **M1 — soft prior wiring (#606, spec #605).** The placer becomes an opt-in `placeCountry` pipeline stage
  that turns a confident in-map country guess into an `anchorPosterior` fed to the resolver's existing #369
  re-rank — it _boosts_ the right-country candidate, never filters. Reuses the postcode-anchor machinery
  whole; defers to a postcode posterior; no-op on abstain/OTHER; byte-stable when the stage is absent. Wired
  into `core/pipeline`, `geocode-core`, and a `geocode --place-country` CLI flag. **Promotion gate (the
  assembled pipeline, not the component): in-map right-country 64.7 → 85.3 %, 7 wins, 0 regressions.**
- **M2 — the open-set rule (#608).** The headline finding of the shift, and it wasn't what anyone predicted:
  the ~88/88 off-map ceiling a linear char-ngram model hits was **a decision rule, not the model.** The
  OA-broadened `OTHER` head already carried the open-set signal; the old rule (softmax max-prob) just
  conflated "which country?" with "is it in-map at all?". Reading total in-map **mass** `1 − P(OTHER)` and
  routing on the in-map argmax **clears 90/90 post-hoc, no retrain** (honest dev→test 91.3, vs the 89.1
  ceiling; the _pre-registered_ Mahalanobis and reject-head came in last and unnecessary). On the assembled
  gate it lifts in-map right-country **85.3 → 91.2 %** (9 wins, 0 regressions).
- **Misroute gate (#609).** The check that gated default-on: does the prior ever push an _in-map_ address to
  the _wrong in-map country_? Resolved 2 000 in-map addresses (200/country × 10; TW has no WOF rows) with the
  country token stripped so the country must be inferred. **0 misroutes, 0 regressions** — the tier-safe soft
  re-rank never misroutes.
- **Default-on (#610).** A lazy-cached `loadDefaultPlaceCountry()` (graceful-null if the model's absent);
  `geocodeAddress` + `createRuntimePipeline` default the prior **on** (`placeCountry: false` to opt out);
  `geocode --no-place-country` disables. Both the CLI and the `/api/geocode` server light up through the one
  `geocodeAddress` chokepoint.
- **Posterior distribution (#611).** The residual: hand the resolver the full per-in-map-country distribution
  instead of the one-hot argmax, so it breaks country-ambiguous ties with its own place-level evidence and
  can never commit to a wrong argmax. Strict improvement — identical on confident cases, +1 win / 0
  regressions on the misroute set, larger on cross-border data than this US-heavy set shows.
- **Release v4.9.0.** Code-only minor cut (model unchanged at v4.6.0). Dry-run first (clean: `4.8.1...4.9.0`,
  all 13 workspaces, `workspace:*` preserved), then the real publish; tag `v4.9.0`; all 13 packages verified
  live **registry-direct**; a clean install of the _published_ `mailwoman@4.9.0` installs and parses.

## What went well

- **"Grade the pipeline, not the component" held at every gate.** The reconcile-retirement lesson is now
  reflex: M1 and the misroute gate both measure the geocoder's right-country rate against truth, never the
  placer's intrinsic F1. M2's component probe picked the _method_; the assembled gate validated it. They
  agreed, but the discipline is what makes that meaningful.
- **The open-set result is the good kind of surprise** — the fix was simpler than the plan. We expected to
  retrain (Mahalanobis-on-the-manifold or a binary reject-head); instead a one-line decision-rule change
  cleared the bar. Pausing to write up _why_ (the mass-vs-argmax decomposition) before wiring it kept us from
  cargo-culting the pre-registered method.
- **The DeepSeek consult earned its latency.** It had pre-registered the methods that _lost_, so an
  independent check on the contradiction mattered — and it returned the sharpest insight of the shift: 90/90
  is the wrong objective for a _soft_ prior. A false-reject forfeits a disambiguation win; a false-accept
  costs ~nothing (tier-safe re-rank). The asymmetry is why the threshold stays permissive and why the
  misroute gate, not a symmetric metric, was the right default-on bar.
- **`ci:smoke` did its job.** Born from the v4.8.0 break, it gated default-on (which added a lazy
  `@mailwoman/core/coarse-placer` import to the `parse` path) and the v4.9.0 cut. The release was verified
  three ways: dry-run, registry-direct, and a clean install of the published artifact.
- **Clean stack, clean history.** Five PRs, each compiled + linted + tested + gated, merged on green in
  order, with the eval reports committed beside the code that they grade.

## What could've gone better

- **v4.8.0 shipped broken to npm before the guard existed.** The clean-install class of bug is invisible to
  the in-repo test suite by construction (hoisting hides it), and the static dep-audit missed the eager
  side-effect + the files-glob gap. We caught it on the _next_ install attempt, not before publish. `ci:smoke`
  closes the window now, but the lesson cost a bad version on the registry.
- **The misroute eval is conservative and can't fully validate thin-coverage locales.** Absolute right-country
  rates were depressed (NL 35 %, KR 26 %) by the en-US model being OOD on non-US addresses + thin WOF coverage
  — so the eval cleanly answers the _misroute_ question (0) but doesn't certify resolution _quality_ for NL/DE/
  KR. The distribution's real value (European cross-border namesakes) is likewise under-exercised by a US-heavy
  test set. Both want a locale-native eval set we don't have yet.
- **A cross-PR doc dependency bit the merge order.** The M1 code comments reference the soft-signal spec, which
  lived on its own branch (#605) — so #605 had to merge before #606 or the path wouldn't resolve. Worked, but a
  self-contained PR would've avoided the ordering constraint.
- **Recurring small friction:** the `prettier-plugin-jsdoc` reflows one-line `/** … */` comments onto two lines
  and then `eslint`'s `jsdoc/multiline-blocks` flags them — hit it three times, fixed each by switching to a
  `//` line comment. And I committed the M2 Phase-1 eval to `main` directly once (no real harm — moved it to a
  branch before pushing), a reminder to branch _first_.

## Decisions made (operator-authorized; rationale recorded)

- **Promote the OA-broadened model as the placer default** — a strict Pareto improvement over M3 (trained
  families → 100 %, unseen +13pp), operator-approved.
- **Open-set via `p_inmap`, not the pre-registered Mahalanobis/reject-head** — evidence-driven; the simpler
  rule dominated and made Phase 2 (a retrain) unnecessary.
- **Threshold stays 0.9.** On the assembled gate the operating point is a flat optimum in [0.5, 0.9]
  (identical wins/regressions). The asymmetry favors recall, but a lower threshold buys nothing here while
  raising misroute _exposure_, so 0.9 (inject only when confident) is the conservative pick.
- **Flip default-on** after the misroute gate came back clean — the operator's call (a user-facing default
  change), taken with the gate as evidence.
- **Ship the distribution upgrade** rather than leave it documented-but-deferred — it's a strict, principled
  improvement with no downside.
- **v4.9.0 = minor** (new user-facing features), code-only (model unchanged).

## Open questions

- **A locale-native eval.** The misroute gate and the distribution are both under-exercised by the US-heavy
  coarse-placer test set. A European cross-border set (NL/DE, ES/IT, FR/BE namesakes) would quantify the
  distribution's real value and certify thin-coverage resolution quality — neither of which today's data can.
- **Default-on with `defaultCountry` set.** The prior's value is concentrated in the no-locale-gate path. In
  flows that already pin `--default-country`, it's mostly a no-op — worth confirming it stays a clean no-op at
  scale rather than adding latency for nothing.

## Concrete next steps

- **M3 — the browser build.** The placer is a 0.79 MB int8 linear model with a pure char-ngram featurizer; it
  can run client-side. A `@mailwoman/…` browser export + bundling the artifact would put country routing into
  the Docusaurus demo's "it all runs in your browser" story. The natural next milestone for the arc.
- **Record matcher (Project #5).** Epics #598–604 are staged; the queued "review epics → fan out child tasks"
  is untouched.
- **Address-level autocomplete (#587).** The place-level typeahead shipped night-15; the street-prefix index is
  the remaining piece.
- **The reconcile loop** stays retired (re-gated night-15, #580) — no action, just don't re-promote it without
  re-grading the assembled pipeline.

## Numbers

| metric                      | value                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| shift window                | 2026-06-14, ~13:00 UTC onward (operator day shift, collaborative)                                                             |
| PRs merged                  | 5 in the arc (#606, #608, #609, #610, #611) + #596 (v4.8.1) lead-in                                                           |
| npm releases                | v4.8.0 (broken) → v4.8.1 (fix + `ci:smoke`) → **v4.9.0** (the arc)                                                            |
| packages published          | 13 × 3 cuts, all verified registry-direct at 4.9.0                                                                            |
| gates / evals run           | M1 country-disambig, M2 open-set (component, honest dev→test), M2 pipeline, across-11 misroute (2 000 rows), distribution A/B |
| models trained              | 0 — M2 was a _decision rule_, no retrain (the OA retrain was night-15)                                                        |
| Modal / GPU time            | 0 (CPU-only)                                                                                                                  |
| DeepSeek consults           | 1 (open-set validation → the asymmetry insight)                                                                               |
| misroutes (default-on gate) | 0 / 2 000 in-map addresses, 10 countries                                                                                      |
| in-map right-country        | 64.7 % → 85.3 % (M1) → **91.2 %** (M2, assembled gate)                                                                        |
| self-merges to main         | 0 — every merge operator-authorized                                                                                           |
| CI failures                 | 0 in the arc; the lead-in fixed the v4.8.0 clean-install break                                                                |
