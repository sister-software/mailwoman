# The NYC postal-city rows are absent from the source, not dropped by the builder (2026-08-04)

Answers the open question [#1446](https://github.com/sister-software/mailwoman/issues/1446) parked
before adding anything to `postal-city-alias-us.db` by hand: does the builder's source genuinely lack
NYC rows, or does it carry them and drop them?

**Neither, exactly. The rows are there in abundance; the `postal_city` FIELD is empty for them.** No
builder change recovers NYC — not `minCount`, not a relaxed filter — because the signal the alias
index is built from does not exist in this source for the five boroughs.

Measured against the pinned build source,
`/mnt/playpen/mailwoman-data/overture/2026-05-20.0/addresses-us.parquet` (6.9 GB), state-scoped so a
malformed postcode elsewhere cannot masquerade as NYC (`address_levels[1].value = 'NY'` plus an NYC
postcode shape — an unscoped `substr(postcode,1,3)` filter pulls in Gainesville TX and Pikeville TN).

## The numbers

|                                                           |       rows |
| --------------------------------------------------------- | ---------: |
| NY-state rows with an NYC postcode                        |  1,051,501 |
| …carrying `address_levels[2]` (the `geo_locality` clause) |  1,051,500 |
| …carrying `postal_city`                                   | **83,666** |
| …surviving both clauses                                   |     83,665 |

So `address_levels[2]` drops one row. `postal_city IS NOT NULL` drops 92%.

And the survivors are the wrong places. Every aggregate that clears the builder's `HAVING` is
**Nassau County** — Long Island suburbs that share the 110xx prefix, not the five boroughs:

| postcode | postal_city     | geo_locality    |      n |
| -------- | --------------- | --------------- | -----: |
| 11003    | elmont          | hempstead       | 11,016 |
| 11040    | new hyde park   | north hempstead | 10,165 |
| 11010    | franklin square | hempstead       |  8,375 |
| 11050    | port washington | north hempstead |  6,886 |
| 11001    | floral park     | floral park     |  5,891 |

## The city itself

967,837 rows carry `geo_locality = "new york"`. **Two of them carry a `postal_city`.**

The boroughs are absent as a geographic locality entirely — zero NY-state rows name `brooklyn`,
`queens`, `bronx`, `the bronx`, `staten island` or `manhattan` in `address_levels[2]`. As a
`postal_city`, only `bronx` appears at all, 43 times. No `brooklyn`, no `queens`, no `staten island`,
and no `new york`.

## This is a city-shaped hole, not a state-shaped one

`postal_city` coverage is wildly uneven across the source, and NY is not a low-coverage state:

| state |       rows | with `postal_city` |        |
| ----- | ---------: | -----------------: | -----: |
| IL    |  4,859,575 |          4,859,556 | 100.0% |
| TX    | 11,545,775 |          9,850,109 |  85.3% |
| NY    |  6,471,391 |          5,503,521 |  85.0% |
| CA    | 14,028,636 |            301,784 |   2.2% |
| FL    | 12,195,275 |                  0 |     0% |
| MA    |  3,637,789 |                  0 |     0% |

Subtracting the NYC rows from NY leaves 5,419,890 upstate/Long-Island rows of which 5,419,855 carry a
`postal_city` — **99.999%**. Coverage does not fall off gradually toward the city; it goes from
essentially total to essentially zero at the city line.

Worth noting for anyone reading the builder's headline ("45.9M US rows carry BOTH … 34.9% diverge"):
that aggregate is true and also concentrated. FL and MA contribute nothing to it at all.

## What follows

1. **Nothing to tune.** The builder is behaving correctly on the data it has. Do not lower
   `minCount` or relax the `postal_city` clause hoping NYC appears; it is not there to appear.
2. **NYC needs a different source.** The authority is the USPS City-State Product (ZIP → delivery
   city), which is licensed. Any open derivative would need its own provenance review before it
   could feed a shipped artifact.
3. **The modelling trap in #1446 still stands, and is now the second obstacle rather than the
   first.** Even holding the data, `(11201, brooklyn, new york)` is the wrong edge:
   `postal-city-alias-lookup.ts` appends `postalCity` surfaces to the matching candidate locality's
   alias set, so that row makes "Brooklyn" a name for locality New York and sends an 11201 address to
   New York's label point, 5.74 km from Brooklyn's own. Brooklyn is a borough inside New York, and
   WOF already models it as one.
4. **Re-measure after the gazetteer rebuild before doing anything here.** #1445's borough-ancestry
   repair may make the borough reachable on its own, which was the reason #1446 was sequenced second.

## Reproduce

```bash
node scripts/scratchpad/nyc-postal-probe.ts
```
