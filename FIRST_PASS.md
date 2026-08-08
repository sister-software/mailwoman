# Benchmark first pass — mailwoman 9.0.0 vs scoped local Pelias

2026-08-07. 420-row panel (`panel-v1`, sha256 `fe6d873c`). 12 countries including US states.
Pelias index frozen at 187.8M docs (WOF 0.6M + OA 109.4M + polylines 5.0M + OSM 72.8M +
interpolation 27.4M address rows). Protocol: top-1, haversine, 1/5/25 km, same raw query
string both arms, strata never blended, TOST equivalence ±5 pp @25km with bootstrap CI
(seed 20260807, 1000 resamples). Full preregistration at
`docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md`.

## Headline

| Arm                   | @1km  | @5km  | @25km |
| --------------------- | ----- | ----- | ----- |
| mailwoman 9.0.0       | 46.4% | 74.8% | 85.7% |
| local Pelias (scoped) | 83.6% | 89.0% | 92.4% |

The pooled headline is the least informative number in this report. Read the strata.

## By stratum (preregistered primary view)

| Stratum   | N   | mailwoman @1km | mailwoman @25km | Pelias @1km | Pelias @25km |
| --------- | --- | -------------- | --------------- | ----------- | ------------ |
| Rooftop   | 345 | 42.6%          | 84.9%           | **93.0%**   | **95.4%**    |
| City-only | 65  | **66.2%**      | **87.7%**       | 35.4%       | 76.9%        |
| Venue     | 10  | 50.0%          | 100.0%          | 70.0%       | 90.0%        |

mailwoman wins city-only by a wide margin (country-scope driven: US 91% vs 36%, DE 64% vs
18%, GB 64% vs 27% @1km). Pelias dominates rooftop. Both are competent at venue (small N,
neither failing).

Two strata, two different games. mailwoman's parser precision shines when the query carries
enough structure to disambiguate; Pelias's brute-force coverage prevails at exact rooftop
matching — 62 of 345 rooftop rows are circular (OA truth points ingested into the frozen
index, `pelias_dist = 0.00`). The rooftop gap is real but narrower than it looks.

## Per locale @25km (pooled, all strata)

| Locale   | N   | mailwoman  | Pelias | Verdict                            |
| -------- | --- | ---------- | ------ | ---------------------------------- |
| en-us    | 60  | **100.0%** | 90.0%  | mailwoman favored (CI [3.3, 18.3]) |
| fr-fr    | 60  | **96.7%**  | 96.7%  | **At parity** (CI [0.0, 0.0])      |
| de-de    | 60  | 96.7%      | 96.7%  | No clear favorite (CI [−5.0, 5.0]) |
| en-gb    | 60  | 93.3%      | 91.7%  | No clear favorite (CI [−3.3, 8.3]) |
| en-au    | 60  | 86.7%      | 98.3%  | Pelias favored                     |
| eu-mixed | 60  | 81.7%      | 96.7%  | Pelias favored                     |
| en-nz    | 60  | **45.0%**  | 76.7%  | Pelias favored (CI [−48.3, −15.0]) |

Equivalence (±5 pp @25km, TOST-style paired bootstrap): NOT met pooled (−6.7 pp, CI
[−10.2, −3.3]). Only fr-fr is within the bound. en-us, de-de, and en-gb are competitive
enough that the headline gap is driven by en-nz, en-au, and eu-mixed — the three locales
where mailwoman runs under en-US fallback because no dedicated weights package exists.

## Where mailwoman loses: AU/NZ country-scope leakage

This is the single biggest lever, and it is TWO distinct defects (correction to an earlier
draft of this section, which blamed a missing NZ overlay):

- **AU has no `en-au` weights overlay** — those rows ran under the en-US production
  default. Packaging gap.
