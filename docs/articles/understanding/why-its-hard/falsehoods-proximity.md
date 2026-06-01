---
sidebar_position: 37
title: Falsehoods about geocoded precision and frontages
tags:
  - domain
  - falsehoods
  - locality
  - street
  - venue
---

# Falsehoods programmers believe about geocoded precision and frontages

_"Close enough" is a statement about your use case, not about the coordinate. A geocode that is correct for statistical aggregation may be catastrophically wrong for emergency dispatch. And the coordinate itself answers a question — "the front door" — that nobody bothered to define._

## The falsehoods

### "An address has one correct coordinate."

Every address has multiple correct coordinates, depending on what you mean by "the address":

| What you mean             | The coordinate                                      | Precision                                                                    |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| The public entrance       | Street-facing door                                  | Sub-meter                                                                    |
| The delivery entrance     | Rear loading dock, side door                        | Sub-meter, possibly different street                                         |
| The package drop-off      | Mailroom, front desk, lobby                         | Within the building, possibly different floor                                |
| The emergency entrance    | Clearly marked, accessible, fire department key box | Sub-meter                                                                    |
| The parcel centroid       | Tax assessor's coordinate for the land parcel       | Often the geometric center of the lot, not the building                      |
| The building centroid     | Geometric center of the building footprint          | If the building is at the back of the lot, off by 30+ meters from the street |
| The street frontage point | Where the driveway meets the road                   | Off by 10-100 meters from the building                                       |
| The rooftop               | The center of the building's roof                   | Same as building centroid, different elevation                               |
| The mailbox               | Where the postal carrier delivers                   | May be at the curb, on the house, or at a cluster box down the street        |

None of these is "the coordinate." Each is correct for a specific purpose. A geocoder that returns one coordinate is making an implicit choice about which purpose it serves — and that choice may be wrong for the consumer's use case.

USPS delivery to a rural address: the mailbox is at the road, 200 meters from the house. The "correct" geocode for the postal carrier is the mailbox. The "correct" geocode for a ride-share driver is the house. The "correct" geocode for the tax assessor is the parcel centroid. Three different correct answers for the same address.

### "Close enough is close enough for all use cases."

"Close enough" depends on what you're doing:

| Use case                                          | Required precision      | Why                                        |
| ------------------------------------------------- | ----------------------- | ------------------------------------------ |
| Statistical aggregation (census, market analysis) | Block group (~250m)     | You're counting people, not finding them   |
| Regional routing (which warehouse?)               | City-level (~5km)       | The truck is going to the right metro area |
| Delivery routing (which truck?)                   | Street segment (~50m)   | The driver needs the right block           |
| Last-mile delivery (which door?)                  | Building entrance (~5m) | The driver needs the right building        |
| Emergency dispatch (which entrance?)              | Specific door (~1m)     | Seconds matter, wrong entrance kills       |
| Utility service (which meter?)                    | Specific wall (~0.5m)   | The gas shutoff is on the north wall       |

A geocode that is "close enough" for market analysis (city-level) is wrong by 5 kilometers for last-mile delivery. A geocode that is "close enough" for delivery routing (street segment) is wrong by 50 meters for emergency dispatch. The same coordinate can be useful for one consumer and useless for another.

The failure mode: a geocoder returns a coordinate at "95% confidence." The consumer assumes this means "within 5 meters of the front door." The geocoder meant "within the correct ZIP code." The consumer routes an ambulance to the ZIP centroid. The ambulance is 8 miles from the actual address.

### "The geocode is the front door."

The "front door" is ambiguous even when the building has exactly one street-facing entrance:

- A corner building has two street-facing entrances. Which one is "the front door"?
- A building with a front entrance on a named street and a delivery entrance on an alley has two entrances. The address label says the street name. The delivery driver uses the alley.
- A strip mall has a dozen storefronts along a parking lot. Each store has a different entrance. A geocode for the strip mall's address places the pin at the center of the building — 50 meters from any actual store entrance.
- A hospital has a main entrance, an emergency entrance, a loading dock, and a staff entrance. The address label is the same for all four. A geocode that returns "the front door" for the hospital places the pin at the main entrance. An ambulance routed to the main entrance instead of the emergency entrance loses minutes.
- A multi-building campus (university, corporate headquarters, hospital complex) has one mailing address and dozens of building entrances. "123 University Ave" geocodes to the campus entrance or the administration building. A delivery to "123 University Ave, Engineering Building" needs the engineering building's entrance, which is 500 meters from the campus entrance.

### "The building entrance faces the street in the address."

A building at the corner of Main St and Elm St may have the address `123 Main St` but the only public entrance is on Elm St. The address's street name is a label, not a statement about entrance orientation.

A building set back from the road with a long driveway may have the address on the road but the building 100 meters from it. The geocode at the road frontage is correct for the mailbox but wrong for the building.

