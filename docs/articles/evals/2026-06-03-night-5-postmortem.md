# Night shift 2026-06-03 — the postcode anchor

**Headline: the postcode anchor (#240, the anchor-based-parsing lead) is built, tested, and shipped for
US, NL, FR, and DE across four feature PRs — zero GPU, all from our own WOF data. And it already pays off:
on the same 3,000 German addresses, a regex plus a gazetteer lookup geolocates to a 2.8 km median, where
the full neural-parser-plus-resolver pipeline lands at 10 km.** That is the anchor-first thesis working:
when the neural parser is out of distribution on a locale, a structured signal carries the address anyway.

## What shipped

- **#247 — the anchor.** `@mailwoman/neural/postcode-anchor` (`extractPostcodeAnchors`), the production
  `WofPostcodeLookup` (`@mailwoman/resolver-wof-sqlite`), the centroid backfill, a functional diagnostic,
  and 13 tests. Uniform country posterior; confidence combines gazetteer membership with country ambiguity
  (`exists ? 1 - log2(k)/log2(10) : 0`).
- **#248 — coverage + measurement.** An optional ancestor-fallback pass in the backfill (county/region
  borrow for city-states like Berlin) and `postcode-anchor-accuracy.ts`, which produced the numbers below.
- **#249 — fuzzy typo tolerance.** Opt-in `{ fuzzy: true }` retries class-aware edit-distance-1 variants
  when an exact lookup misses, tagging the result `matchType: "fuzzy"` with a 0.6 confidence penalty. A
  one-digit typo of a Berlin postcode recovers its real neighbour at low confidence, which is the soft
  signal the parser's city tokens confirm. This is the human-entry-error tolerance the design promised.
- **#250 — NL, the cleanest locale, plus a data-quality survey.** A WOF postcode data-quality survey
  across the order-locales found NL pristine (100% own coords, 0 orphans), better than DE — so NL joins as
  a 100%-placed locale (371,628 codes, no backfill needed; a normalize tweak strips the space in the Dutch
  `1012 LM` → `1012LM` form). The survey also confirmed ES (64% orphans) and IT (73% orphans) are
  WOF-unplaceable.
- **The gazetteer.** `postalcode-intl.db` (NL+FR+DE, IT membership-only) built with the existing
  `build-unified-wof --placetypes postalcode`, centroid-backfilled from the admin hierarchy. A volume
  artifact, rebuilt by the pipeline; the git PRs ship the code. Per-locale placement: US (own) ~100%, NL
  (own) 100%, FR 91%, DE 66%.
- **DeepSeek consult** (2 turns) signed off the artifact format, the uniform posterior, and the confidence
  formula. Transcripts in `.agents/skills/deepseek-consult/ds-pc-turn{1,2}-postcode-anchor.txt`.
- **IT placement attempted, then dropped.** Built `admin-it.db` and ran the backfill, but a functional
  spot-check caught bad source data: 73% of WOF IT postcodes are orphans with no parent, and some of the
  rest link to the wrong place — Milan's `20121` points at Riomaggiore, a Cinque Terre village 150 km away
  in Liguria. IT stays membership-only; placement is blocked on WOF data quality, not on our pipeline. The
  experiment was reverted (the shard is back to the clean DE/FR state; nothing IT-related reached a PR).

## What went well

- The gazetteer was nearly free. `build-unified-wof` already accepted `--placetypes postalcode`, and the
  resolver already resolved postcodes for the US shard. Most of the anchor was assembly, not invention.
- Probing the data before building saved a wasted afternoon. A first look at the cloned DE repo showed
  coordinate-less stubs, so the centroid-backfill design existed before any code did, rather than as a
  patch after a useless gazetteer shipped.
- DeepSeek's call to keep the posterior uniform got validated by real data on the first run: `94105`
  resolves to US, French dept 94, and German PLZ 94xxx all at once. Count-weighting would have confidently
  picked the wrong country; the soft posterior leaves the disambiguation to the parser's city tokens.
