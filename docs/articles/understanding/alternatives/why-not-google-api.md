---
sidebar_position: 22
title: Why not just use Google's API?
tags:
  - domain
  - hubris
  - motivation
  - en-us
  - international
---

# Why not just use Google's API?

Google's Geocoding API is the default choice for geocoding. It is fast, globally comprehensive, and returns results in milliseconds. For many applications, calling Google is the right move. For applications that need to own their address data, audit their results, or operate at scale, it is the expensive kind of cheap.

## What you get

Google's Geocoding API converts an address string into a latitude/longitude, a formatted address, and a set of address components (street number, route, locality, administrative area, country, postal code). The API does parsing, resolving, and formatting in a single call. There is no separate parser or gazetteer — Google's model handles everything.

### Pricing (as of 2026)

| Tier     | Cost per 1,000 requests | Monthly free quota          |
| -------- | ----------------------- | --------------------------- |
| Standard | $5.00                   | $200 credit (~40K requests) |
| Premium  | Negotiated              | Higher quota                |

At $5/1K requests, geocoding 1 million addresses per month costs $5,000. That is not a large line item for a funded startup. It becomes material at 10M+ requests per month, where the annual cost crosses into six figures.

### Coverage

Google claims coverage in 250+ countries and territories. Quality varies dramatically by region:

| Region type                          | Quality                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| US, Western Europe, Japan, Australia | Excellent — precise to rooftop or building entrance                  |
| India, Brazil, Southeast Asia        | Good — municipality or neighborhood level, not building-level        |
| Sub-Saharan Africa, Central Asia     | Variable — region or locality level, significant gaps in rural areas |

The uneven coverage is not Google's fault — it reflects the quality of the underlying data sources in each country. But it means the API's "global" label masks significant regional variation.

## What you give up

### You don't own the results

Google's terms of service prohibit storing geocoding results beyond 30 days. You can cache results temporarily, but you cannot build a database of geocoded addresses from Google's output. Every time you need to geocode the same address, you pay again.

This matters for applications that process the same addresses repeatedly:

- A logistics company that geocodes the same 10,000 delivery addresses every day.
- A real estate platform that shows the same 50,000 property locations to every visitor.
- A government agency that maintains an address registry updated quarterly.

In each case, the addresses are stable. The geocoding should be a one-time cost. Google's terms make it recurring.

### You can't audit correctness

When Google returns a geocode, you get a confidence score (rooftop, range-interpolated, geometric center, approximate). But you cannot inspect how Google arrived at the result. If a specific address consistently geocodes to the wrong building, you cannot:

- Trace which data source produced the error.
- Correct it in Google's database (you can report it, but correction is not guaranteed).
- Add a local override for your own use case.

You are renting a black box. When the black box is wrong, your only option is to handle the error downstream — escalate to manual review, accept the inaccuracy, or use a different provider for that address. You cannot fix the parser.

### Your query data is Google's training data

Google's privacy policy does not guarantee that your geocoding queries are not used to improve Google's services. For most applications, this is acceptable — address data is not sensitive in the way that medical records or financial transactions are. For applications that deal with protected addresses (domestic violence shelters, witness protection, military facilities), sending address queries to a third party is a privacy violation.

### You are locked into Google's ontology

Google's address component types (route, sublocality, administrative_area_level_1, etc.) are Google's taxonomy. They do not always map cleanly to other address schemas:

| Google component              | Mailwoman equivalent | Notes                         |
| ----------------------------- | -------------------- | ----------------------------- |
| `administrative_area_level_1` | `region`             | US state, French région       |
| `administrative_area_level_2` | `subregion`          | US county, French département |
| `sublocality`                 | `dependent_locality` | Neighborhood, borough         |
| `route`                       | `street`             | Street name without number    |
| `street_number`               | `house_number`       | Building number               |

If your application uses a different address model, you must translate Google's output into your schema. The translation is lossy — Google may return components that have no equivalent in your model, or omit components your model considers required.

## When Google's API is the right choice

Despite these limitations, Google's API is the right choice for:

- **Prototypes and MVPs.** You need geocoding working today, not in six months. The API cost is negligible at prototype scale.
- **One-shot batch processing.** You have a fixed set of addresses to geocode once. The one-time cost is lower than building infrastructure.
- **Global coverage without a data team.** You do not have the resources to source and maintain gazetteers for 100+ countries.
- **Integration with Google Maps.** If you are already rendering results on Google Maps, using Google's geocoder avoids coordinate-system mismatches.

For these use cases, the API's speed and coverage outweigh its lock-in costs.

## When owning your parser is the right choice

Owning your parser is the right choice when:

- **You geocode the same addresses repeatedly.** A one-time geocoding cost, cached locally, amortizes the infrastructure investment over time.
- **You need auditable results.** When correctness matters (delivery routing, emergency services, government compliance), being able to trace a geocode back to its source data is non-negotiable.
- **You operate in regions where Google is weak.** If a significant fraction of your addresses are in countries where Google's coverage is at the locality level, a regional gazetteer may outperform Google.
- **You need a specific address model.** If your downstream systems use ISO 19160 address components or a custom schema, translating Google's components is a recurring development cost.
- **You handle protected addresses.** If privacy regulations or internal policy prohibit sending addresses to third-party APIs, you need an in-house solution.

Mailwoman targets the "own your parser" niche. It is not a Google competitor — it is an alternative for applications where Google's terms, pricing, or opacity make the API unsuitable.

## See also

- [The 90% trap](../why-its-hard/the-90-percent-trap.md) — the economic argument for owning your parser
- [The database fallacy](../why-its-hard/the-database-fallacy.md) — why even Google's database has gaps
- [Why not use geocode.earth?](./why-not-geocode-earth.md) — the open-source hosted alternative
