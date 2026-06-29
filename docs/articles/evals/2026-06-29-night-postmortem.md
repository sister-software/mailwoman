---
title: Night shift 2026-06-29 — postmortem
description: Autonomous night shift — release completion, the casing fix, Gauntlet, OSM association recovery.
---

# Night shift 2026-06-29 (02:00–16:00 UTC)

> Living document — sketched during the shift, finalized at hand-off.

Continuation of the day's FR rooftop precision arc. Full autonomy granted (release + merge authority).

## What shipped

- **v4.16.0 promoted to the demo (R2/nexus-public).** The bare-French-street parse fix is **live** —
  default flipped, served model md5-verified = v194 (`eb76ae49…`), all 7 soft-feed channels carried
  byte-identical from v4.15.0 (a full-dir carry caught `calibration.json` + `postcode-de.bin` that
  enumeration would have missed). Decoupled state: demo = v4.16.0, npm/HF = v4.15.0. Reversible.
- **#252 casing-invariance fix** (`16efca97` on main). #690's all-caps title-casing corrupted 2-letter
  state codes (`NY`→`Ny`, `DC`→`Dc`) → the model dropped the region. Preserve ≤2-letter all-caps runs.
  Metamorphic INV 14/20 → 19/20. **Found by the Gauntlet on its first run.** Lowercase residual filed (#829).
- **Gauntlet Phase-1 — merged to main** (`e9f0126d`, PR #830). Full-pipeline integration-test harness:
  regression + metamorphic + held-out, the DeepSeek-designed three-layer net. The integration net the
  operator was worried being blind to is now on main, where C6/C7 build on it.

## What went well

- The Gauntlet paid for itself immediately: caught the casing bug + gave v4.16.0 its held-out generalization
  cover. Building the integration net before it was "needed" was the right call.
- The release's full-dir byte-identical carry (vs enumerating artifacts) caught two soft-feed files I'd have
  dropped — a missed `calibration.json` / `postcode-de.bin` would have cratered the live demo.

## What could've gone better

- The two-backend release (npm←HF, demo←R2/nexus-public) took a long reverse-engineering pass at the shift
  boundary — the nexus-public credential split + the polygons-GET-403 are gotchas worth a runbook line.
- **The staged-scoped pre-commit hook bit again.** The #252 fix touched `neural/case-normalize.ts`, but a
  *second* test file (`neural/test/case-normalize.test.ts`) carried the same assertions — the hook runs only
  the staged file's tests, so it greened locally while CI went red on the un-staged copy. Both casing pushes
  red'd main for ~25 min before I caught it. The standing lesson (memory: precommit-hook-staged-scoped) is
  to run the full package suite after a cross-cutting change; I leaned on the hook and paid the CI round-trip.
  Two co-located test files for one module is itself a smell worth consolidating.

## Decisions made autonomously

- **Fired the v4.16.0 demo promote solo** — byte-identical carry + post-flip md5 + soft-feed verification;
  reversible. The npm side deferred (trusted-publishing setup for @mailwoman/osm; nothing depends on it).
- **#252 fix in the preprocessing, not a retrain** — #690 *created* the OOD `Ny`; the model reads `NY`
  correctly, so fixing the deterministic layer that broke it is principled (not a model override). The
  ≤2-letter length heuristic over a state/directional list (structural, no list to maintain).
- **#250 via nearest-named-highway** (orphaned points aren't `addr:place`; 301k highways available) —
  validating accuracy on ground-truth BEFORE the full build (the falsifier).

## D9 — #250 association recovery (DEPLOYED as the FR default; `--recover`, code `763e51d8`)

Nearest-named-highway recovery: validated **88% precision / 95% coverage** on FR ground truth; cuts the
association gap **58% → 1.3%** (648k points, shard 477k → 1.13M). **Deployed as the FR default OSM shard.**

**The verdict flipped on a measurement fix — a verify-before-verdict catch worth remembering.** The first
held-out A/B drew from ALL of France, but the OSM shard only covers Île-de-France, so most sampled
addresses had no OSM coverage either way → the recovery's win diluted to noise (rooftop +2, looked
marginal → I'd committed it default-off). Re-running the A/B drawn **IdF-only** (the region the shard
actually covers):

| ≤tol | current | recovery |
|---|---|---|
| 0.1km (rooftop) | 28 | **65** (+132%) |
| 0.5km (street) | 51 | **81** (+59%) |
| 5km (locality) | 160 | 154 (−6, noise) |
| resolved | 213 | 213 |

A coverage-limited tier MUST be gated on a draw from the COVERED region — the all-France draw nearly
killed a doubling of rooftop coverage. **This is a Gauntlet held-out improvement (C6): make the draw
region-aware.** The `--recover` flag stays explicit (validate per-locale before enabling); hosted
deployment of the shard is gated on B3 (browser tier) + #249 (ODbL legal). The local FR shard is ready.

## D10 — DE/NL rooftop shards (built + validated, auto-routed)

OSM rooftop tier extended to DE + NL with the existing pipeline (no code change — `de`/`nl` were already in
`COUNTRY_TO_STREET_LOCALE`, so `supportedOsmCountries()` + the provider routed them once the shards existed):

| shard | points | size | assoc. gap | acceptance |
|---|---|---|---|---|
| DE / Berlin | 450,900 | 108 MB | **0.3%** | Unter den Linden #1 → (52.5172, 13.3978) ✓ |
| NL / whole country | 9,919,996 | 2.3 GB | **0.0%** | Damrak #1 → (52.3770, 4.8979) ✓ |

**Finding: the association gap is import-specific, not universal.** FR/IdF's 58% gap was a cadastre-style
import (addr:housenumber nodes with no addr:street); DE-Berlin and NL (BAG) tag streets, so `--recover` is
an FR-specific lever, not a blanket pass. Measure the gap before reaching for recovery. The shards are local
artifacts; public deployment is gated on B3 (browser tier) + #249 (ODbL legal). NL at 2.3 GB is too big for
browser httpvfs as-is — a sub-region (Amsterdam) would be the demo shard.

## Open questions / next

- C6: **region-aware held-out draw** (the lesson above) + a verified-coord US source. C7: grow regression +
  metamorphic. B3: browser OSM rooftop tier (the demo's visible rooftop). D10: DE/NL shards (now with
  `--recover` validated per-locale).

## Numbers

| | |
|---|---|
| Shift window | 02:00–16:00 UTC |
| Models trained | 0 (release of v194 from the day) |
| Modal $ | $0 so far ($20 budget) |
| CI failures | 2 main reds (the #252 second-test-file miss), caught + fixed in ~25 min; #828/#830 caught pre-merge |
| Demo regressions | 0 |
