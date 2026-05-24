---
sidebar_position: 4
title: The database fallacy
---

# The database fallacy

There is a persistent belief in geocoding: **"If we just had a database of all addresses, this problem would be trivial."** The belief is wrong in three independent ways. Together, they make the database approach not merely incomplete but structurally inadequate.

## Fallacy 1 — There is no master list

Every attempt to build a comprehensive address database has produced a partial, outdated, purpose-specific snapshot.

### The USPS AMS

The US Postal Service maintains the **Address Management System** (AMS), the closest thing to a master list for US addresses. It contains every delivery point the USPS recognizes — about 165 million addresses. It is not public. It is licensed to commercial mailers under strict terms. It does not include addresses that USPS does not deliver to (many rural areas, some apartment buildings that use cluster boxes with non-standard numbering). It does not include the names people actually use for places — only the USPS-preferred form.

### National address gazetteers

| Country | Gazetteer                          | Coverage       | Currency                                                       |
| ------- | ---------------------------------- | -------------- | -------------------------------------------------------------- |
| France  | BAN (Base Adresse Nationale)       | ~25M addresses | Updated monthly, ~95% commune coverage                         |
| UK      | AddressBase Plus (Ordnance Survey) | ~40M addresses | Updated every 6 weeks, licensed                                |
| Canada  | National Address Database (NAD)    | ~14M addresses | Incomplete — assembled from volunteer provincial contributions |
| Japan   | MLIT address data                  | ~30M addresses | Comprehensive but in Japanese only                             |
| India   | None                               | 0              | No national address database exists                            |

Each is built for a different purpose: postal delivery (USPS), land registration (AddressBase), census enumeration (MLIT), or navigation (OpenStreetMap). They disagree on what counts as an address. A French commune may have a BAN entry for every building but the postal service delivers to a subset. A UK address in AddressBase may have a UPRN (Unique Property Reference Number) that no other system uses. There is no universal key.

### OpenStreetMap

OSM's `addr:*` tags are volunteer-contributed, uneven in coverage, and structurally different from government gazetteers. OSM tags individual buildings (`addr:housenumber=12`, `addr:street=République`) rather than mailing addresses. An apartment building with 50 units is one OSM node with one housenumber. The mailing addresses for those 50 units (Apt 1A through Apt 5J) are not in OSM.

OSM is excellent for what it is — a collaborative map of the physical world. It is not an address database and was never designed to be one.

### The union of all sources

If you combine USPS AMS + OSM + BAN + NAD + WOF + OpenAddresses + TIGER + every state-level parcel dataset, you get a superset that still has gaps. Rural routes, informal settlements, new construction, addresses in administrative transition — these are systematically underrepresented in every source because they are hard to collect. The union is larger than any single source but the missingness is correlated across sources, not independent. Combining them doesn't fill the gaps — it makes the known-unknowns more visible.

## Fallacy 2 — Addresses are not coordinates

An address is a **social protocol for directing a human courier**, not a geographic coordinate. Multiple protocols coexist on the same building:

| System                  | Address for 350 Fifth Avenue, New York  |
| ----------------------- | --------------------------------------- |
| USPS mailing            | 350 5th Ave, New York, NY 10118         |
| 911 emergency           | 350 5th Ave, Manhattan, NY 10001        |
| Utility billing (ConEd) | 350 5th Ave, New York, NY 10001-0001    |
| Building management     | Empire State Building, 350 Fifth Avenue |
| What a tourist types    | Empire State Building, NYC              |

All five refer to the same physical building. A database that stores only the USPS form will not match a tourist query. A database that stores only the mailing address will misroute a 911 call. A database that tries to store all five forms needs a data model that treats them as equivalent — and that equivalence is a human judgment, not a database join.

### The ZIP code problem

ZIP codes are **carrier routes**, not areas. USPS draws them for delivery efficiency, not for geographic coherence:

- ZIP codes change when carriers retire and routes get redrawn.
- ZIP codes can overlap (different carriers serve different sides of the same street).
- ZIP codes can have holes (a building served by a different post office than the surrounding area).
- A single ZIP code can span multiple municipalities and multiple counties.

