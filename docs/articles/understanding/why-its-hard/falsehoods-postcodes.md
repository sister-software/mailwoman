---
sidebar_position: 27
title: Falsehoods about postcodes
tags:
  - domain
  - falsehoods
  - postcode
  - international
  - en-us
  - multilingual
---

# Falsehoods programmers believe about postcodes

## The falsehoods

Programmers consistently assume postcodes are numeric, map to single cities, cover multiple buildings, are known to the user, and exist for every address. Real postcodes violate all of these.

### "Postcodes are all-numeric."

US ZIP codes established the expectation, but most of the world uses alphanumeric: `SW1A 1AA` (UK), `K1A 0B1` (Canada), `D02 X285` (Ireland). A parser that assumes `\d{5}` for postcodes will fail on every non-US, non-French address.

The format diversity is deeper than alphanumeric vs. numeric. UK postcodes have a space in a fixed position (`SW1A 1AA`). Canadian postcodes alternate letter-digit (`K1A 0B1`). Dutch postcodes are `\d{4} [A-Z]{2}`. A parser that maintains per-locale postcode regexes works for a fixed set of supported countries. A neural model that learns postcode patterns from training data can generalize to new formats without new regexes — if the training data includes them.

### "Postcodes don't start with zero."

`02109` (Boston, MA), `07737` (Jena, Germany), `0800` (Darwin, Australia), `00002` (Helsinki, Finland). Brazilian and Israeli postcodes also start with zero. A parser that stores postcodes as integers strips leading zeros. A system that sorts postcodes numerically puts `02109` before `10001`. A form field that rejects `0` as the first character rejects real addresses.

French postcodes are particularly dangerous: `06130` (Grasse, département 06) and `6130` (routed to département 61, Orne) are different places. The leading zero is load-bearing. A parser that strips it routes Grasse to the wrong département.

### "A postcode maps to a single city."

ZIP code 33334 covers three cities: Oakland Park, Wilton Manors, and Fort Lauderdale — all in Florida. USPS assigns ZIP codes to delivery routes, not municipal boundaries. A postcode-to-city lookup table that returns one city per postcode will be wrong for a significant fraction of US addresses.

The reverse is also true: a single city can have dozens of postcodes. New York City has about 170 ZIP codes. London has hundreds of postcode districts. "New York, NY" without a ZIP is specific to the city but not to any delivery point within it.

### "A single postcode covers multiple buildings."

The Empire State Building has its own ZIP code: `10118`. In the UK, alphanumeric postcodes typically cover ~15 addresses — effectively point-level resolution. The DVLA in Swansea uses `SA99 1BA` for V5C processing and `SA99 1AB` for driving licences — different postcodes for different departments in the same building. The London Borough of Enfield uses five postcodes for five departments.

Conversely, some postcodes cover large populations: UK postcode `CV4 7AL` serves the entire University of Warwick — 6,000 students living on campus plus staff. French postcode `75015` covers the XVth arrondissement of Paris with over 230,000 people. The granularity of a postcode tells you about the postal service's delivery structure, not about the density of the area.

### "The user knows their postcode."

Most people know their 5-digit ZIP code. Far fewer know their ZIP+4. Almost no one knows their delivery point code (the last two digits). When a user types `90210`, they are giving a 5-digit approximation of their address — off by up to several miles for rural routes. A geocoder that treats `90210` as a precise location is misleading the user.

Misreading handwritten postcodes is a common failure mode. A human writes `SW1A 1AA` and the OCR reads `SW1A 1A4` — one character off, different delivery point. The postal system handles this through carrier local knowledge (the carrier knows the route). A geocoder returns a coordinate for the wrong address.

### "Every address has a postcode."

Ireland did not have postcodes until Eircode launched in 2015. Hong Kong does not use postcodes for domestic mail. Rural addresses in many countries use descriptive directions instead of postal codes. Military addresses use APO/FPO codes that route through military postal hubs, not geographic locations.

Some countries have postcodes for parts of the country but not others. Some have postcodes that are assigned to delivery routes rather than geographic areas and are not published.

### "A postcode stays the same."

