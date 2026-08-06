# NYC ZIP→delivery-city is already on disk — GeoNames postal, unwired for US (2026-08-04)

Answers [#1446](https://github.com/sister-software/mailwoman/issues/1446)'s open question: does the
postal-city builder's source genuinely lack NYC rows, or carry them and drop them?

**Neither. The question was aimed at the wrong artifact.** Overture's US addresses carry no
`postal_city` for New York City, but that is a source-mix fact rather than a gap worth closing there.
The delivery-city data has been in the data root since 2026-06-23, under a license this repo already
uses for ten other countries, and it closes 99.9975% of the hole.

> **Supersedes the first version of this record**, which concluded that NYC required the licensed
> USPS City-State Product. That was wrong. It rested on reading `address_levels[2]` as the mailing
> city; it is the administrative municipality. See "How the first reading went wrong" below — the
> error is instructive and worth keeping.

## Where the data is

`/mnt/playpen/mailwoman-data/geonames/allCountries-postal.txt` — 140 MB, CC BY 4.0, downloaded
2026-06-23.

```
US	11201	Brooklyn	New York	NY	Kings	047	40.694	-73.9903	4
US	10451	Bronx	New York	NY	Bronx	005	40.8222	-73.9217	4
US	10001	New York	New York	NY	New York	061	40.7484	-73.9967	4
US	11375	Forest Hills	New York	NY	Queens	081	40.7229	-73.8473	4
US	10301	Staten Island	New York	NY	Richmond	085	40.6316	-74.0927	4
```

41,488 distinct US postcodes; 311 across the five NYC counties, including the Queens neighbourhood
delivery cities (Astoria, Flushing, Long Island City, Sunnyside, Bayside, Little Neck) that #1446
flagged as the hard case — Queens is the borough where USPS uses neighbourhood names rather than the
borough name.

Measured against the Overture hole:

|                                                 |                        |
| ----------------------------------------------- | ---------------------: |
| distinct postcodes in the 967,870-row hole      |                    235 |
| named by GeoNames                               |       **233 (99.15%)** |
| hole rows a delivery city becomes available for | **967,846 (99.9975%)** |

Top delivery cities by row volume: Brooklyn 308,548 · Staten Island 130,143 · Bronx 105,854 · New
York 62,919 · Jamaica 36,197 · Flushing 29,602 · Astoria 17,598.

## Why Overture has the hole

`postal_city` is populated exactly when the row's source is **NAD** (the DOT National Address
Database). New York state splits:

| source                             |      rows | with `postal_city` |
| ---------------------------------- | --------: | -----------------: |
| NAD                                | 5,503,521 |   5,503,521 (100%) |
| OpenAddresses / NY / NYC Open Data |   967,870 |                  0 |

The missing set is exactly the NYC municipality — 967,870 rows, all with
`address_levels[2] = 'New York'`, no remainder. Per-state `postal_city` coverage (IL 100%, TX 85.3%,
NY 85.0%, CA 2.2%, FL 0%, MA 0%) measures **which states Overture sourced from NAD**, not postal-city
availability. FL and MA are not postal deserts.

## How the first reading went wrong

`address_levels` is `STRUCT("value" VARCHAR)[]` with arity exactly 2 on all 126,511,623 rows, and no
`type` discriminator — so position is the only thing distinguishing the levels. `[1]` is the state.
`[2]` is the **administrative municipality** (census place / town), which the top NY values give
away: Hempstead, Brookhaven, Islip, Oyster Bay, Greece, Colonie. Nobody addresses mail to "Greece,
NY". Joining the two fields where both are present settles it:

| `address_levels[2]` | `postal_city` |      n |
| ------------------- | ------------- | -----: |
| Greece              | Rochester     | 46,030 |
| Colonie             | Albany        | 20,041 |
| Hempstead           | Levittown     | 14,197 |
| Brookhaven          | Coram         | 11,795 |

So "the boroughs appear nowhere as `address_levels[2]` in NY state" is **correct and unremarkable**.
The City of New York is one municipality spanning all five boroughs; a borough is sub-municipal and
could not appear in that field. A correct administrative value was read as a missing postal one.

Two smaller traps in the same investigation, both worth avoiding next time:

- `substr(postcode, 1, 3) IN ('100', …)` to select NYC pulls in rows whose postcode is malformed or
  belongs to another state entirely (a Gainesville TX row, a row whose postcode is literally `111`).
  `@mailwoman/codex/us/zipcode` ships `isZipCode` and `StateAbbreviationZipCodePrefixRecord` for
  exactly this; a hand-typed prefix list in a SQL string is not the tool.
- Correcting that filter by scoping on `address_levels[1].value = 'NY'` rests on the _same_
  unverified schema reading it was meant to correct. Confirm what a column means before using it to
  validate another column.

## What is NOT yet established

`ingestGeonamesPostal` (`resolver-wof-sqlite/geonames-postal.ts`) exists and is reachable from
`foldGeonames` via an optional `postalCountries` parameter — which **no caller anywhere in the tree
supplies**. The ten countries already present in `postalcode-geonames-tail.db` (GB/PL/SE/NO/FI/SK/
CZ/DK/SI/HR) therefore arrived by some other path, and that path is where a US entry has to go. It
has not been traced yet. Do not assume the fix is adding `"US"` to a list until the list is found.

## Other candidates, checked

All inherit the same hole or carry no city name at all:

- **`postal-city-alias-us.db`** — models exactly this concept (`postal_city_alias(postcode,
postal_city, geo_locality, divergent)`) but is built `FROM overture:US`, so it inherits the hole.
  12,088 postcodes, 300 NY-shaped, zero NYC. Its only Brooklyn rows are **IA 52211, CT 06234, MD
  21225, OH 44144, IL 62059**. Rebuilding it against GeoNames is the natural follow-on.
- **`postalcode-us.db`** — 42,319 postalcode nodes; 11201 / 10001 / 10451 all present, but the
  `names` table has **zero rows** and ancestry returns nothing. No city name anywhere.
- **`candidate.db`** — postcode nodes are named by the code itself. Brooklyn exists only as a WOF
  `borough` node, unlinked to any ZIP.
- **`address-points-us-ny.db`** — `locality_norm = 'new york'` for 11201, sourced from the same
  NYC Open Data rows. The hole propagated downstream.
- **`@mailwoman/codex/us`** — shape validation only, no ZIP→city table.
- **`postalcode-intl.db` / `postalcode-geonames-tail.db`** — no US rows.

## The open question this raises

Several sources here carry US postcodes at different vintages, and freshness matters unevenly by
granularity: the leading digits (sectional centre) are near-static, while individual 5-digit
assignments and their delivery-city labels turn over. Choosing a source on coverage alone is not
enough — see the follow-up survey.
