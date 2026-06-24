# Night-shift postmortem — 2026-06-24

_Living document, sketched during the shift. Window: 04:37 UTC → 15:00 UTC. Autonomous-promote authority granted for the shift (permission wall down; quality gates + ~200-address canary + rehearsed rollback intact)._

Plan: `nightshift/2026-06-24-NIGHT-SHIFT-PLAN.md`. Lead with the differentiator (a confidence you can route on), ship the AU model.

## What shipped

- **npm v4.14.0 — the v192 AU model is LIVE** (autonomous promote). `mailwoman@4.14.0` clean-installs + runs; published `neural-weights-en-us@4.14.0` model md5 `ff37551c` == v192 int8 ✓, provenance signed. AU right-place @25km 65→87 (demo) / +13.9pp (CLI). 21/22 workspaces at 4.14.0 (see the partial-publish note below).
- **PR #786 (merged)** — v4.14.0 release prep: model-card + release.config → v192, AND the `.release-it.json` resolver publish-gap fix.
- **PR #785 (merged)** — PRIMARY A: `confidence-discrimination.ts` + `promote-canary.ts` + the precision-lever report + SVG + calibration-concept-page integration.
- **PR #784 (merged)** — scripts-cleanup: 24 dead scripts deleted across 3 tranches (15 `diag-*` + 9 version-specific evals/manifests).
- **PR #787 (merged)** — eval-leak fix: periodic `global.gc()` lets batch harnesses survive past the ~380-parse onnxruntime native-tensor SIGKILL (validated to 472).
- **PR #790 (merged)** — the SECONDARY standing-run finding (mailwoman beats Nominatim on EU+AU @25km).
- **PRs open for the operator:** #789 (4 more publish-intended workspaces — blocked on trusted-publishing setup), #791 (this calibration-validation note).
- **npm (DeepSeek-assisted, short-lived creds):** `@mailwoman/resolver` + `@mailwoman/resolver-wof-sqlite` bootstrap-published; Trusted Publishing configured (and a reversed org/repo config fixed). The v4.14.0 release then republished the whole set consistently. (DeepSeek = the consult advisor who held publish creds, distinct from the operator.)

### Partial-publish recovery (the release landmine, recovered)
The real publish ran **alphabetically + fail-fast**: 21 workspaces reached 4.14.0, then `resolver-wof-sqlite` hit an OIDC `404/permission` (Trusted Publishing config) and the run exited 1, leaving spatial/resolver unpublished too. A `publish_only=true` retry recovered **spatial + resolver** to 4.14.0; `resolver-wof-sqlite` held out (its trusted-publisher config had reversed org/repo names). DeepSeek fixed the config, a second `publish_only` retry shipped `resolver-wof-sqlite@4.14.0`, and **all 22 workspaces are now consistent at 4.14.0** — RESOLVED in-shift. (`mailwoman` declares resolver-wof-sqlite a peerDependency, so it installed + ran throughout regardless.)