The US Census Bureau publishes ZIP Code Tabulation Areas (ZCTAs) as a statistical approximation — generalized polygons that roughly correspond to ZIP code delivery areas. ZCTAs are not USPS ground truth. USPS explicitly does not publish ZIP code boundaries as polygons. Any geocoder that treats a ZIP code as an area is using an approximation of an approximation.

### The postcode problem (international)

Non-US postal codes are even less polygon-like:

- UK postcodes (e.g., `SW1A 1AA`) cover about 15 addresses on average — small enough to be effectively points, but not routing areas.
- Canadian postal codes (e.g., `K1A 0B1`) cover one side of one block face in urban areas, or an entire rural route.
- Irish postcodes (Eircode) are unique per delivery point — each address gets its own postcode. The postcode IS the address.
- French postcodes (e.g., `75008`) correspond to commune boundaries — they are effectively municipal codes that happen to use 5 digits.

A geocoder that treats all postcodes as polygons will produce different error characteristics in every country.

## Fallacy 3 — Administrative boundaries drift

Municipalities annex, de-annex, incorporate, dissolve, and rename themselves. Postcodes get split. Streets get renamed. The half-life of an address is about **5 years** in any urban area — after 5 years, roughly half of the addresses in a fast-growing city have changed in some administratively meaningful way.

| What changes            | How often          | Example                                                        |
| ----------------------- | ------------------ | -------------------------------------------------------------- |
| Municipality annexation | Annual             | Austin, TX annexed ~50 sq mi between 2010-2020                 |
| Street renaming         | Ongoing            | "Malcolm X Boulevard" replaces "Reid Avenue" in Brooklyn       |
| Postcode split          | As needed          | 90210 split into 90210 and 90211 when volume exceeded capacity |
| New construction        | Continuous         | ~1.4M new US housing units per year                            |
| Building renumbering    | Rare but impactful | Entire blocks renumbered when addressing standards change      |

A database snapshot taken in 2024 is wrong in 2026 for some fraction of its entries. The error is not random — it concentrates in the places that are changing the most: growing cities, developing economies, regions with active administrative reform. These are exactly the places where geocoding accuracy matters most.

### The maintenance cost

Keeping a national address database current requires continuous field data collection, integration from municipal building-permit systems, USPS change-of-address feeds, and manual correction of user-reported errors. The USPS spends about $1 billion per year on address management. The UK's Ordnance Survey spends about £150 million. France's BAN is maintained by a consortium of government agencies and La Poste.

For a geocoder that consumes these databases, the maintenance burden is lower — you pull updates from upstream sources. But you are still dependent on those upstream sources staying current, staying funded, and staying in a format you can consume. When the UK's AddressBase licensing terms changed in 2020, several open-source geocoders had to drop UK coverage entirely.

## What this means for a parser

The parser should not try to be a database. It should not store every address. It should not attempt to resolve "Springfield" to a coordinate without context.

The parser's job is to **extract structured components from a string** — to say "this token is a locality, this token is a region, and their relationship to each other is administrative containment." The resolver's job is to look up those components in a gazetteer and return candidates with confidence scores. The resolver can be updated independently of the parser when gazetteers change.

A parser that tries to memorize addresses will be wrong on every address that changed since the training data was collected. A parser that learns the _structure_ of addresses — what tokens look like, how they group, what ordering patterns are statistically likely — will generalize to new addresses in new construction in renamed municipalities. The database fallacy is the belief that the first kind of parser can be made complete. The response is that it cannot, and it shouldn't try.

## See also

- [How mail delivery actually works](./how-mail-delivery-works.md) — the system that doesn't need a perfect database either
- [The 90% trap](./the-90-percent-trap.md) — why 90% database coverage is deceptively expensive
- [The tokenization tautology](./the-tokenization-tautology.md) — why traditional parsers fall into a related completeness trap
- [What is an address?](./what-is-an-address.md) — the data model these databases attempt to capture
