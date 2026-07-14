---
title: Night 34 postmortem (2026-07-05)
description: Levers-not-retrains night — eval/CI guardrails + query-shape/resolver levers, promotion walled.
---

# Night 34 — 2026-07-05

**Finalized at hand-off.** Window: 06:10 → 15:35 UTC (~9.5 h). Scope: levers-not-retrains, no-GPU-first.
$30 Modal ceiling — **spent $0**. Promotion WALLED (v5.4.0 shipped today).

**Headline:** the plan finished at ~12% of the shift, and the bonus became the story — the
`postcodeCountryPrior` lever (GB 63→90%, CA 42→67%, staged), the metamorphic gauntlet taken to 35/35
(two normalizer levers), and **three stale hypotheses killed by measurement** (#965/#942/#985). Every
win was a preprocessing lever or a measurement; zero GPU. The recurring lesson: **characterize the
failure before declaring the well dry — the diagnostic is where the lever hides** (the GB #928 fix was
found by characterizing the GB namesake tail, not by planning it).

## What shipped

- **#965** (PR #978, merged) — `--hard-country` production-scoping flag for `fr-admin-split-gate`;
  the issue premise falsified (FI/SI/CZ not on the hard-country safelist → soft-prior harness was
  already production-faithful; FI p90 is intra-country). Flag proven on FR (mean 144→119 km).
- **#963** (PR #979, merged) — NL postcode case added to the scheduled production demo smoke;
  verified passing against live production. (The scheduled functional smoke itself already existed —
  salvage-first caught it.)
- **#829** (PR #980, merged) — lowercase input normalizer, the mirror of #690. A preprocessing lever,
  ZERO retrain, cleared the metamorphic INV[lower] class (34/35 held, was ~6 failing) + promoted
  `fr-chevaleret-bare` to a gated pass (24/24). **The conditional GPU probe (#84) was obviated** —
  the lever left no model-level residual, so $0 of the $30 Modal budget spent.
- **#942** (measured, not built) — the SI no-street class now resolves at **99.6%** (p50 0.73 km) via
  the shipped `postalCompoundRecovery` + v5.4.0 + #829, vs the 55 rows lost by v2.2.0 that spawned it.
  The proposed postal-city fallback rung is redundant; the residual is the intra-SI namesake p90 tail
  (#370 territory). Reported + recommended re-scope. **Didn't build a lever the data said was moot.**
- **#981** (filed) — the geocode-core query-shape-prior gap (parse path applies `buildEmissionPriors`,
  geocode path doesn't). Filed with the assessment that wiring it is behavior-affecting + low-value
  (0.9 log-odds nudge, model usually already right) — a documented gap, not a rushed change.
- **trailing-punct trim** (PR #982, merged, bonus) — the whitespace stage now strips a trailing
  `.`/`,`/`;`/`:` (a trailing dot dropped the street tier: `…DC.` → admin). Offset-map-safe,
  trailing-only, conservative set. Cleared the LAST metamorphic xfail: **INV is now 35/35 with ZERO
  xfails** — combined with #829, the whole invariance layer is green for the first time.
- **#937 GB panel** (PR #983, bonus) — `build-osm-coord-golden.ts` (OSM→golden adapter over the
  existing GDAL `extractAddrPoints`) + `oa-gb-coord-1k.jsonl` (1000 rows / 183 buckets from 5.0M OSM
  points). **First GB coordinate measurement: 85.9% resolve, p50 4.44 km** (p90 582 km = the GB
  duplicate-placename namesake tail, #928's exposure). GB is now a standing measurement surface; the
  builder generalizes to HU/IE. HU panel building as a follow-on.
- **#928 GB namesake FIX** (PR #928-lever, staged, the night's biggest coverage win) — the GB tail
  diagnostic revealed a contained lever: the coarse placer conflates GB/US (mis-routes `London E4 9AZ`
  → London OH at 0.96 conf), but the GB postcode FORMAT is unforgeable. `postcodeCountryPrior`
  (default-off, staged) sets the country prior from `countryFromPostcodeFormat` in place of the placer.
  Measured: GB 190→**271 ok (63%→90%)**, abroad 73→19, with the lever on + GB safelisted. US-safe by
  construction. The diagnostic-then-lever loop is why the "characterization" slack-time approach beat
  idling — it surfaced a real fix.

## What went well

- **Salvage-first paid twice**: #963's scheduled functional smoke already existed (only needed the NL
  case), and #829 reused #690's exact hook shape.
- **Measure-don't-guess killed THREE stale hypotheses** — the night's headline: #965 (epoch1 3 km was a
  different harness; FI tail is intra-country), #942 (SI already 99.6%, lever redundant), #985 (safelist
  moot for HU — the placer never emits HU@conf≥0.9). Each was a plausible target that measurement
  refuted before a line of "fix" was written. The `--hard-country-safelist` flag was built _to run_ the
  #985 experiment and immediately falsified it.
- **Levers beat GPU**: #829 was slated for a possible fine-tune probe; the preprocessing lever cleared
  the whole class for free.
- **The plan finished at ~12% of the shift**, so the bonus was real product: two more no-retrain
  levers (trailing-punct → metamorphic 35/35), a reusable OSM→golden panel builder, and two first-ever
  coordinate measurements (GB 85.9% / HU 72.4%) — the builder generalized on the first HU run.

## What could've gone better

- **Two eval "premises" were stale** (#965 epoch1 3 km, #942's 55-lost-rows) — both had been overtaken
  by shipped work but were still cited as open targets. Re-measuring first is cheap; a standing "re-baseline
  before building the fix" habit would have caught both without the investigation detour.
- **The `&`-backgrounded merge watchers kept dying on branch switches** — had to merge several PRs by
  hand. A watcher that survives `git checkout` (or just merging inline when checks are green) is cleaner.
- The GB/HU **p90 namesake tails** (582 / 1330 km) are the honest limit of tonight's levers — they need
  the namesake binder (#370) or a safelist decision, not a normalizer. Filed as the next lever, not forced.

## Decisions made autonomously

- **#965 approach — mirror geocode-core, don't re-derive.** Threaded the SAME production scoping
  (`loadDefaultPlaceCountry` → `anchorPosterior`/`anchorWeight` + `hardCountryFor`) behind a
  `--hard-country` flag so the two paths can't drift. Also swept two `recognizeUsRegions` acronym
  stragglers (#875 gap) failing `typecheck:scripts`.

- **#965 — the issue premise is FALSIFIED (diagnostic-before-verdict paid off).** The fix is correct,
  but running it revealed the issue's headline ("harness overstates FI production error; hard scoping
  → 3 km") is wrong:
  - `HARD_PLACE_COUNTRY_SAFELIST = {US, ES, IT, NL, DE, FR}`. **FI, SI, CZ — the exact locales the
    issue cited — are NOT safelisted**, so production `geocode-core` doesn't hard-filter them either.
    The soft-prior harness was already production-faithful for them.
  - The FI p90 tail is **intra-country** (worst rows ~700–974 km, all < Finland's ~1160 km span) —
    wrong-FI-town error, which no country lever (soft prior, `anchorPosterior`, or `hardCountry`)
    can address. `--hard-country` moved FI p90 262→264 km (scoped) and 307→307 km (unscoped): a
    legitimate no-op, because production is a no-op there too.
  - The epoch1 3.15 km came from a **different harness** (the baseline MANIFEST already flagged it
    unreproducible). It was never production. The harness numbers are honest; the epoch1 _comparison_
    was the error.
  - **The fix still lands** — for safelisted countries with cross-border namesakes on the unscoped
    legs, `--hard-country` DOES bite: FR unscoped mean 144→119 km (−17%; wrong-country outliers
    suppressed by placer→FR hardCountry). Kept default-OFF (opt-in flag) so existing baselines
    don't shift.

- **#928 GB namesake tail characterized** (from the new panel) — 24% of GB rows resolve to US
  namesakes (London→Ohio, Richmond→Virginia). Root: the coarse placer **confidently mis-classifies
  GB as US** (0.94–0.96) because GB/US share English patterns; the GB postcode format (`E4 9AZ`) is an
  unused discriminator. Fix = a placer GB-vs-US signal (entangled with #981's query-shape-prior
  wiring), a focused-session change to the country-determination path — not a contained night lever.

## Open questions

- **★ #928 promote decision (highest-value)** — `postcodeCountryPrior` is staged default-off and now
  covers **GB (63%→90% ok) and CA (42%→67% ok)**, both validated on their panels. Promote = flip it
  default-on **+ add GB, CA to `HARD_PLACE_COUNTRY_SAFELIST`** (behavior changes, walled tonight). All
  safe (US-safe by construction — the GB/CA formats never match a US ZIP; both well-covered so the hard
  filter is a pure win once the format prior routes them). Recommend promoting. NL was ruled out (placer
  handles Dutch); the lever generalizes to any distinctive-postcode country the placer conflates.
  **Gate complete: GB ↑63→90%, CA ↑42→67%, US flat (0/150 rows changed, flag on vs off, both scoped +
  unscoped) — a fully-de-risked pure win.**
- **#942 / #977 / #981 / #985 dispositions** — #942 re-scope to #370 or close (SI 99.6%); #977 parked
  (PDOK PC6); #981 wire-or-document; #985 close (safelist moot — HU is a placer-coverage matter). Operator call.

## Concrete next steps

- The #937 GB coordinate panel is a wiring job over `build-oa-coord-golden` + an OSM-GB extractor + the
  GeoNames GB postal fold (all verified present). Unblocks #928 GB namesake exposure.
- #942 residual → fold into #370 `postcodeConsistency` (the intra-SI namesake binder).

## Numbers (running)

| Metric              | Value                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Shift window        | 06:10 → 15:35 UTC (~9.5 h)                                                                                               |
| Models trained      | 0                                                                                                                        |
| Modal $             | **$0 of $30** (every win a no-GPU lever / measurement)                                                                   |
| PRs merged          | **9** (#978 #965, #979 #963, #980 #829, #982 trailing-punct, #983/#984 #937 GB/HU, #986 #985 flag, #987/#988 #928 GB/CA) |
| Issues advanced     | #928 (fix), #981/#985 filed, #942/#977/#937 measured/scoped, #965 falsified                                              |
| Coordinate panels   | 3 new (GB / HU / CA) + a reusable OSM→golden builder                                                                     |
| Gauntlet            | metamorphic 35/35 (zero xfails, first ever), regression 24/24                                                            |
| Regressions shipped | 0                                                                                                                        |
| NaN / CI failures   | 0 / 0                                                                                                                    |