- The tests seed their own fixture shards, so the suite runs in CI without the data volume.
- A functional spot-check, not an aggregate metric, caught the bad IT data. The `27% placed` number alone
  looked merely low; eyeballing three Italian cities showed Milan resolving to Liguria, which is what
  turned "ship IT at low coverage" into "do not ship IT." Functional tests over metrics, again.

## What could have gone better

- The WOF German postcode repo is rougher than expected. Roughly a third of its records are bare stubs
  with no coordinates and no usable hierarchy, so the WOF-pure path tops out near 66% DE placement. The
  honest fix crosses a policy line (see open questions).
- Per-locale coverage is a grind, and not every locale rewards it. FR and DE were quick. IT cost an
  admin-repo clone and build only to reveal unusable postcode hierarchy (73% orphans, wrong parents), and
  ES has no parent reference to borrow from at any cost. The lesson: probe each WOF postcode repo's data
  quality before committing to its build.

## Decisions made autonomously

- **WOF-pure, even at the cost of coverage.** The operator's standing rule is to extend the custom WOF
  build and never pull a prebuilt dump. I held that line, which is why DE placement stops at ~66% rather
  than reaching for OpenAddresses point aggregation. That trade is the operator's to revisit, so it became
  an open question rather than a silent choice.
- **The coarse ancestor fallback is a flag, not a default.** It lifts the Berlin/Saxony sample from 34% to
  84% placed but loosens the median from 2.8 km to 7.5 km. Rather than bake one operating point in, the
  `--repos` flag is the knob and both numbers are documented.
- **Ship US/NL/FR/DE; let the data decide the rest.** NL got added once the survey showed it was clean;
  ES and IT were left as membership-only once the survey showed they were not. The browser FST artifact and
  the parser-side `[POSTCODE-ANCHOR]` conditioning channel wait for the de-risk pilot (#242), since the
  channel needs the self-conditioning architecture that pilot exists to build.

## Open questions for the operator

1. **The WOF-pure ceiling.** About a third of DE postcodes are unplaceable from WOF alone (bare stubs).
   Closing that needs a non-WOF centroid source such as OpenAddresses point aggregation. Hold the WOF-pure
   line and accept ~66% DE, or allow OA aggregation for the stub third?
2. **Coarse fallback in production.** Should the shipped `postalcode-intl.db` use the `--repos` ancestor
   fallback (84% placed at 7.5 km) or stay precise-only (34% at 2.8 km)? My lean is fallback-on, since the
   country posterior is the primary signal and a coarse centroid still places the right region.
3. **ES/IT next move.** The survey settles locale priority for the WOF path — NL is done, US/NL/FR/DE
   place well, and ES/IT are orphan-heavy in WOF. So the only way to add ES/IT is the non-WOF source from
   question 1. Worth it, or leave them membership-only? (GB is a separate, postcode-not-order, 8 GB job.)

## Concrete next steps

- (operator) Decide the WOF-pure ceiling policy and the fallback default (open questions 1 and 2).
- IT and ES placement is blocked on WOF postcode data quality (orphans and wrong parents), not on tooling.
  They need a non-WOF centroid source (OpenAddresses point aggregation), which ties back to open question 1.
- The browser FST + packed-record artifact for the WASM target (DeepSeek's deferred scope cut).
- The parser-side conditioning channel lands with the pilot (#242).
- `scripts/eval/postcode-anchor-accuracy.ts` extends to FR once an FR OpenAddresses sample with
  coordinates is ingested (none on disk tonight).

## Numbers

|                      |                                                              |
| -------------------- | ------------------------------------------------------------ |
| shift window         | 03:16 UTC → 14:00 UTC                                        |
| primary goal         | postcode anchor (#240) — shipped US/FR/DE                    |
| PRs merged           | 6 (#238, #246 carried over; #247-#250 new)                   |
| locales placed       | US, NL, FR, DE (IT membership-only)                          |
| models trained       | 0 (zero-GPU lane, heat-safe)                                 |
| Modal spend          | $0                                                           |
| new tests            | 22 (postcode suite all green)                                |
| geolocation (anchor) | US p50 2.4 km, DE p50 2.8 km, vs 10 km neural+resolver on DE |
| NaN incidents        | 0                                                            |
| CI failures          | 0                                                            |
