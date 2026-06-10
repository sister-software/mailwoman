# Parity Scorecard — 2026-06-10 (baseline: v4.2.0, the consolidation flag-plant)

Supersedes [2026-06-09](./parity-scorecard-2026-06-09.md). Same two lenses, same rules:
arena head-to-head is whole-parse-strict (honest, understates per-tag wins); per-tag F1 is
what the campaign moves; real-OOD columns are the truth for campaign tags. Self-emitted
from `external-arenas.sh` + `per-locale-f1.ts` + the real-OOD scorers — do not hand-edit.

**What changed since 06-09:** the v1.0 consolidation campaign concluded (Runs A/B/C, the
measured 29M stability ceiling — see `2026-06-10-consolidation-session.md`), Run B shipped
as **v4.2.0** after a 4/4 ship gate (`2026-06-10-night-10-ship-gate.md`).

## Lens 1 — capability arenas (v4.2.0 int8 vs v0; gaz-handicapped, see caveat)

| arena | n | v0 | neural | both | neural-only | v0-only | both-fail |
| --- | --: | --: | --: | --: | --: | --: | --: |
| libpostal (clean/canonical) | 69 | 29% | 19% | 12% | 7% | 17% | 64% |
| perturb (noisy/degraded) | 398 | 39% | **58%** | 30% | 28% | 9% | 32% |
| postal (edge formats) | 38 | 26% | 8% | 5% | 3% | 21% | 71% |

> **CAVEAT (measurement, not model):** `harness-v0-neural` cannot feed the gazetteer
> lexicon, so the gaz-trained v4.2.0 is graded with zero-filled clues — a configuration
> that ships nowhere. v4.1.0 (non-gaz) was graded at full strength. The 2–3pp whole-parse
> dip vs 06-09 is part artifact, part the stated street/unit re-baseline. Follow-up: gaz
> support in the arena harness. The routing truth is unchanged — rules win clean, neural
> wins noisy (+19pp), both weak on edge — and the grown `v0-only` cells are #478's bounty.

## Lens 2 — per-tag F1 (int8, gaz-fed, golden dev + real-OOD)

| Tag | US (4.1.0 → 4.2.0) | FR (4.1.0 → 4.2.0) | status |
| --- | --- | --- | --- |
| postcode | 98.3 → 97.3 | 99.5 → 99.6 | ✅ (stated −1.0 US) |
| house_number | 96.2 → 96.9 | 91.2 → 94.6 | ✅ FR best ever |
| locality | 60.1 → **72.9** | 69.7 → 70.7 | ✅ +12.8 |
| region | 78.4 → **89.1** | 27.8 → 27.6 | ✅ US / ❌ FR (#330) |
| country (homograph) | ~0 → **89.8** | — | ✅ the lever, banked |
| street (folded) | 78.5 → 76.2 | 60.1 → 58.2 | ◐ stated re-baseline (−2.3; #492/#478) |
| street_prefix / suffix | 0 → **64.9 / 48.8** | — | ◐ exists at P≈100; ceiling measured (#492) |
| unit | 92.3 → 90.6 (real-OOD) | — | ✅ retained (stated −1.7) |
| US micro | 80.2 → **84.8** | — | ✅ |
| DE native locality | — | — | ✅ 90.9 (beats Pelias 85.9) |
| po_box / cedex | starved | starved | ⏳ ride the next consolidation-class run (#492 rider) |
| intersection_a/b | 0 | — | ⏳ eval-first (#487) |

## Campaign status

| Lever | status |
| --- | --- |
| unit | ✅ banked (v4.1.0), retained at 90.6 |
| affix | ✅ **exists** (0 → 64.9/48.8, P≈100); solo-level stability requires architecture (#492) |
| country | ✅ **banked** (89.8, gazetteer soft anchor; over-fire 0) |
| consolidation v1.0 | ✅ **SHIPPED as v4.2.0** — the flag-plant, with stated re-baselines |
| FR venue/region | ⏳ #330 — the next training lever |
| intersection | ⏳ #487 eval-first |
| architecture escalation | 📋 #492 — operator GO required |
| **arbitration** | 📋 **#478 — the post-parity capstone: converts every `v0-only` cell above into `both`** |

*Emitted night-10, 2026-06-10. Gate provenance: canonical config bars; re-baselines stated
in the ship-gate doc and the night plan, never silently.*
