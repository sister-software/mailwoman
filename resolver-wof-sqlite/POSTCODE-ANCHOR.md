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
- **`@mailwoman/resolver-wof-sqlite` → `WofPostcodeLookup`** — the server-side `PostcodeResolver`, an
  exact-match lookup over one or more `postalcode-*.db` shards.
- **`@mailwoman/neural` → `PostcodeBinaryResolver`** — the browser/WASM `PostcodeResolver`, a pure-JS
  binary-search over a compact flat binary (no SQLite). `scripts/build-postcode-binary.ts` emits one
  `postcode-<cc>.bin` per locale into `docs/static/mailwoman/` (US 1.8 MB, NL 3.9 MB, FR/DE ~0.3 MB; the
  browser fetches only the locale it needs). Same `lookup()` seam as the SQLite resolver, so
  `extractPostcodeAnchors` is agnostic to which backs it.

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

The WOF postcode records (and their ids) come from the operator's own WOF build; coordinates come from
the priority chain below (own → GeoNames → WOF admin). US already ships as `postalcode-us.db`. For another
country, clone its WOF postcode repo, build the shard, then backfill:

```bash
# 1. clone the WOF postcode repo (small for most; GB is ~8 GB and deferred)
git clone --depth 1 https://github.com/whosonfirst-data/whosonfirst-data-postalcode-fr.git \
  /mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data-postalcode-fr

# 1b. (for GeoNames-filled locales) fetch the GeoNames postal dump (CC-BY 4.0)
curl -sL https://download.geonames.org/export/zip/ES.zip -o /tmp/ES.zip && unzip -o /tmp/ES.zip ES.txt \
  -d /mnt/playpen/mailwoman-data/geonames

# 2. build the spr shard (point --data at a dir of the repos you want combined)
node scripts/build-unified-wof.ts \
  --data <repos-dir> --output /mnt/playpen/mailwoman-data/wof/postalcode-intl.db --placetypes postalcode

# 3. backfill centroids: GeoNames first (the postcode's own centroid), then the WOF admin parent-borrow
#    + --repos ancestor fallback for what GeoNames misses.
node scripts/backfill-postcode-centroids.ts \
  --db /mnt/playpen/mailwoman-data/wof/postalcode-intl.db \
  --geonames /mnt/playpen/mailwoman-data/geonames \
  --repos /mnt/playpen/mailwoman-data/wof/repos

# 4. functional check + accuracy
node scripts/diagnostic/diag-postcode-anchor.ts
node scripts/eval/postcode-anchor-accuracy.ts \
  --eval data/eval/external/openaddresses-de-sample.jsonl --country DE
```

### The centroid backfill: three priority passes

The WOF postcode repos vary in quality (see the survey below), so `backfill-postcode-centroids.ts` fills
a coordinate for every coordinate-less postcode, in priority order:

1. **Own coordinate** — the record's own `geom:latitude/longitude` from the build (US/NL, ~22% of FR). Most authoritative.
2. **GeoNames postal** (`--geonames <dir>`) — the postcode's OWN centroid, matched by string from the GeoNames `zip` dump (CC-BY 4.0, ~80+ countries). The cleanest fill for ES/IT and ~half of DE; it is _finer_ than the WOF parent-borrow (the postcode's point, not a borrowed locality's), and it corrects WOF's mis-linked Italian parents (`20121` → central Milan, not a Liguria village). WOF ids stay canonical; only the coordinate comes from GeoNames.
3. **WOF parent-borrow / ancestor fallback** (`--admin`, `--repos`) — a coarse "which city/region" approximation from the admin hierarchy, last resort for postcodes GeoNames does not cover.

Postcodes neither GeoNames nor WOF can place keep `latitude=0` (membership only — the country posterior still works). **Licensing:** a shard shipping GeoNames-sourced coordinates must attribute "GeoNames (CC-BY 4.0)".

### Coverage and accuracy

Per-country placement after the full chain, plus DE accuracy against 3,000 OpenAddresses German points (`postcode-anchor-accuracy.ts`):

| locale | placed | source                                  |
| ------ | -----: | --------------------------------------- |
| NL     |   100% | own PC6 coords                          |
| ES     |    95% | GeoNames                                |
| FR     |    91% | own + WOF borrow                        |
| IT     |    90% | GeoNames (and it fixes WOF's bad links) |
| DE     |    82% | GeoNames + WOF borrow                   |

DE accuracy jumped once GeoNames supplied the postcode's own centroid: **p50 1.2 km, 99.9% placed, 100% within 25 km** (max 15.8 km), versus the WOF parent-borrow's 2.8–7.5 km median with 489 km tail outliers. GeoNames is both broader and tighter, because it places the postcode itself rather than borrowing a parent.

### WOF postcode data quality, by locale (why GeoNames was needed)

WOF-alone placeability, from a sample survey (orphan = no `wof:parent_id`; region = a usable `wof:hierarchy` ancestor), and what GeoNames adds:

| locale | own coords | orphans | region ancestor |            WOF alone | with GeoNames                      |
| ------ | ---------: | ------: | --------------: | -------------------: | ---------------------------------- |
| NL     |       100% |      0% |            100% |                ~100% | WOF wins (GeoNames is coarser PC4) |
| FR     |        39% |     39% |             61% |                 ~91% | ~91%                               |
| DE     |         0% |     27% |             73% |                 ~66% | **82%**                            |
| ES     |         0% |     64% |             36% |                 ~36% | **95%**                            |
| IT     |         0% |     73% |             27% | ~27% (+ wrong links) | **90%** (links fixed)              |

WOF is a strong _admin_ gazetteer but a weak _postcode_ one outside a few countries: ES/IT are orphan-heavy and IT carries wrong links. GeoNames postal closes those gaps cleanly and keeps the WOF id as the key, so eval integrity holds. NL stays on WOF (its PC6 is finer than GeoNames' PC4). The wider supplement landscape is catalogued in `docs/articles/plan/reference/address-data-sources.md` ("Gazetteer / resolver coordinate sources").

### Per-country status

| Country | Shard                | Placement                                        |
| ------- | -------------------- | ------------------------------------------------ |
| US      | `postalcode-us.db`   | own centroids                                    |
| NL      | `postalcode-intl.db` | 100% (own PC6 `1012LM`)                          |
| ES      | `postalcode-intl.db` | 95% (GeoNames)                                   |
| FR      | `postalcode-intl.db` | 91% (own + WOF borrow)                           |
| IT      | `postalcode-intl.db` | 90% (GeoNames; WOF's bad links corrected)        |
| DE      | `postalcode-intl.db` | 82% (GeoNames + WOF borrow)                      |
| GB      | not built            | deferred — postcode-not-order locale, ~8 GB repo |

NL postcodes are stored space-less (`1012LM`), so the anchor normalizes `1012 LM` → `1012LM` before
lookup.
