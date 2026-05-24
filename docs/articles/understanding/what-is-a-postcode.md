---
sidebar_position: 8
title: What is a postcode?
tags:
  - domain
  - concepts
  - postcode
  - international
  - en-us
  - multilingual
---

# What is a postcode?

A postcode is a **routing instruction**, not a geographic area. It tells a postal service how to sort and deliver mail. It does not tell a geocoder where a building is, what municipality it belongs to, or what polygon contains it. Confusing these two things is the most common error in address geocoding — and the source of a surprising fraction of production bugs.

## What postcodes actually encode

Every postal system uses postcodes differently, but the common thread is **hierarchical routing**:

| Country           | Format       | What each level means                                                                                  |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| US (ZIP)          | `12345-6789` | 5-digit: sectional center → post office. +4: block face or building. Last 2 (delivery point): mailbox. |
| UK                | `SW1A 1AA`   | Area (SW) → district (1A) → sector (1) → unit (AA). Covers ~15 addresses.                              |
| France            | `75008`      | First 2 digits: département (75 = Paris). Last 3: commune-level routing.                               |
| Canada            | `K1A 0B1`    | Forward sortation area (K1A) → local delivery unit (0B1). One side of one block face.                  |
| Ireland (Eircode) | `D02 X285`   | Unique per delivery point. The postcode IS the address.                                                |
| Japan             | `100-0001`   | 3-digit regional + 4-digit local. Coarser than US +4; municipality is the finer unit.                  |

The hierarchy is for sorting mail, not for describing geography. A US 5-digit ZIP gets a letter to the right post office — that's it. The carrier who delivers it knows which streets are in their route. The ZIP doesn't encode that information explicitly.

## Why postcodes are not polygons

The US Postal Service does not publish ZIP code boundaries. The ZIP code is a route, not a shape. A single ZIP can contain:

- Multiple municipalities (a rural route that crosses town lines).
- Gaps (a building served by a different post office than the surrounding area).
- Overlaps (different carriers serve different sides of the same street).
- Non-geographic assignments (PO boxes, military APO/FPO addresses, unique large-volume mailers).

When you see a ZIP code displayed as a polygon on a map, you are almost certainly looking at a **ZIP Code Tabulation Area** (ZCTA) — a statistical approximation produced by the US Census Bureau. ZCTAs are generalized from census blocks, not from USPS delivery routes. USPS explicitly disclaims them. The Census Bureau's own documentation says ZCTAs "are not exact representations of USPS ZIP Code service areas."

This matters because the errors are systematic:

- **Rural areas are the worst.** A rural ZIP may cover hundreds of square miles. The ZCTA centroid can be 10+ miles from any actual delivery point. Geocoding a rural address to its ZIP centroid routinely produces errors of 5-15 miles.
- **New development is invisible.** When a new subdivision is built and assigned a new ZIP+4, the ZCTA won't reflect it until the next decennial census — up to 10 years.
- **PO boxes cluster at post offices.** A ZIP code used primarily for PO boxes (common in small towns) will produce a centroid at the post office building, not at the residences the PO box holders live in.

## What to do with a postcode in a geocoder

A geocoder should treat a postcode as **supplementary evidence**, not as a primary locator:

1. Use the postcode to narrow the resolver's search space (limit gazetteer lookups to places within the postcode's rough region).
2. Use the postcode to validate the parse (if the parsed locality and the postcode's known municipality disagree, flag the ambiguity).
3. Do NOT return coordinates from a postcode alone unless the postcode is a delivery-point code (Eircode, UK postcode with full unit, US ZIP+4+2). Even then, flag it as "postcode-level resolution," not "address-level."

A user who types `90210` into a geocoder is not asking "where is ZIP code 90210?" They are asking "where is the place I associate with 90210?" The correct answer is "Beverly Hills, CA" with a note that the ZIP covers multiple municipalities and the precise location cannot be determined from the postcode alone. The incorrect answer is a pin dropped at the ZCTA centroid with the label "Beverly Hills."

## Why the postal system does this

Postcodes are designed for sorting machines and carrier routes, not for maps. Every design choice follows from this:

- **They change.** When a carrier retires and routes are redrawn, postcodes can split or merge. The USPS changes approximately 5,000 ZIP codes per year (additions, deletions, boundary adjustments).
- **They prioritize delivery efficiency over geographic coherence.** A postcode boundary that follows a creek saves the carrier a bridge crossing. It makes no geographic sense on a map, but it saves 20 minutes of driving per day.
- **They serve multiple delivery modes.** The same ZIP code can include street addresses, PO boxes, and general-delivery addresses, all routed to different places at the same post office.

A postcode is a remarkably effective system for moving mail. It is a remarkably bad system for locating things. The geocoder's job is to bridge that gap — to interpret the routing instruction as a spatial hint without pretending it's a spatial truth.

## See also

- [What is a ZIP Code and how is it structured?](./what-is-a-zip-code.md) — the US system in detail
- [The database fallacy](./the-database-fallacy.md) — why there is no master list of postcode-to-place mappings
- [How mail delivery actually works](./how-mail-delivery-works.md) — the system postcodes were designed for