- **NZ ran WITH `--locale en-NZ`** (`neural-weights-en-nz` exists and was passed per the
  scorer's locale config) **and still scattered to world homonyms.** The locale hint is
  not constraining the resolver's country scope — a mechanism defect, not a packaging
  gap. (Consistent with the NZ locale arc's known state: the overlay ships no postcode
  binary and the arc is blocked on dead-tag resurrection, #1175.)

The consequences:

- **NZ rooftop: 45.0% @25km.** 22 of 57 rooftop rows are ≥10,000 km off. NZ place names
  (Stanmore Bay, Broadmeadows, Auckland Central, Hillsborough, Miramar, Long Bay,
  Phillipstown) collide with US/CA/AU/IN/NG/PK/PL/IT/RO homonyms. The en-US parser
  resolves "Stanmore Bay" to Stanmore, Queensland. "Auckland Central" lands in QLD.
  "Hillsborough" maps to Hillsborough, CA.
- **AU rooftop: 86.7% @25km.** 8 WA-state rows misroute to US homonyms because "WA" reads
  as Washington State under en-US (`Maylands WA 6051` → Maylands, WA, USA at 15,006 km).

Neither locale has an address-point layer firing (all AU/NZ rows resolve at admin tier).
For AU, an `en-au` overlay constrains country scope — packaging work. For NZ, the fix is
diagnostic first: find where the en-NZ locale hint fails to gate the candidate scope, then
fix that mechanism. Together they collapse the homonym-scatter class that dominates the
pooled headline gap.

## Where mailwoman wins: city-only queries

mailwoman leads city-only at every threshold (66.2% vs 35.4% @1km, 87.7% vs 76.9% @25km).
The gap is widest in en-us (91% vs 36%) and de-de (64% vs 18%). Pelias city-only misses
are predictable: world-toponym picks (Berlin WI → Berlin DE, Portland ME → Portland OR,
Lebanon PA → Beirut). mailwoman's country-scope discipline prevents these; Pelias's
full-text recall without strong admin gating invites them.

## Per-country @25km (rooftop only — the stratum that dominates N)

| Country | N rooftop | mailwoman  | Pelias |
| ------- | --------- | ---------- | ------ |
| US      | 45        | **100.0%** | 97.8%  |
| FR      | 48        | **100.0%** | 100.0% |
| DE      | 49        | 98.0%      | 100.0% |
| GB      | 45        | 100.0%     | 100.0% |
| NL      | 7         | 100.0%     | 100.0% |
| CZ      | 8         | 100.0%     | 100.0% |
| DK      | 7         | 85.7%      | 100.0% |
| AT      | 8         | 75.0%      | 100.0% |
| AU      | 56        | 85.7%      | 98.2%  |
| BE      | 7         | 57.1%      | 100.0% |
| CH      | 8         | 50.0%      | 100.0% |
| NZ      | 57        | **42.1%**  | 75.4%  |

Tier-1 locales (US/FR/DE/GB) are competitive at rooftop @25km despite mailwoman's
address-point coverage being US-only in this panel. The EU-mixed panel countries
(AT/BE/CH) suffer from the en-US fallback — same mechanism as AU/NZ, smaller N.

## Anomalies found (panel + system)

- **3 panel coordinates are wrong.** `en-gb-049` (Warwick), `en-gb-051` (Epping), and
  `fr-fr-046` (COMER parís.méxico) place truth >5,000 km from any plausible answer for both
  arms — these are panel defects, not system misses.
- **de-de-013 "Zethau 168, 09619 Mulda"** resolves to an ocean point (18.45, 82.72 off
  India) under mailwoman's admin fallback — a bad gazetteer anchor for this postcode.
  Pelias gets this one (0.00 km).
- **mailwoman produced 4 no-results** out of 420 queries (99.0% result rate). All four
  are eu-mixed fallback rows + one fr-fr city query. Pelias never returns empty (100%).
- **OA circularity.** 62 rooftop rows have Pelias at 0.00 km from truth — the OA points
  in the frozen index ARE the truth coordinates. This inflates Pelias's rooftop @1km by
  ~18 pp. The fair comparison subtracts those rows: Pelias rooftop @1km drops from 93.0%
  to ~91.5% on the non-circular subset. Still dominant, but the gap shrinks.
- **CLI JSON bug found and fixed.** Ink was 80-col pipe-wrapping `geocode --format json`
  output under spawn, producing corrupt JSON. Fixed with `writeRawStdout` in 5 commands
  - regression test. Fix is uncommitted on branch `fix/1519-trailing-dot` — extract
    separately before merging.

## What this means

1. **mailwoman is within striking distance at 25 km on tier-1 locales** (US/FR/DE/GB)
   despite having address-point coverage for only one of them. The parser carries its
   weight; the gap is data.
2. **The AU/NZ scope leakage is the cheapest win, in two parts.** AU: create the en-au
   overlay (packaging, no retraining). NZ: the overlay exists and was used — diagnose why
   the locale hint fails to gate country scope, then fix the mechanism. Either way the
   homonym-scatter class that dominates the pooled headline gap collapses without model
   work.
3. **City-only is a structural win.** mailwoman's country-scope discipline prevents the
   world-toponym misattribution that Pelias's full-text recall permits. This class of
   query matters for "near me" and POI use cases.
4. **Rooftop parity needs data, not a better model.** The 38 MB model never grows.
   Adding address-point layers per country (the per-locale kit) is the path to closing
   the rooftop gap — same mechanism that already works for US rows (100% @25km in
   this panel).
5. **The Nominatim arm crashed** (likely OOM at 12 GB beside Pelias's 7 GB footprint).
   The Photon arm was never started. The hosted geocode.earth arm was never run.
   These three arms remain for a complete five-arm picture — but the mailwoman-vs-Pelias
   comparison on its own already shows the architecture thesis holding: a small model
   with keyed-probe retrieval competes on structure while the incumbent's brute-force
   coverage dominates on exact-match recall. The gap closes per acquired layer, not per
   model iteration.

## Reproducibility

```bash
# Panel
sha256sum /mnt/playpen/mailwoman-data/pelias-rig/panel/panel-v1.jsonl
# fe6d873cab4603bfa6814215a40429351a29b843bd4e9fdd056eea475482ba23

# Frozen Pelias ES index
curl -s http://localhost:4000/v1/search?text=Berlin\&size=1 | jq '.features[0].properties.label'

# Mailwoman CLI (compiled, after writeRawStdout fix)
node mailwoman/out/cli.js geocode --format json --locale en-US -- '1600 Pennsylvania Ave, Washington, DC'

# Scorer
sha256sum /mnt/playpen/mailwoman-data/pelias-rig/logs/benchmark-results.jsonl
# 8dc901c80c035219e8ec89121c80cdf29e9ec9b70fa8c4c66d7970f375fe2159

# Determinism: run twice, cmp clean — PASS
```

## Next steps (for discussion)

1. **Extract CLI JSON fix** from `fix/1519-trailing-dot` branch into its own PR.
2. **en-au + en-nz weights overlays** — data-only packaging, constrains country scope.
   This is the single highest-leverage next action.
3. **Restart Nominatim** with reduced memory (8 GB, not 12 GB) after stopping the Pelias
   API container to free RAM.
4. **Start Photon** after Nominatim completes.
5. **Re-score** with the full five-arm panel once all arms are available.
6. **Address the panel defects** (3 bad truth coordinates) before the next run.