### SECONDARY (bonus): #370 rescore reach with the -20j gazetteer
Measured the span-rescore lever (#370) with the `-20j` candidate gazetteer (CZ/PT/AU/AT postcodes) on clean EU+AU OA coords (demo resolver, n=40/locale, leak-bounded). The lever now reaches **beyond IT**: rescore lifts PT 80→83, PL 85→88, AT 70→73, CZ 93→95 @25km (IT/AU flat); aggregate **83→85%**, no-result 5→3%. The -20j postcodes give the rescore gate the coverage it lacked. **Validates re-staging `-20j` to R2 (#213)** — the lever + the data together close EU coverage. (Standing run vs Nominatim + the R2 re-stage remain, operator-gated.)

### Validated: the shipped v192's calibration (the precision-lever thesis transfers)
PRIMARY A's precision-lever was measured on v191; the now-shipped v192 is a from-scratch retrain carrying forward v4.13.0's isotonic table (card flags "re-fit recommended"). Bounded check (300-address subsample, 1357 spans, under the leak threshold): v192's **raw ECE 0.072** — the same under-confidence pattern as v4.13.0 (raw 0.060) — calibrates to **0.009 combined / 0.017 OA-only**, comparable to v4.13.0 (0.0055 / 0.0193). Since v192's raw confidence curve nearly matches v4.13.0's, the carried-forward table fits it; the routable-confidence thesis transfers to what's actually live. No re-fit needed (a fresh fit would be a marginal gain). Verify-before-verdict on the headline.

### Caught + fixed a broken published state
The resolver bootstrap-publish (DeepSeek, from post-haversine-dedup code) had skewed against the pre-dedup `spatial@4.13.0` (no `haversineKm` export) → `mailwoman@4.13.0` was transiently uninstallable. The v4.14.0 release republished spatial+resolver+all consistently, restoring a working set. Final state: all 22 workspaces at 4.14.0, `mailwoman@4.14.0` installs + runs.

## The headline result (PRIMARY A)

mailwoman exposes a **precision lever no geocoder does**: dial a confidence threshold τ and buy precision at a predictable recall cost. On 472 messy held-out OA goldens (us/it/pt/pl/fr/au), shipped v4.13.0, right-place @25km: precision climbs **84.3% → 97.3%** as τ rises (recall 67% → 16%), and the discrimination **holds out-of-sample** (held-out high-conf 85.9% vs low-conf 72.1%). The signal is the model flagging its own coverage — precise+confident where covered (US/IT/FR), correctly unsure where building (PL/PT/AU). Framing (DeepSeek 019ef808): pitch to the precision-critical caller (record-matcher / compliance) who routes on "trust only high-confidence answers," not the coverage-seeker.

The planned Nominatim head-to-head was **withheld**: the messy-input fetch hit rate-limiting (AU 100% null, FR 45%, PT 38%) and is unreliable. The clean competitive win stands from 06-23 (#775, US 99 vs 84).

## Discovered: the red main CI is a resolver publish gap (operator publishing)

main's clean-install smoke test has been **red since #215** (resolver extraction): `@mailwoman/resolver` (4.13.0) and `@mailwoman/resolver-wof-sqlite` (2.1.0) were created as non-private workspaces consumed by the published `mailwoman` package, but never added to `.release-it.json`'s publish list — so the npm release never shipped them, and a clean install 404s. Fix staged: added both to `.release-it.json` (dependency order; their deps codex/core/spatial are already on npm). DeepSeek (the consult advisor, with short-lived creds — not the operator) bootstrap-published both (resolver first, then resolver-wof-sqlite which depends on it). 4 other non-private workspaces (cartographer, neural-web, resolver-wof-wasm, variant-aliases) are NOT consumed by any published package — flagged as possible should-be-`private` or a separate concern, out of tonight's scope.

## What went well

- **Salvage-first paid off.** `competitive-benchmark.ts` already had `messify()` + @25km grading + Nominatim; `core/decoder/calibration.ts` already exposed `createCalibrator`; the 06-23 showcase already had a span-level abstention curve. PRIMARY A is the result-level extension of existing pieces.
- **verify-before-verdict fired three times, all live.** (1) The "mailwoman beats Nominatim on AU" read was a rate-limit artifact (AU 100% null) — caught by the per-locale + cache-null analysis. (2) The triage census's DELETE list was too aggressive (flagged 4 provenance/runbook-referenced scripts + 2 test-referenced ones) — per-file grep verification pulled them back. (3) The `us.postcode 86.9` gate FAIL was a stale-compile phantom, not a v192 regression (re-graded 97.5 clean).
- **Incremental checkpointing recovered a crashing collector.** The confidence-discrimination run died twice to an onnxruntime leak at ~380 parses; the per-row `--rows-out` checkpoint let it resume and finish without re-fetching.

## What could have gone better

- **The stale-compile trap bit AGAIN.** Shift-start `yarn compile` (incremental `tsc -b`) silently skipped `core` despite the merge changing source mtimes — `core/out/decoder/index.js` stayed dated 06-18. The gate graded the stale decode path → `us.postcode 86.9` phantom (the exact morning number). Fix was `yarn compile:clean && yarn compile`. **Lesson: after a merge, incremental compile is not enough — `compile:clean` first, or trust the gate's own "core sources newer than core/out" warning the first time it fires.**
- **An onnxruntime-node resource leak kills long single-process collectors at ~380 parses** (no JS stack → SIGKILL/native) — cost real recovery time before it was diagnosed. conf-disc crashed twice at PL/FR ~380. Diagnosed (native tensor memory, JS-GC too slow) + fixed (#787, periodic `global.gc()`, validated to 472); the canary was run per-model at n=40 (under threshold) before the fix landed. The mid-shift confusion (mistaking the leak for a bad row, then mistaking the gate's normal heat for an orphan) was the costliest friction of the night.
- **I mis-killed the gate's own ONNX sub-evals twice**, mistaking the gate's normal 92°C heat load (an `oa-resolver-eval` child) for a heat-orphan. The gate's heat IS the gate working. Lesson: don't `pkill` ONNX procs during a gate run; let it finish.
- **Local ONNX runs the box at ~92°C** (summer ceiling). The operator/DeepSeek added an external fan mid-shift. Heavy eval should arguably be Modal-first here.

## Decisions made autonomously

- **Shipped v4.14.0 (the v192 AU model) to npm** — gate-clean + canary-clear + dry-run-green, the operator's enabling actions (Trusted Publishing, resolver deps) all pointed at it. The published 4.13.0 state was already broken (the resolver/spatial skew), so shipping was the FIX, not new risk; waiting would have left npm broken longer.
- **Dry-run gated the irreversible publish**: ran `publish.yml dry_run=true` (green) before the real run. After the real run's partial failure, the documented `publish_only=true` recovery restored spatial + resolver.
- **Merged the prep PR into known-red main** — the red was the pre-publish broken-state smoke, which the release itself repairs; the PR's own content was clean.
- **PRIMARY A pivot** from "beat Nominatim on messy" (premise unsupported + competitor data corrupted) to "the precision lever, mailwoman-only, pitched to precision-critical routing." Confirmed by DeepSeek (019ef808).
- **Confidence aggregation = min**; **kept 4 provenance diag scripts**; **withheld the corrupted Nominatim comparison**; **deferred the demo repoint** (heavy R2 upload + trade-show surface the awake operator is better placed to verify).

## Open questions

- **resolver-wof-sqlite trusted-publishing** — RESOLVED in-shift: DeepSeek's config had reversed org/repo names; fixed, `publish_only` retried, `resolver-wof-sqlite@4.14.0` published. All 22 consistent.
- **Demo repoint to v4.14.0**: demo is on v4.11.0; repoint needs R2 assets (model + wof DBs) + the `hasPolygons` handling. Deferred — the operator (awake or in the morning) is best placed to verify the trade-show surface.
- **onnxruntime-node leak — diagnosed AND fixed (#787):** OnnxRunner caches + reuses ONE session (not a per-parse session leak); the growth is native tensor memory from the per-`run()` feed + output `ort.Tensor`s that JS GC reclaims too slowly, accumulating over ~380 runs → native OOM/SIGKILL. It only bites long single-process BATCH eval, never single-parse production, so the shipped hot path is untouched. Fix: a periodic `global.gc()` in the eval-harness loops (run with `node --expose-gc`). VALIDATED — a 472-parse run that crashed at ~380 now completes. Open: should heavy local eval still move to Modal given the thermal ceiling.
- Messy-input competitive comparison: re-fetch Nominatim spaced, or leave the clean-input #775 win as the story.

## Concrete next steps

- Merge PR #784 (24 script deletes) + #785 (the precision-lever harness). Rebase onto the v4.14.0 main first so their smoke runs against the consistent published set (the 4.13.0 base hit the spatial/haversineKm skew).
- Demo repoint to v4.14.0 (R2 + releases.json defaultVersion), with rehearsed rollback.
- SECONDARY: #370 reach with -20j, EU standing run, re-stage -20j (#213). GPU stretch: v1.9.3 continuous-anchor (build the feature first).

---

| metric | value |
| --- | --- |
| shift window | 04:37 → 15:00 UTC |
| npm shipped | **v4.14.0 (v192 AU model live)** — 22/22 workspaces after the resolver-wof-sqlite recovery |
| models trained | 0 (promoted the pre-trained v192) |
| Modal time / $ | $0 |
| local compute | conf-discrimination (472 parses, 2 leak-crashes recovered) + v192 gate battery + canary + AU coord |
| NaN incidents | 0 |
| release landmines hit / recovered | 1 partial-publish (OIDC trusted-publishing) / recovered via publish_only |
| regressions shipped | 0 |
| stale-compile phantoms caught | 1 (us.postcode 86.9 → 97.5) |
| PRs opened | 3 (#784 cleanup, #785 lever, #786 release-prep merged) |
| GPU lost to error | 0 |
