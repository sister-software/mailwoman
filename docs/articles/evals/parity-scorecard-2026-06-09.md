# Parity Scorecard — 2026-06-09 (baseline: v4.1.0)

**Question this answers:** "How close is the neural parser to v0 (Pelias/addressit rules) capability parity, per component, and where do we still bleed?" One authoritative table per model version, so "are we at ~90%?" stops being a scatter of one-off evals.

**Read it with two lenses — they disagree on purpose:**

1. **Arena head-to-head (whole-address-strict):** the 3 unbiased capability arenas (`scripts/eval/external-arenas.sh`, `--symmetric-match --postcode-repair`). A row counts only if the WHOLE parse matches. This is the honest "does the system produce a usable parse" lens — but it **understates per-tag wins** (a unit-perfect parse scores 0 if any other tag slips). Example below: postal-arena `secondary-unit` reads 0% here while per-tag `unit` is 92%.
2. **Per-tag F1:** `per-locale-f1.ts` on golden dev (US/FR) + the curated real-OOD evals. The granular tag-health lens — this is what the parity campaign moves.

Self-emitted (`scripts/eval/external-arenas.sh` + `per-locale-f1.ts`); do not hand-edit numbers.

---

## Lens 1 — capability arenas (v4.1.0 int8 vs v0)

| arena | n | v0 | neural | both | neural-only | v0-only | both-fail |
| --- | --: | --: | --: | --: | --: | --: | --: |
| libpostal (clean/canonical) | 69 | 29% | 22% | 14% | 7% | 14% | 64% |
| perturb (noisy/degraded) | 398 | 39% | **60%** | 32% | 28% | 8% | 33% |
| postal (edge formats) | 38 | 26% | 11% | 5% | 5% | 21% | 68% |

