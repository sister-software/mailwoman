# Postcode anchor

The postcode anchor is the first member of the anchor-based-parsing family
([design](../docs/articles/plan/2026-06-03-anchor-based-parsing.md), #240). It lifts the postcode out of
the BIO sequence-labelling problem and treats it as a structured signal: take a postcode-shaped span,
resolve it against a gazetteer, and report a country posterior plus a calibrated confidence. The parser
then weighs that soft signal against the surrounding tokens. The anchor never decides a postcode's
identity on its own.

## The two pieces

- **`@mailwoman/neural/postcode-anchor`** — `extractPostcodeAnchors(text, resolver)`. Pure logic: it runs
  the same per-country shape regexes the decoder repair pass uses, resolves each shaped span through an
  injected `PostcodeResolver`, and computes the posterior and confidence. No database dependency, so it
  ships to the browser later behind the same seam.
- **`@mailwoman/resolver-wof-sqlite` → `WofPostcodeLookup`** — the production `PostcodeResolver`, an
  exact-match lookup over one or more `postalcode-*.db` shards.

### Posterior and confidence

The country posterior is **uniform** over the countries a postcode actually exists in. Weighting by
per-country volume would skew an ambiguous code like `94105` (a valid shape in US, French dept 94, and
German PLZ 94xxx) toward whichever country owns more 5-digit codes, which is the bias the anchor exists
to avoid. Disambiguation is the parser's job, using script, city tokens, and user locale.

Confidence combines gazetteer **membership** with country **ambiguity**:

```
confidence = exists ? (1 - log2(k) / log2(10)) : 0      // k = distinct member countries
```

So a real single-country code scores 1.0, a real two-country code about 0.70, and a regex-shaped string
that is in no gazetteer scores 0 — the last case is what keeps a bare `99999` or a 5-digit house number
from being treated as a postcode.

Pass `{ fuzzy: true }` to absorb typos and OCR slips. When an exact lookup finds nothing, the anchor
retries class-aware edit-distance-1 variants (digit↔digit, letter↔letter substitutions, plus deletions,
insertions, and adjacent transpositions), tags the result `matchType: "fuzzy"`, and multiplies the
confidence by a 0.6 penalty. A mistyped `12624` recovers its real neighbour `12623` at low confidence,
leaving the parser's city tokens to confirm it. Fuzzy is off by default so existing callers keep
exact-match behaviour.

## Building the shards

The shards come from the operator's own WOF build, never a prebuilt third-party dump. US already ships as
`postalcode-us.db`. For another country, clone its WOF postcode repo and run the existing builder with the
`postalcode` placetype, then backfill centroids:

```bash
# 1. clone the WOF postcode repo (small for most countries; GB is ~8 GB and deferred)
git clone --depth 1 https://github.com/whosonfirst-data/whosonfirst-data-postalcode-fr.git \
  /mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data-postalcode-fr

# 2. build the spr shard (point --data at a dir of the repos you want combined)
node --experimental-strip-types scripts/build-unified-wof.ts \
  --data <repos-dir> --output /mnt/playpen/mailwoman-data/wof/postalcode-intl.db --placetypes postalcode

# 3. backfill centroids from the admin hierarchy. --repos turns on the coarse ancestor
#    fallback (see below): broader coverage, looser centroids.
node --experimental-strip-types scripts/backfill-postcode-centroids.ts \
  --db /mnt/playpen/mailwoman-data/wof/postalcode-intl.db \
  --repos /mnt/playpen/mailwoman-data/wof/repos

# 4. functional check + accuracy
node --experimental-strip-types scripts/diag-postcode-anchor.ts
node --experimental-strip-types scripts/eval/postcode-anchor-accuracy.ts \
  --eval data/eval/external/openaddresses-de-sample.jsonl --country DE
```

### Why the centroid backfill exists

The WOF postcode repos vary in quality. US and ~22% of FR records carry their own `geom:latitude/longitude`.
The rest ship as coordinate-less stubs that only reference their admin parent by `wof:parent_id`. A
postcode with no centroid cannot anchor anything geographically, so `backfill-postcode-centroids.ts`
borrows a centroid from the admin gazetteer in two passes:

1. **Parent-borrow** (always): copy the parent locality's centroid. Tight, town-level placement.
2. **Ancestor fallback** (`--repos`): for postcodes whose parent locality is missing from the admin DB
   (common for city-states like Berlin, whose locality node we never imported), read the GeoJSON
   hierarchy and borrow the finest available ancestor, preferring county over region. Broader coverage at
   a looser centroid.

Every coordinate still comes from our own WOF admin DB.

### Coverage and accuracy

Measured against 3,000 OpenAddresses German points (`postcode-anchor-accuracy.ts`). The `--repos`
fallback trades precision for coverage, so it is a knob, not a default:

| Backfill           | DE placed (Berlin/Saxony sample) | distance to true address |
| ------------------ | -------------------------------- | ------------------------ |
| parent-borrow only | 34%                              | p50 2.8 km, 93% ≤ 10 km  |
| with `--repos`     | 84%                              | p50 7.5 km, 98% ≤ 25 km  |

Membership (the country posterior) is 100% either way — every German postcode in the sample is in the
gazetteer; only the centroid varies. When the anchor places a postcode it lands in the right town; the
fallback extends that to the right region for the city-state and large-Land postcodes the parent-borrow
misses.

### The WOF-pure ceiling

Roughly a third of German postcode records are bare stubs with neither coordinates nor a usable hierarchy
(no county or region ancestor). Nothing in the admin DB can place those. Closing that last gap would need
a non-WOF centroid source such as OpenAddresses point aggregation, which crosses the "extend the custom
WOF build" line, so it is a deliberate policy call rather than a code fix.

### WOF postcode data quality, by locale

Whether a locale is placeable from WOF alone depends entirely on its postcode repo's data quality. A
sample survey (orphan = no `wof:parent_id`; region = a usable `wof:hierarchy` ancestor):

| locale | own coords | orphans | region ancestor | net placeable        |
| ------ | ---------: | ------: | --------------: | -------------------- |
| NL     |       100% |      0% |            100% | ~100% (own)          |
| FR     |        39% |     39% |             61% | ~91%                 |
| DE     |         0% |     27% |             73% | ~66%                 |
| ES     |         0% |     64% |             36% | ~36%                 |
| IT     |         0% |     73% |             27% | ~27% (+ wrong links) |

US, NL, and FR carry enough of their own geometry (or clean ancestry) to place well. DE leans on the
ancestor fallback. ES and IT are orphan-heavy and effectively WOF-unplaceable — IT also carries wrong
links (Milan's `20121` points at a Liguria village), which is why it ships membership-only. Closing the
ES/IT gap needs a non-WOF centroid source such as OpenAddresses point aggregation, a deliberate policy
call rather than a code fix.

### Per-country status

| Country | Shard                | Placement                                            |
| ------- | -------------------- | ---------------------------------------------------- |
| US      | `postalcode-us.db`   | own centroids (existing)                             |
| NL      | `postalcode-intl.db` | 100% placed (own centroids; PC6 stored as `1012LM`)  |
| FR      | `postalcode-intl.db` | 91% placed (own + parent-borrow + ancestor)          |
| DE      | `postalcode-intl.db` | 66% placed (parent-borrow + ancestor)                |
| IT      | `postalcode-intl.db` | membership only — 73% orphans + wrong parents in WOF |
| ES      | not built            | 64% orphans — WOF-unplaceable, needs OA aggregation  |
| GB      | not built            | deferred — postcode-not-order locale, ~8 GB repo     |

NL postcodes are stored space-less (`1012LM`), so the anchor normalizes `1012 LM` → `1012LM` before
lookup. ES and IT need a non-WOF centroid source rather than another admin-repo build.
