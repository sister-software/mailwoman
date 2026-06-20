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
- **#587 — place-autocomplete verified shipped + e2e-tested.** The FST char-level autocomplete (parts 1–3, the night-15 fix) AND the demo typeahead wiring (part-4 Option 1: debounced FST walk, `dedupeByName`, keyboard nav, comma-segment locality completion) were both already shipped — the operator's requested autocomplete is live. It just lacked e2e coverage; added `210-demo-autocomplete.spec.ts` + DemoFixture helpers (`New Yor`→New York char-level, comma-segment `Chic`→Chicago), both green against the live FST. Only the address-level typeahead (Options 2–3) remains.
- **EU qualifier-strip fallback (a genuinely-NEW build, shipped query-side).** With the backlog cleared, diagnosed the remaining EU recall gap (the lever-2 residual) as OA-form-vs-gazetteer-form mismatch — Austrian `Kraubath/Mur` / `Hart b.Graz`, Swiss `Lenk im Simmental` / `Roche VD`, Danish `Odense S` / `Hurup Thy`, where the gazetteer carries the bare base name. Added `stripLocalityQualifier` (the shared normalizer module) + a fallback in `WofCandidateTableLookup.findPlace`: on an exact-name miss, retry the stripped base (the region bbox disambiguates). Measured via a new `candidate-recall.ts --strip-fallback` mode: **AT 74.1→88.2% (+14.1pp), DK 91.5→96.2%, CH 90.4→92.6%**; +1.3pp overall (diluted by the already-100% locales). **Purely query-side — no DB rebuild, no version bump**; default-on; 15/15 normalize unit tests + 4/4 e2e green. Distinct from the falsified alias-widening (lever 2) — query-side normalization, not gazetteer aliases.

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

|                                    | value                                                         |
| ---------------------------------- | ------------------------------------------------------------- |
| candidate DB                       | 494 → 529 MB (+435 k intl postcodes), promoted `-20c`         |
| EU locality recall (measured)      | 93.4%; +strip-fallback AT 74→88%, DK 91.5→96%, CH 90→93%      |
| browser e2e                        | 4/4 green (incl. coordinate-graded Berlin)                    |
| GPU spent                          | 0 (no-GPU night; $20 contingency unspent)                     |
| issues closed                      | **5** — #582, #694, #719, #555, #728                          |
| issues triaged / filed / re-scoped | #630 triaged; #734 filed + refined; #625 re-scoped            |
| docs shipped                       | #620 data catalog + this postmortem                           |
| demo production                    | candidate `-20c` (intl postcodes) + query-side strip-fallback |
| genuinely-new builds               | lever-1 intl postcodes + the EU strip-fallback                |
