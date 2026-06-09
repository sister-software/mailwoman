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
| country | 35.2 | 46.5 | ❌ starved (#452) — **next lever** |
| street_prefix | 0.0 | 0.0 | ❌ starved → **affix retrain in flight (v0.9.8)** |
| street_suffix | 0.0 | — | ❌ starved → **affix retrain in flight** |
| street_prefix_particle | — | 0.0 | ❌ starved (FR) |
| unit | 6.3¹ | 0.0 | ✅ FIXED (92.3 real-OOD; golden has ~no unit rows) |
| po_box | ~18² | — | ❌ starved (#452) |
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

³ v4.1.0 lumps "Wacker Dr" into one `street` span; the affix retrain teaches the split (7/10 → split, perfect precision).

> **METHODOLOGY GOTCHA (load-bearing for the campaign):** `per-locale-f1.ts`'s `foldToComponents` JOINS street_prefix+street+street_suffix into one `street` string — so it **cannot** measure the affix split and reports 0% even when the model splits perfectly. Use **`scripts/eval/score-affix.ts`** (unfolded `decodeAsJson`) for street_prefix/street_suffix. The folded `street` is still the right no-regression metric (the fold recomposes → golden street holds/rises).

---

## Parity verdict (v4.1.0)

Common tags (postcode/house_number/street/locality/region/venue-US) are at usable parity. The gap is a small set of **starved long-tail tags** — `unit` is now FIXED (the first campaign win), `street_prefix`/`street_suffix` are in flight (v0.9.8), and `country`/`po_box`/`intersection`/FR-`venue`/`cedex` remain. **Not yet at 90% macro parity**; the campaign is the path. Each lever is compounding (covering a tag sharpens its neighbors — unit lifted US street +3pp).

## Campaign status

| Lever | tag(s) | status |
| --- | --- | --- |
| unit | unit | ✅ shipped v4.1.0 (0→92%) |
| **affix** | street_prefix/suffix | ✅ **GATED v0.9.8: 0→78/67 (P=100), US net-positive, negative-space street +2.1.** FR postcode −3.9 (US-shard dilution) trips the >2pp gate → promote DEFERRED to operator (DeepSeek recommends promote-with-annotation). int8 ship-ready. |
| country | country | ⏳ next (ISO codex + shard, #452) — also recovers the FR-postcode dilution |
| po_box | po_box | ⏳ (salvaged po-box codex seeds it) |
| intersection | intersection_a/b | ⏳ (gated — regressed before) |
| FR | venue/cedex/region | ⏳ (#330) |
| consolidation | — | ⏳ v1.0 (bake winners + full regression gate) |

*Baseline captured 2026-06-09 ~04:50 UTC during the night shift. The v0.9.8-affix "after" column + a re-run on the promoted model follow at the affix gate.*
