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

## What went well

- **Verify-before-verdict, twice.** The LT=0% "catastrophe" was a broken eval holdout (the gazetteer has the data); #582 was already resolved by a different route than the issue proposed. Both would have been wasted effort if taken at face value.
- **Diagnostic-before-fix on lever 2.** Measuring the recall first falsified the "widen aliases" premise before any builder change — the gap is eval noise + coverage, not aliases.
- **The gate held the promote honest.** Lever 1 shipped only after the coordinate-graded e2e went 4/4 green against the staged DB.

## What could've gone better

- _(to be filled as the shift continues)_

## Decisions made autonomously

- **Promoted lever 1** (demo asset swap to `-20c`) under the granted promote authority, gated on the 4/4 e2e + US guardrail.
- **Stopped lever 2** rather than grind a falsified alias-widening — filed #734 with the real findings + the harness instead.
- **GB postcodes excluded** from the candidate table (2.6 M rows would ~5× the file for marginal demo value).

## Open questions

- _(to be filled)_

## Concrete next steps

- #694 record-matcher root-cause (in progress), then v1.8.0 (#728) promote prep.
- Extra issues: #630 (Dependabot), #719 (comma-less FR), #620 (registry docs).
- #734 follow-ups: fix the LT eval extraction; consider base-name aliasing for qualified OA names.

## Numbers

|                               | value                                       |
| ----------------------------- | ------------------------------------------- |
| candidate DB                  | 494 → 529 MB (+435 k intl postcodes)        |
| EU locality recall (measured) | 93.4% (headline 87.8% was LT-eval-artifact) |
| browser e2e                   | 4/4 green (incl. coordinate-graded Berlin)  |
| GPU spent                     | 0                                           |
| issues closed / filed         | #582 closed; #734 filed                     |