USPS changes approximately 5,000 ZIP codes per year — additions, deletions, boundary adjustments. The UK's Royal Mail updates postcodes monthly. A postcode that was valid when a database was built may be retired or reassigned by the time it is queried.

Douglas Perreault's condo in Florida changed ZIP codes twice in a few years: `33549` → `33612` → `33613`. Same physical location, three different ZIP codes. A geocoder that cached the first ZIP code would be wrong for the last two.

## How traditional geocoders handled these

**libpostal** uses a regex-based `postcode` classifier with per-country patterns. `\d{5}` for US, `\d{5}` for France (same pattern, different semantics), `[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}` for UK. The classifier is deterministic and correct for the formats it covers — but adding a new country requires adding a new regex. The project has stalled since ~2018, so postcode formats introduced after 2018 (Eircode) are not covered.

**Pelias** uses a similarly regex-based approach with per-country postcode patterns in its `postalcode` classifier. Pelias also uses the postcode to bias the resolver: if the postcode matches a known administrative area, the resolver weights candidates within that area higher. This is the right approach — the postcode is supplementary evidence, not a primary locator — but it requires maintaining a postcode-to-place mapping that drifts with postal service updates.

**Google's API** handles postcodes as part of its integrated geocoding model. The API returns address components including postal code and uses the postal code as a search-space constraint. Google's coverage of international postcode formats is comprehensive, but the user cannot inspect or correct the postcode-to-place mapping.

## What the neural approach changes

**The locale gate (Stage 2)** detects the address's country or script family before classification. A UK-formatted address routes to a UK postcode pattern expectation. A Canadian address routes to a Canadian pattern. The classifier does not need to try every global postcode regex on every input — the locale gate narrows the format space.

**The classifier (Stage 3)** learns postcode patterns from corpus co-occurrence. A 5-digit number after a US state abbreviation and before the end of the address is a ZIP code. A 5-digit number before a French locality name is also a postcode — just in a different position. The model learns the positional distribution, not the regex. This means it can handle new postcode formats that appear in training data without new regexes.

**The resolver (Stage 6)** treats the postcode as a search-space constraint, not a primary locator. When the postcode is present, the resolver limits gazetteer lookups to the postcode's rough administrative area. When the postcode is absent, the resolver searches the full gazetteer and returns lower-confidence candidates. The postcode is supplementary evidence — the resolver does not drop to postcode-only geocoding unless nothing else is available.

**The reconciler (Stage 5)** catches the leading-zero problem indirectly: if a postcode is stripped of its leading zero (e.g., `06130` → `6130`), the WOF resolver's concordance check will fail because the parent chain for département 61 does not contain Grasse. The reconciler surfaces the ambiguity rather than silently accepting the wrong postcode.

## What Mailwoman still can't do

- **Postcode format detection without a locale gate.** The model can learn that `SW1A 1AA` is a postcode format if the training corpus includes UK addresses, but without the locale gate detecting "this is a UK address," the model is learning a distribution over all global postcode formats simultaneously. The locale gate reduces this to a per-country problem.
- **Postcode changes in production.** The resolver's WOF SQLite distribution is a snapshot. When postcodes change (USPS monthly updates, UK Royal Mail monthly updates), the snapshot drifts. The resolver can be updated independently of the parser, but the update cadence must match the postal service's change cadence — weekly or monthly — for production use.
- **Delivery point codes.** The full 11-digit USPS delivery point barcode is not present in any open gazetteer. The 5-digit ZIP is the finest resolution the resolver can achieve from open data. For delivery-point-level resolution, a commercial address verification service is required.

## References

- [Series overview: Falsehoods about addresses](./falsehoods-about-addresses.md)
- [Michael Tandy's original catalogue](https://www.mjt.me.uk/posts/falsehoods-programmers-believe-about-addresses/)
- [What is a postcode?](../the-problem/what-is-a-postcode.md) — postcodes as routing instructions, not geographic areas
- [What is a ZIP Code and how is it structured?](../the-problem/what-is-a-zip-code.md) — the US 11-digit system in detail
- [The database fallacy](./the-database-fallacy.md) — why postcode-to-place mappings are never complete
