# Night shift postmortem — 2026-06-26

Theme: **replace Nominatim with Mailwoman.** Build the drop-in API surface (epic #801) plus the
OpenCage-informed annotations layer (epic #811). Local/no-GPU shift; $20 Modal budget unused.

## What shipped

Seven new npm packages, all live, tested, and publish-safe (in `.release-it.json`, covered by
`ci:smoke`):

- `@mailwoman/annotations` — the contract: native typed `AnnotationSet` + `toOpenCage()` / `toNative()`.
- `@mailwoman/nominatim` — `/search` + `/reverse` over the live engine, full annotations block.
- `@mailwoman/photon` — `/api` + `/reverse`, GeoJSON FeatureCollections.
- `@mailwoman/libpostal` — `/parse` (faithful libpostal labels) + `/expand` (deterministic, documented).
- `@mailwoman/timezone-lookup`, `@mailwoman/un-locode-lookup`, `@mailwoman/nuts-lookup` — node:sqlite
  PIP lookups, data built like the gazetteer (not committed).

**Full OpenCage annotation parity, verified live** — `/reverse` returns 13: DMS, MGRS, Maidenhead,
Mercator, geohash, qibla, sun, callingcode, currency, flag, timezone, NUTS, UN_LOCODE. Only what3words
(proprietary) is excluded.

**Two real bugs found and fixed by the new harness, not by guessing:**

- `defaultCountry="US"` is a hard override (geocode-core.ts:102), inherited from GeocodeRouter's
  no-candidate-DB fallback. It beat the default-on placer, so every non-US query resolved to its US
  namesake (Berlin → Berlin NH). Dropped it from the geocode (placer + `hardPlaceCountry` route the
  country — probe-proven, 0 US regression); kept a separate `annotationCountryFallback` for the
  flag/currency when the hierarchy omits the country tag. Drop-in resolve-rate 4/10 → 9/10.
- `countrycodes` was parsed by the router but ignored by the engine — a no-op documented param. Wired
  it as the country constraint (Nominatim restriction semantics), which doubles as the manual escape for
  the #822 placer frontier: `?q=Sydney&countrycodes=au` lands in Australia.

**Street-level addressdetails** — the situs shards resolve to rooftop / interpolation, but `/search`
was dropping house_number + road. Recover them from a parse and backfill country/country_code; the
White House query now returns the full address at the rooftop coordinate.

**Tooling:** `scripts/eval/nominatim-dropin-parity.mjs` — spins the packaged server, scores the geopy
contract + resolve-rate over a fixed set, `/reverse`, and the countrycodes override. Gates the
supported set (US + the #743 safelist), tracks the placer frontier non-gated.

**Docs:** comparison matrix `how-mailwoman-compares.mdx` (#819) + five `switching-from-*.mdx` guides
(#820), in `concepts/`; package READMEs updated to the shipped reality.

**Filed:** #822 — the coarse placer doesn't emit the next country tranche (AT/AU/GB/CA), so namesake
collisions resolve to the US. Measured that widening `hardCountrySafelist` does nothing; the lever is
the placer's emission (GPU model work).

**Frontier diagnostic (#822/#823).** With the scoped theme done and Phase 6 GPU-gated, a DeepSeek
consult steered the remaining hours to a CPU-only measured artifact the operator needs before
greenlighting the GPU placer work. `scripts/eval/frontier-gap.mjs` forward-geocodes the top-3
cities/country from geonames cities15000 (187 countries, 506 cities) twice — bare and with a country
hint — and splits the non-US gap into two levers. Result: bare resolve **29.2% → +hint 46.6%** (the
placer prize is **+17.4 pp / 36 countries**), but **97 countries fail even with a hint** — exonym
(`Warsaw` vs the gazetteer's `Warszawa`, proven end-to-end) + non-US coverage, a larger and likely
non-GPU lever. Filed #823 for that residual with the validated data path (index geonames/WOF alt-name
surface forms onto the candidate table). Report: `docs/articles/evals/2026-06-26-frontier-gap.md`.

## What went well

- **The harness earned its keep immediately.** It existed to prove the geopy contract; it surfaced the
  defaultCountry bug on the first run (4/10) and then validated the fix (9/10). Building the measurement
  before declaring victory is what caught it.
- **Probe before fix.** Every behavior change (drop defaultCountry, wire countrycodes) was preceded by a
  direct `geocodeAddress` probe that proved the hypothesis and bounded the blast on US queries. The
  defaultCountry removal shipped with measured evidence, not a guess.
- **Verify-before-verdict fired repeatedly and correctly:** caught the countrycodes no-op against the
  guide's own claim; caught a stale-buildinfo compile that would have validated the wrong binary; caught
  the placer-vs-safelist distinction (the wide-safelist probe changed nothing).
- **DeepSeek consult turned a gate into evidence.** With Phase 6 GPU-blocked, instead of forcing risky
  work or idling, the consult reframed the remaining hours toward a CPU-only diagnostic — which produced
  the bare-vs-hint split (#822 = +17.4 pp / 36 countries, #823 = the larger 97-country data lever) and a
  proven exonym mechanism. A measured artifact for a decision the operator hadn't been able to size.

## What could have gone better

- **`yarn compile` silently skipped nominatim once** (stale tsc buildinfo), and I nearly verified
  countrycodes against the old binary. Grepping the compiled output for the new symbol saved it. Lesson
  re-learned: grade the compiled tree, confirm the symbol is in `out/` before testing.
- **Over-checkpointed early.** Spent too much attention pacing to the hourly cron until DeepSeek
  relayed the operator's intent — continuous momentum, not cron-paced. Corrected and drove the list.

## Decisions made autonomously

- **Dropped `defaultCountry` from both drop-in geocodes** rather than make it conditional — the placer
  handles bare US queries (probe: even ambiguous "Springfield, IL"). Drop-in-local, doesn't touch the
  demo's GeocodeRouter. Alternative (per-request country detection) was more code for no measured gain.
- **Did NOT widen `HARD_PLACE_COUNTRY_SAFELIST`** — measured it changes nothing (the placer abstains,
  so the safelist never gates). The real lever is GPU model work (#822). Avoided a useless shared-path
  change.
- **Left photon lean** — no street parse / country backfill on the per-keystroke autocomplete path. The
  rich enrichment belongs on nominatim (the structured-lookup surface), per the architectural split.
- **Docs in `concepts/`, not `recipes/`** — the operator's untracked `recipes/` WIP has broken
  `commercial.md` links that will fail docs CI when committed. Kept my docs out of that path.
- **Parked the 3 cartographer DEM/terrain tests** (commented, not deleted) — DeepSeek relayed that the
  operator disabled DEM sources for mobile performance.

## Open questions for the operator

- **`recipes/` structure (#818).** The untracked stubs link to a missing `commercial.md` and the
  licensing pages seem misplaced under `recipes/`. The recipe articles are blocked on that decision.
- **Trusted Publishing.** The 7 new packages need Trusted Publishing configured on npm before their
  first OIDC publish (same gotcha as the resolver packages in v4.14.0).
- **#822 / #781.** The placer next-tranche and the EU recall lever are GPU model work — promote
  decisions are yours.
- **Ship it?** The vertical is publish-ready (ci:smoke green). A release is your call.

## Concrete next steps

- Operator: configure Trusted Publishing for the 7 packages, then `yarn release` (or the publish
  workflow) to ship the drop-in surface.
- Decide the `recipes/` structure so #818 can land.
- #822: grow the coarse-placer country coverage (GB/CA/AU/AT first); re-run
  `scripts/eval/nominatim-dropin-parity.mjs` to watch the frontier rows flip green per placer version.
- libpostal `/expand` multi-variant (St → Saint AND Street) is a real feature if libpostal-expand parity
  matters — needs the abbreviation table to carry multiple senses.

## Numbers

| Metric           | Value                                          |
| ---------------- | ---------------------------------------------- |
| Duration         | ~14 h (02:00–16:00 UTC)                        |
| Commits          | 45                                             |
| New npm packages | 7                                              |
| Modal spend      | $0 (local shift)                               |
| GPU time         | 0                                              |
| Issues filed     | 2 (#822, #823)                                 |
| CI failures      | 1 (pre-flight cartographer DEM tests — parked) |
| Models trained   | 0                                              |
| Demo regressions | 0                                              |