A rear-access building in a dense urban area may have a street address on the front street but the delivery entrance in an alley behind the building. The geocode at the street frontage is wrong for delivery.

### "The geocode's precision is the same as its accuracy."

A geocoder can return a coordinate with 8 decimal places (sub-millimeter precision) that is accurate to within 5 kilometers. The precision is a property of the floating-point representation. The accuracy is a property of the data source and algorithm. Consumers see "37.422387, -122.084084" and assume the coordinate is precise to the digit. It isn't.

Google's Geocoding API returns a `location_type` with each result: `ROOFTOP`, `RANGE_INTERPOLATED`, `GEOMETRIC_CENTER`, or `APPROXIMATE`. This is the right taxonomy — it tells the consumer the accuracy rather than the precision. Most geocoders don't expose this. They return a coordinate and a confidence score, and the consumer assumes the confidence score maps to spatial accuracy. It doesn't.

### "Two geocodes at the same coordinate are the same address."

A shopping mall at one lat/lon has 100+ addresses. An office tower has one address per floor. A post office has hundreds of PO box addresses at one coordinate. Reverse-geocoding the coordinate returns the mall, the tower, or the post office — not the specific store, suite, or box.

The reverse geocode is answering "what place is at this coordinate?" not "what addresses resolve to this coordinate?" The latter question requires a forward geocode of every candidate address and comparison of the resulting coordinates. The former question is what most geocoders actually answer.

## How traditional geocoders handled these

**libpostal** does not produce coordinates — it produces labeled text spans. The precision question is downstream. This is architecturally correct: the parser's confidence is about label correctness, not spatial accuracy. The resolver owns the spatial question.

**Pelias** returns coordinates from Elasticsearch queries against gazetteer data. The coordinate is the centroid of the matched record — a locality centroid for city-level matches, a building centroid for address-level matches. Pelias does not distinguish between "building entrance" and "parcel centroid" coordinates because the underlying data (WOF, OSM, OpenAddresses) doesn't consistently model that distinction.

**Google's API** returns `location_type` as described above. Google's Places API returns multiple `types` for each result (street_address, premise, subpremise, point_of_interest, etc.) and a `viewport` bounding box. This gives the consumer enough metadata to distinguish "this coordinate is the building" from "this coordinate is the street" — but most consumers ignore the metadata and take the coordinate.

**SmartyStreets / Melissa Data** (commercial address verification) return multiple coordinates per address: a delivery point (mailbox), a rooftop (building center), and sometimes a street frontage point (where the driveway meets the road). This is the right model — the API returns the available coordinates and labels what each one means. It costs money and covers US addresses only.

## What the neural approach changes

**The resolver (Stage 6) returns candidates with placetypes, not a single coordinate.** A WOF record has a `placetype` and optionally a bounding box. The resolver returns the placetype alongside the coordinate, so the downstream system knows whether it received a building-level coordinate or a locality centroid. But WOF does not distinguish between "building entrance" and "building centroid" — both are the same coordinate in WOF's data model.

**The resolver can return multiple candidates per address component.** `locality=Springfield` returns 34 candidates, each with a different coordinate. The downstream system can choose the one that matches additional context (state, postcode) or surface all of them. The resolver does not pretend to know which Springfield when it doesn't.

**Confidence is per-component, not spatial.** The parser's confidence score is about the label — "I'm 95% sure this token is a locality" — not about the coordinate — "I'm 95% sure the locality is within 500 meters of this point." The resolver's score is about gazetteer match quality, not spatial accuracy. Separating these into different signals (label confidence, resolver match quality, spatial precision metadata) is future work.

## What Mailwoman still can't do

- **Frontage-level coordinates.** WOF stores one coordinate per record — typically a centroid. Mailwoman's resolver returns that coordinate. Multiple coordinates per address (entrance, delivery, parcel centroid) require a gazetteer that stores them and a resolver that exposes them. No open gazetteer does this at global scale.
- **Precision metadata.** The resolver does not return a `location_type` equivalent (ROOFTOP vs GEOMETRIC_CENTER vs APPROXIMATE). WOF records don't consistently encode how the coordinate was derived. Adding a precision signal to the resolver output is planned but not yet implemented.
- **Reverse geocoding.** The resolver forward-geocodes — text → coordinate. Reverse geocoding (coordinate → text) is a different problem with different infrastructure (spatial index, not text index). Mailwoman does not do reverse geocoding.

## References

- [Series overview: Falsehoods about addresses](./falsehoods-about-addresses.md)
- [Michael Tandy's original catalogue](https://www.mjt.me.uk/posts/falsehoods-programmers-believe-about-addresses/)
- [Falsehoods about address shapes and dimensions](./falsehoods-shapes.md) — the spatial companion piece
- [How can a building have two addresses?](../the-problem/how-can-a-building-have-two-addresses.md) — why a building has multiple correct coordinates
- [How mail delivery actually works](../the-problem/how-mail-delivery-works.md) — the delivery chain that consumes these coordinates
