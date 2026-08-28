# @mailwoman/geocode-oracle

Third-party reference geocoders — Google and the US Census Bureau — as a **verification oracle** for
authoring gauntlet cases. Private: not published, not a dependency of anything on the parse path.

## What it is for

A gauntlet `SeedCase` (`mailwoman/eval-harness/gauntlet/cases/regression.ts`) pins `expectComponents`,
`expectLat`/`expectLon`, `expectToleranceM` and `expectTier` by hand, and today those numbers come from
whoever fixed the bug. This gives that person a second opinion in the same vocabulary: both clients
answer with `@mailwoman/record`'s `PostalAddress` — a `ComponentTag`-keyed dict, the formatter's
`canonicalKey`, a coordinate, and a `ResolutionTier` — so the comparison is field-to-field.

It is **not** truth and **not** a check that anything must pass. Google and the Census Bureau disagree with each other, with the
postal authority, and with the address as written; both will confidently return a coordinate for an
address that does not exist. A human reads the answer and decides what to pin.
`OracleGeocodeResult.raw` always carries the provider's untouched response for that reading.

## Usage

```ts
import { createCensusGeocoderClient, createGoogleGeocoderClient } from "@mailwoman/geocode-oracle/sdk"

await using google = createGoogleGeocoderClient() // reads $private.GOOGLE_MAPS_API_KEY
const [best] = await google.geocodeAddress("181 Rue du Chevaleret, 75013 Paris", { country: "FR" })

await using census = createCensusGeocoderClient() // no credential — free and unauthenticated
const [match] = await census.lookupAddress("4600 Silver Hill Rd, Washington, DC 20233")
```

Both are `@mailwoman/core/api` `APIClient`s, so both carry request pacing, an on-disk response cache,
bounded retry honouring `Retry-After`, and `ResourceError` mapping. Every failure is a `ResourceError`
— branch on `error.status` and `isTransientResourceError(error)`, never on message prose. Each client's
file header carries its full outcome table.

## The two providers, and how they differ

|                | Google                                       | US Census                                    |
| -------------- | -------------------------------------------- | -------------------------------------------- |
| Coverage       | Global                                       | US + territories                             |
| Credential     | `GOOGLE_MAPS_API_KEY`, **billed per call**   | none                                         |
| Best tier      | `address_point` (`ROOFTOP`)                  | `interpolated`, always — see below           |
| Default pacing | 60/min                                       | 60/min                                       |
| Cache TTL      | 30 days                                      | 7 days                                       |
| Cache root     | `$MAILWOMAN_DATA_ROOT/geocode-oracle/google` | `$MAILWOMAN_DATA_ROOT/geocode-oracle/census` |

**The Census geocoder can never return a rooftop coordinate.** It locates an address by finding the
TIGER/Line segment whose address range contains the house number and interpolating along it, so its
coordinate is routinely 20–100 m from the building and further on a long rural segment. Pin
`expectToleranceM` against that, not against a rooftop assumption.

**Google's errors arrive under HTTP 200.** `REQUEST_DENIED`, `OVER_QUERY_LIMIT`, `INVALID_REQUEST` and
`UNKNOWN_ERROR` are 200s carrying a `status` field, invisible to every check `core/api` provides. The
client maps them onto the normal `ResourceError` contract and refuses to cache any body that is not a
real answer — a `REQUEST_DENIED` persisted under a 30-day TTL would make an unbilled key look like a
permanently broken address.

## The API key

Never logged, never in a cache key, never in a filename. It is carried as an Axios instance-level
`params` default rather than concatenated into the URL, so what `APIClient` logs and what
`ResourceError` interpolates is key-free; `geocodeCacheKey` then strips it before the cache key is
built, which also means rotating the key does not orphan the cache.

## Lineage

Ported from the operator's isp-nexus project (`universe/mailwoman/sdk/google/`, `.../sdk/census/`). The
domain logic was salvaged; the plumbing was rewritten onto this repo's own implementation. Each module's
header names what was kept, what was dropped, and why — including the defects found in the originals.
