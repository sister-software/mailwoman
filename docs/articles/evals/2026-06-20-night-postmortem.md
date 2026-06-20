---
title: "Night shift 2026-06-20 — candidate-gazetteer internationalization + hardening"
---

# Night shift 2026-06-20 — postmortem

_Living document — sketched during the shift, finalized at 15:00 UTC hand-off._

A no-GPU coverage + hardening night, continuing the day's candidate-gazetteer arc. Primary: internationalize the byte-range candidate gazetteer + harden the builder, each graded on the assembled coordinate. Operator granted push + promote authority (gates bind); $20 Modal as contingency (unspent — the plan is no-GPU).

## What shipped

- **Lever 1 — DE/FR/EU postcodes in the candidate gazetteer (promoted, `-20c`).** The builder's `--postcodes` pass was US-only; folded in `postalcode-intl.db` (NL/FR/DE/ES/IT, 435 k real-coord rows) alongside US. 529 MB (+7%), US postcodes unchanged (33,967). Effect: an ambiguous postcode resolves precisely instead of via the country-gate crutch — 10115 now carries the Berlin DE point (52.53, 13.38), so a Berlin address resolves to the postcode (more precise than the locality) and still can't drag to NYC. Uploaded to R2 (range GET 206 / Range-less 403 via the WAF rule), browser e2e **4/4 green** (Berlin test now coordinate-graded), US guardrail held. Promoted (`ADMIN_GAZETTEER_VERSION → 2026-06-20c`). Commit `2e46b79e`.
- **Lever 3 — `build-candidate` unit test (6 tests).** Denormalized single-probe shape, shared-normalizer parity (Saint-Étienne → saint-etienne), alias-bag explosion, region abbrevs, the postcode 0,0-coord filter, page_size=8192 / WITHOUT ROWID. Commit `2e46b79e`.
- **Lever 2 — EU surface-variant aliases: MEASURED → falsified (clean negative).** Built a candidate-table locality-recall harness (`scripts/eval/candidate-recall.ts`, commit `eed441d2`). Real EU recall is **93.4%**, not the ~88% headline — which was depressed entirely by a **broken LT holdout** (its `expected.locality` are fragments + abbreviations `m.`/`k.` + genitive case; LT actually has 20,960 localities in the gazetteer). The remaining ~6.6% misses are qualified OA names (`Kraubath/Mur`, `Hart b.Graz`, `Roche VD`) + small coverage holes — **alias-widening fixes none of them**. Because the normalizer is shared (build==query), an "absent" miss can only be a missing surface form, never a normalization bug. Documented in **#734**.
- **#582 — closed (verified resolved).** `locale-flag.test.ts` was reworked model-independent (`--isolated` rule-only + ZIP fast-path + non-emptiness assert); CI runs the full `ci:test` green with no skip guards, so it runs and passes without weights. The durable `skipIf` pattern is already the idiom for the genuinely data-dependent suites.
- **#694 — closed (record-matcher geocode drop resolved).** The geocode-core normalize-case leg is shipped as the default (#713, `geocode-core.ts:265`). Added per-source geocode-rate logging (the issue's decisive diagnostic, commit `dc497b0b`) and re-ran the exact config: **both the baseline and the corpus-frequency-on run geocode 100% per source (1200/1200)** with normalize-case on. The night-16 "100→39.2%" aggregate drop no longer reproduces — it was an artifact of the since-reverted uncommitted wiring, superseded by #713.
- **#728 — closed (v1.8.0 confirmed already promoted).** A planned "promote prep" became a verify: the production releases manifest `defaultVersion` = `v4.11.0`, and the published `en-us/v4.11.0/model.onnx` md5 = `d163396c` = the v180 / v1.8.0 int8 artifact. So v1.8.0 (FR coord p50 42→2.2 km, US assembled coordinate flat) was already released. No re-release — verify-before-verdict avoided shipping an already-shipped model. Memory corrected.
- **#719 — closed (comma-less FR street_prefix resolved by v1.8.0).** Ran `boundary-stress-gate.ts` on the shipped v180: the fr-prefix shape scores street_prefix **80% at conventions=auto** (PASS, target 70), vs the **0%** the issue documented for v1.7.0. The v1.8.0 fr-admin-split shard teaches FR `street_prefix` robustly enough that the ship-config no longer craters it — the catastrophic auto-mask destruction is gone.
- **#555 — closed (non-Latin quarantine resolved by #519 NFC).** The Bengali `দক্ষিণ কোরিয়া` row that quarantined as `span-out-of-bounds` now aligns. Root cause: the precomposed `য়` (U+09DF) is NFC-composition-excluded, so NFC decomposes it (13→14 code units). Already fixed upstream of locateSpan by the #519 NFC normalization (`align.ts:90` — added after the issue): `raw` is NFC-normalized before span location and the NFC raw is stored, so the span is in-bounds. Added the combining-mark regression test (29/29 align tests green).
- **#630 — triaged (Dependabot, left open).** Verified **zero consumer-facing exposure**: no vulnerable package is a dependency of any published `@mailwoman` package — all are dev/build/docs/release/ingest tooling. The high-severity ones (tar, serialize-javascript) are major-bump-blocked by parent `^6` ranges; the clean fix is attended intermediate-dep bumps + a release dry-run, not unattended resolution-forcing. Reframed the urgency from "security incident" to "build-tooling hygiene".
- **#620 — done (record-matcher data catalog).** `registry/configs/record-matcher-sources.json` (machine-readable provenance + the JSON-able `ColumnMapping` per source) + `docs/articles/concepts/record-matcher-data-catalog.md` (prose: the geocode-first / no-shared-key join model, per-source schema, refresh procedure). Mappings are now version-controlled, not folklore. Neutral framing throughout.
- **EU postcode coverage (the night's biggest coverage win, promoted `-20d`).** After the strip-fallback (which lifted locality recall), built Overture-derived postcode centroids for 13 EU-coverage locales via the generalized `overture-es-postcode-centroids.ts --pc-len 0`, and graded the coordinate with a new `postcode-vs-locality-probe.ts`. Postcodes resolve **100% at postcode-precision** where the locality path misses — **LT 0→100% (p50 0.3 km — the broken-locality holdout, now fully resolved), NO 74.8→100% (mean 33.2→1.5 km), FI 80.5→100% (12.9→3.3 km), SK 78.1→100%**; AT/CH/DK/BE/HR/LU/LV/SI hold 100% at comparable-or-tighter coord. Promoted `-20d` (6/6 e2e green, no regression, US byte-identical; PT excluded as sparse). This applied verify-before-verdict to a _real experiment_: the #474 "gap closed" was for ES (which had coverage) — the no-coverage locales were a clean, large win.
- **#587 — place-autocomplete verified shipped + e2e-tested.** The FST char-level autocomplete (parts 1–3, the night-15 fix) AND the demo typeahead wiring (part-4 Option 1: debounced FST walk, `dedupeByName`, keyboard nav, comma-segment locality completion) were both already shipped — the operator's requested autocomplete is live. It just lacked e2e coverage; added `210-demo-autocomplete.spec.ts` + DemoFixture helpers (`New Yor`→New York char-level, comma-segment `Chic`→Chicago), both green against the live FST. Only the address-level typeahead (Options 2–3) remains.
- **EU qualifier-strip fallback (a genuinely-NEW build, shipped query-side).** With the backlog cleared, diagnosed the remaining EU recall gap (the lever-2 residual) as OA-form-vs-gazetteer-form mismatch — Austrian `Kraubath/Mur` / `Hart b.Graz`, Swiss `Lenk im Simmental` / `Roche VD`, Danish `Odense S` / `Hurup Thy`, where the gazetteer carries the bare base name. Added `stripLocalityQualifier` (the shared normalizer module) + a fallback in `WofCandidateTableLookup.findPlace`: on an exact-name miss, retry the stripped base (the region bbox disambiguates). Measured via a new `candidate-recall.ts --strip-fallback` mode: **AT 74.1→88.2% (+14.1pp), DK 91.5→96.2%, CH 90.4→92.6%**; +1.3pp overall (diluted by the already-100% locales). **Purely query-side — no DB rebuild, no version bump**; default-on; 15/15 normalize unit tests + 4/4 e2e green. Distinct from the falsified alias-widening (lever 2) — query-side normalization, not gazetteer aliases.
- **#718 — the SECOND promote gate made ship-config faithful (eval-integrity hardening).** Audited every eval/record-matcher script's classifier construction. #718's load-bearing parts were already shipped (the canonical `createScorer` ProductionScorer; `boundary-stress-gate.ts` strict; `per-locale-f1.ts` anchor-default-on; and — via the `loadFromWeights` soft-feed default — the record-matcher dedup/cross-dataset yardsticks are anchor-ON, so the "dedup 68.0" curve was never the anchor-off artifact the issue feared). The one remaining high-stakes gap: **`eval-error-analysis.ts`, the pre-publish 2pp promote gate**, was split-brained — its no-`--model` default fed anchors but its `--model` candidate path built a RAW classifier with none, grading a freshly-trained STAGE3 candidate anchor-OFF against an anchor-ON baseline (fabricated/masked admin-tag regression, the #566/#685 trap in the other gate). Migrated both paths to `createScorer` strict (`--no-strict` for legacy); verified on the v4.11.0 ship config (strict feed did not throw → all declared channels fed), 4561-row golden. Commit `ac0d9bec`. Remaining = a low-stakes diagnostic-script tail (no decision-gating).
- **#482 — docs entry-point refresh (public SSOT un-staled).** `status.mdx` + `releases.mdx` both claimed release **4.4.0** as current — 2+ versions + several capabilities behind. Refreshed to **4.11.0** (`v1.8.0-fr-admin-split`) from the shipped model-card: version/lineage/corpus, verified-as-of date, the F1 tables flagged as the v4.4.0 baseline (the v4.11.0 headline is the _coordinate_ — FR p50 42→2.2 km, US flat — no fabricated per-tag numbers), browser-demo section rewritten to the candidate gazetteer + US/EU postcodes + shipped autocomplete + CA/NY/MI/DC rooftop, and the 4.11.0 (current) version-matrix row. Verified #397 + #190 were already-closed stale #488 boxes. Commit `74c7646c`.

## What went well

- **Verify-before-verdict resolved SEVEN issues.** #582 (reworked model-independent), #694 (superseded by #713), #719 (fixed by v1.8.0's shard, 0→80%), #555 (fixed by the #519 NFC normalization), #728 (already promoted as v4.11.0), #625 (the over-merge is a yardstick/ceiling issue, not a scorer gap — and all five levers already built), #587 (the autocomplete — FST fix AND the demo typeahead — already shipped). Measuring/checking first turned "fix these bugs" into "confirm + close," and in #728's case avoided a wasteful re-release. **This is the night's dominant signal: the backlog was overwhelmingly already-done.** The two genuinely-new builds (lever-1 intl postcodes, the EU strip-fallback) plus the new tests/harnesses were the real production; the rest was verifying + closing/re-scoping stale issues.
- **Diagnostic-before-fix on lever 2.** Measuring the recall first falsified the "widen aliases" premise before any builder change — the gap is eval noise (a broken LT holdout) + coverage, not aliases. The LT=0% "catastrophe" was the gazetteer having the data while the eval asked for genitive fragments.
- **The gate held the promote honest.** Lever 1 shipped only after the coordinate-graded e2e went 4/4 green against the staged DB.

## What could've gone better

- **Backlog staleness (systemic).** Seven issues I touched were fixed by intervening work but never closed — the backlog carried resolved items as open bugs, so a "fix these" night became a "confirm these are fixed" night. A "close on supersede" habit (when a PR fixes an issue's root cause, close it in that PR) would keep the backlog honest. **Recommendation:** a backlog-hygiene sweep — many remaining open issues are likely also already-resolved; closing them would make the open set actually reflect the work left.
- **Issue-authored fix hypotheses pointed at the wrong place.** #719 proposed "improve auto detection"; the real resolution was the v1.8.0 shard. #555 proposed "fix locateSpan's boundary logic"; the real fix was the upstream #519 NFC normalization. The issue's proposed fix is a starting point, not a spec — verify the _current_ behavior before implementing it.

## Decisions made autonomously

- **Promoted lever 1** (demo asset swap to `-20c`) under the granted promote authority, gated on the 4/4 e2e + US guardrail.
- **Closed 5 issues + triaged 1** under the granted authority, each with verification evidence in the thread (reopenable if the operator disagrees). Filed #734 for the real candidate-recall findings.
- **Stopped lever 2** rather than grind a falsified alias-widening; **left #630 open** rather than force risky unattended dependency resolutions.
- **GB postcodes excluded** from the candidate table (2.6 M rows would ~5× the file for marginal demo value).

## Open questions

- **v1.8.0's residual #727 diacritic** (~24 tokenizer-level cases) stays open — a decode/tokenizer look, not shard data.
- **A separate toLowerCase-length over-run class** (distinct from #555's combining-mark/NFC): if `raw.toLowerCase()` ever changes length vs the NFC raw (ß→ss, İ), locateSpan's haystack offsets could desync — not observed, safe-quarantined, worth a guard if it surfaces.
- **#734 LT eval holdout is broken** (genitive fragments + `m.`/`k.` abbreviations) — a corpus-side extraction fix; real LT recall is unmeasurable until it's fixed.

## Concrete next steps

- **#625 (comparison-model v2 — the record-matcher over-merge frontier)** is the next deferred stretch; the cross-dataset harness now has per-source geocode logging.
- #734 follow-ups: fix the LT eval extraction; base-name aliasing for qualified OA names (measure with `candidate-recall.ts`).
- #630 attended dependency hygiene: intermediate-dep bumps (node-gyp, webpack plugins, release-it) + a release dry-run.
- #727 diacritic residual: a decode/tokenizer look.

## Numbers

|                           | value                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| candidate DB              | 494 → ~530 MB; promoted `-20c` (intl postcodes) → `-20d` (EU postcodes)                                         |
| EU resolution (measured)  | locality 93.4% (+strip-fallback AT 74→88%); **postcodes 100% @ ~1-2 km** (LT 0→100%, NO 75→100%, FI/SK 80→100%) |
| browser e2e               | 6/6 green (4 resolve + 2 autocomplete)                                                                          |
| GPU spent                 | 0 (no-GPU night; $20 contingency unspent)                                                                       |
| verify-before-verdict     | **7** closed/re-scoped (#582/#694/#719/#555/#728/#625/#587) + the #718 audit (load-bearing parts already shipped) + #397/#190 (already-closed stale #488 boxes) |
| triaged / filed / flagged | #630 triaged; #734 filed+refined; **#735 filed** (national US street tier — operator call)                      |
| genuinely-new builds      | **3** — intl postcodes (`-20c`), EU strip-fallback, EU postcode coverage (`-20d`)                               |
| hardening / docs          | #718 pre-publish gate → ship-config faithful (`ac0d9bec`); #482 status+releases refreshed 4.4.0→4.11.0 (`74c7646c`) |
| demo production           | candidate `-20d` (US + intl + 13 EU-locale Overture postcodes; strip-fallback; autocomplete e2e)                |

## EU coordinate resolution after `-20d` (measured, `postcode-vs-locality-probe.ts`)

Per-locale, against the OA rooftop truth — the locality-centroid path (where `-20c` left it) vs the new postcode path. The postcode path resolves **100%** everywhere (PT excepted) at postcode-precision, catching every address the locality path missed:

| locale | locality resolve / mean | **postcode resolve / mean**            |
| ------ | ----------------------- | -------------------------------------- |
| AT     | 88.2% / 19.1 km         | **100% / 1.6 km**                      |
| CH     | 92.6% / 1.2 km          | **100% / 0.9 km**                      |
| DK     | 96.2% / 3.1 km          | **100% / 2.9 km**                      |
| BE     | 97.5% / 2.2 km          | **100% / 1.5 km**                      |
| FI     | 80.5% / 12.9 km         | **100% / 3.3 km**                      |
| HR     | 95.9% / 4.9 km          | **100% / 2.4 km**                      |
| LT     | 0.0% / —                | **100% / 0.5 km**                      |
| LU     | 99.7% / 0.9 km          | **100% / 0.2 km**                      |
| LV     | 100% / 12.6 km          | **100% / 2.8 km**                      |
| NO     | 74.8% / 33.2 km         | **100% / 1.5 km**                      |
| PT     | 86.3% / 7.0 km          | 0.8% (sparse Overture fill — excluded) |
| SI     | 89.5% / 3.6 km          | **100% / 2.0 km**                      |
| SK     | 78.1% / 2.6 km          | **100% / 1.1 km**                      |
