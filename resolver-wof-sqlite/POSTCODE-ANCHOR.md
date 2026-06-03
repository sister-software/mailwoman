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

# 3. backfill centroids from the admin hierarchy (see below)
node --experimental-strip-types scripts/backfill-postcode-centroids.ts \
  --db /mnt/playpen/mailwoman-data/wof/postalcode-intl.db

# 4. functional check
node --experimental-strip-types scripts/diag-postcode-anchor.ts
```

### Why the centroid backfill exists

The WOF postcode repos vary in quality. US and ~22% of FR records carry their own `geom:latitude/longitude`.
The rest ship as coordinate-less stubs that only reference their admin parent by `wof:parent_id`. A
postcode with no centroid cannot anchor anything geographically, so `backfill-postcode-centroids.ts`
borrows the parent locality's centroid from the admin gazetteer. Every coordinate still comes from our own
WOF admin DB.

### Per-country status

| Country | Shard                | Placement                                 |
| ------- | -------------------- | ----------------------------------------- |
| US      | `postalcode-us.db`   | own centroids (existing)                  |
| FR      | `postalcode-intl.db` | 86% placed (own + parent-borrow)          |
| DE      | `postalcode-intl.db` | 65% placed (parent-borrow)                |
| IT      | `postalcode-intl.db` | membership only — admin-it repo not built |
| ES      | not built            | orphan stubs (no parent) — needs admin-es |
| NL, GB  | not built            | deferred (NL admin-repo sprint; GB ~8 GB) |

IT, ES, and NL reach full placement once their `whosonfirst-data-admin-<cc>` repos are cloned and built
into the admin gazetteer so the parent-borrow can resolve. That is the next sprint for this lane.