**Routing truth (unchanged since #15):** rules win on clean/canonical, neural wins decisively on noisy/degraded (+21pp), both are weak on edge formats (PO-box/military/rural-route). The resolver should route by input shape.

Postal-arena edge classes where BOTH are 0% (the parity frontier): `po-box` (4), `military-apofpo` (3), `rural-route` (1), `directional` (2). `secondary-unit` reads 0% whole-match here despite 92% per-tag (lens caveat).

---

## Lens 2 — per-tag F1 (golden dev, v4.1.0 int8, anchor-on)

| Tag | US | FR | status |
| --- | --: | --: | --- |
| postcode | 98.3 | 99.4 | ✅ healthy |
| house_number | 96.2 | 91.2 | ✅ healthy |
| venue | 90.2 | 0.0 | ✅ US / ❌ FR (#330) |
| street | 78.5 | 60.1 | ◐ (street-eats-affix boundary) |
| region | 78.4 | 27.8 | ◐ US / ❌ FR (#330) |
| locality | 60.1 | 69.7 | ◐ |
| country | 35.2 | 46.5 | ❌ starved → **deterministic tagger, not retrain (#464)** — see below |
| street_prefix | 0.0 | 0.0 | ❌ starved → **affix retrain in flight (v0.9.8)** |
| street_suffix | 0.0 | — | ❌ starved → **affix retrain in flight** |
| street_prefix_particle | — | 0.0 | ❌ starved (FR) |
| unit | 6.3¹ | 0.0 | ✅ FIXED (92.3 real-OOD; golden has ~no unit rows) |
| po_box | ~18² | — | ✅ deterministic tagger = 100% real-OOD (#464) |
| intersection_a/b | 0.0 | — | ❌ starved (experimental, regressed before) |
| dependent_locality | 0.0 | 0.0 | (intentionally down-weighted — WOF-schema artifact) |

¹ golden dev carries ~no unit rows; the real-OOD eval is the truth (92.3%). ² from the #15 assessment.

### Real-OOD evals (the trustworthy lens for the campaign tags)

| eval | tag | v4.1.0 | v0.9.8-affix | note |
| --- | --- | --: | --: | --- |
| unit-real-designators (34) | unit | 92.3 | **93.8** | retained ✓ |
| street-affix-real (32) | street_prefix | 0.0 | **78.0** | P100/R64 |
| street-affix-real | street_suffix | 0.0 | **66.7** | P100/R50 |
| street-affix-real | street (name) | 0.0³ | 50.0 | unfolded |
| country-real (34) | country (model v1) | — | 49.0 | **over-fires**: golden precision 23% |
| country-real (34) | country (deterministic) | — | **100.0** | `matchCountry` on trailing segment, P=R=100 |
| po-box-real (25) | po_box (model, #15) | ~18 | — | starved |
| po-box-real (25) | po_box (deterministic) | — | **100.0** | `matchPOBox` per segment; 7 negatives, 0 FP |
| cedex-real (15) | cedex (deterministic, FR) | — | **100.0** | `CEDEX` regex in-segment; 5 negatives, 0 FP |

³ v4.1.0 lumps "Wacker Dr" into one `street` span; the affix retrain teaches the split (7/10 → split, perfect precision).

> **METHODOLOGY GOTCHA (load-bearing for the campaign):** `per-locale-f1.ts`'s `foldToComponents` JOINS street_prefix+street+street_suffix into one `street` string — so it **cannot** measure the affix split and reports 0% even when the model splits perfectly. Use **`scripts/eval/score-affix.ts`** (unfolded `decodeAsJson`) for street_prefix/street_suffix. The folded `street` is still the right no-regression metric (the fold recomposes → golden street holds/rises).

---

## Parity verdict (v4.1.0)

Common tags (postcode/house_number/street/locality/region/venue-US) are at usable parity. The gap is a small set of **starved long-tail tags** — `unit` is now FIXED (the first campaign win), `street_prefix`/`street_suffix` are in flight (v0.9.8), `country` and `po_box` have a measured deterministic path (P=R=F1=100, #464 — not a retrain), and `intersection`/FR-`venue`/`cedex` remain. **Not yet at 90% macro parity**; the campaign is the path. Each lever is compounding (covering a tag sharpens its neighbors — unit lifted US street +3pp), and the lever-shape taxonomy below now routes each remaining tag to the right tool (retrain vs deterministic matcher).

## Campaign status

| Lever | tag(s) | status |
| --- | --- | --- |
| unit | unit | ✅ shipped v4.1.0 (0→92%) |
| **affix** | street_prefix/suffix | ✅ **GATED v0.9.8: 0→78/67 (P=100), US net-positive, negative-space street +2.1.** FR postcode −3.9 (US-shard dilution) trips the >2pp gate → promote DEFERRED to operator (#462; DeepSeek recommends promote-with-annotation). int8 ship-ready. |
| **country** | country | ✅ **RESOLVED — deterministic, not retrain.** The synth shard makes the model over-fire (v1 country-real 49 F1, golden precision 23% — it learns "trailing token = country"). A deterministic `matchCountry` tagger on the trailing comma-segment scores **P=R=F1=100** on country-real. Lever moves to a post-parse `ProposalClassifier` (#464); model path kept as exploration record (#463). |
| **po_box** | po_box | ✅ **RESOLVED — deterministic** (probe measured this shift): `matchPOBox` per comma-segment = **P=R=F1=100** on po-box-real (n=25, 7 negatives, 0 FP). Same closed-vocab shape as country → joins #464 as a `ProposalClassifier`, not a retrain. |
| **cedex** (FR) | cedex | ✅ **RESOLVED — deterministic** (probe this shift): `CEDEX` regex in-segment = **P=R=F1=100** on cedex-real (n=15, 5 negatives, 0 FP). Different locale + match shape than country/po_box, same taxonomy → joins #464. |
| intersection | intersection_a/b | ⏳ (gated — regressed before) |
| FR | venue/region | ⏳ (#330; cedex now resolved deterministically above) |
| consolidation | — | ⏳ v1.0 (bake winners + full regression gate) — **needs > 20k steps**: see dilution note |

> **CUMULATIVE-DILUTION LESSON (load-bearing for consolidation):** stacking synth shards into one 20k-step run dilutes each tag vs its solo run — the country run (base+unit+affix+country) dropped affix street_suffix 67→59 and street_prefix 78→75 while still under-serving country. Each added shard spreads a fixed step budget thinner. **Prove each lever solo, then consolidate with a larger step budget** (the v2-vs-v3 unit lesson, re-confirmed). Don't read a cumulative run's per-tag number as that lever's ceiling.

### Lever-shape taxonomy (why not everything is a retrain)

> **Correction (reviewed later same day):** the "closed-vocab → deterministic post-parse override" conclusion below was **reversed**. The over-firing was a training-distribution artifact (a trailing-country-only shard), and the "deterministic = 100%" was measured on a no-homograph eval — an unfair comparison. The corrected decision is **model-first with a soft gazetteer anchor** (the lexicon informs, never overrides), and the matchers become feature-sources, not a `ProposalClassifier` override. The deterministic-match P=R=F1=100 numbers below stand as *matcher-accuracy* evidence (good feature-sources), not as a justification to override the model. See [Closed-vocab fields: model-first](../plan/reference/closed-vocab-fields-model-first.mdx).

The campaign has surfaced two tag shapes that want different tools:

- **Distributional / open-vocab tags** (street_prefix, street_suffix, unit, locality) — the model has to *learn the boundary* from context. Synth shard + retrain is the right tool; these are where negative-space training compounds.
- **Closed-vocab / fixed-position tags** (country ✓, po_box ✓, cedex ✓) — a finite surface-form set in a predictable slot. A deterministic matcher gives perfect precision with zero training; a retrained model only *dilutes* it (over-fires). Use a `ProposalClassifier`, keep it default-off + byte-stable. **All three now measured at P=R=F1=100** via this route, across 2 locales (US/FR) and 2 match shapes (whole-segment + in-segment regex) — build one `ClosedVocabTagger` parameterized by (matcher, tag, slot) rather than per-tag classifiers (#464).

*Baseline captured 2026-06-09 ~04:50 UTC during the night shift; finalized ~12:25 UTC with the country + po_box + cedex deterministic results. Affix "after" = the v0.9.8 gate run; country = the v0.9.9 v1 cumulative run + the deterministic probe; po_box + cedex = deterministic probes only (no retrain — taxonomy applied up front).*
