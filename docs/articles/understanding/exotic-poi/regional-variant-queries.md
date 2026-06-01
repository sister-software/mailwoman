---
sidebar_position: 4
title: Regional variant queries
tags:
  - domain
  - venue
  - international
  - multilingual
---

# Regional variant queries

A regional variant is a local term for an amenity, brand, or category that differs from the global or standard name. "Servo" means gas station in Australia. "Bodega" means corner store in New York City. "マクド" (makudo) means McDonalds in the Kansai region of Japan. In their region, these **are** the standard — the everyday word millions of people reach for, every bit as legitimate as the global name.

A geocoder that only recognizes the global standard name ("gas station," "convenience store," "McDonald's") is useless for users who search with regional variants. The geocoder doesn't need to translate the variant — it needs to recognize it as equivalent to the standard category.

## The variant taxonomy

Regional variants fall into several categories:

### Amenity variants

| Standard term              | Regional variant      | Region                      |
| -------------------------- | --------------------- | --------------------------- |
| gas station                | servo                 | Australia                   |
| gas station                | petrol station        | UK, Ireland, Commonwealth   |
| convenience store          | bodega                | NYC, parts of US Northeast  |
| convenience store          | corner shop           | UK                          |
| convenience store          | depanneur (dépanneur) | Quebec                      |
| convenience store          | milk bar              | Australia (declining)       |
| liquor store               | off-licence           | UK, Ireland                 |
| liquor store               | bottle shop           | Australia                   |
| liquor store               | package store         | New England, US             |
| pharmacy                   | chemist               | UK, Australia               |
| pharmacy                   | apothecary            | Historical, some US regions |
| restaurant (delivery only) | takeaway              | UK, Australia               |
| restaurant (delivery only) | takeout               | US, Canada                  |
| public restroom            | loo                   | UK                          |
| public restroom            | washroom              | Canada                      |
| garbage can                | rubbish bin           | UK, Australia               |
| garbage can                | dustbin               | UK (older)                  |
| residential building       | flat                  | UK                          |
| residential building       | apartment             | US                          |
| elevator                   | lift                  | UK                          |

### Brand variants

| Brand       | Regional variant              | Region                      |
| ----------- | ----------------------------- | --------------------------- |
| McDonald's  | Macca's                       | Australia                   |
| McDonald's  | マクド (makudo)               | Kansai, Japan               |
| McDonald's  | マック (makku)                | Kantō, Japan                |
| McDonald's  | McDo                          | France, Quebec              |
| McDonald's  | Mek                           | Germany, Austria            |
| McDonald's  | Mickey D's                    | US (slang)                  |
| KFC         | PFK (Poulet Frit Kentucky)    | Quebec (legal name)         |
| Burger King | Hungry Jack's                 | Australia (trademark issue) |
| 7-Eleven    | セブンイレブン (sebun irebun) | Japan                       |
| Starbucks   | スタバ (sutaba)               | Japan (slang)               |

### Japanese brand abbreviation patterns

Japanese brand name variants follow predictable patterns that a geocoder could learn:

- **Truncation to 2 mora**: マクドナルド → マクド (first 2 kanas of the loanword). スターバックス → スタバ. セブンイレブン → セブイレ or セブン. ファミリーマート → ファミマ.
- **Regional variation**: The same brand can have different abbreviations in different regions. マクド (Kansai) vs マック (Kantō) for McDonalds. This is a known linguistic phenomenon — Kansai speakers prefer the first two mora of the first word, Kantō speakers prefer the full first word.
- **Loanword adaptation**: Brand names borrowed into Japanese are adapted to Japanese phonology. "McDonald's" → マクドナルド (makudonarudo). "Starbucks" → スターバックス (sutābakkusu). In Japanese, these are simply the name — the form on every storefront and menu.

### Code-switching queries

Some queries mix languages: `スタバ near Shibuya Station`. The brand name is in Japanese slang. The location constraint is in English and Japanese. The geocoder must handle the code-switch — recognize スタバ as Starbucks, parse `Shibuya Station` as a transit location, and compose the query.

## How traditional geocoders handle regional variants

**Google** handles regional variants through its search model, trained on global query logs. "Servo" returns gas stations in Australia because Google's Australian users search for "servo" and click on gas station results. The mapping is learned from user behavior, not hand-curated.

This is the right approach for a global-scale geocoder with query log data. It does not work for a geocoder without query logs — you cannot learn that "servo" means gas station if you've never seen an Australian user search for it.

**Nominatim** does not handle regional variants. The search is against OSM tags and names, which use standard English categories. "Servo" returns nothing unless an Australian mapper added `alt_name=servo` to a gas station — which almost none have.

**Pelias** has the same limitation. The search matches text tokens against name fields. Regional variants don't match unless they appear in the data.

## What a variant-aware geocoder needs

1. **An alias table.** A mapping from regional terms to standard categories and brands. This is hand-curated data — about 200-500 entries for major global variants, maintained as a data file. It's the same kind of maintenance burden as a state abbreviation dictionary, just larger.

2. **A locale signal.** The geocoder needs to know where the user is to disambiguate variants. "Chemist" means pharmacy in the UK and Australia but not in the US. The locale gate (Stage 2) provides this signal for Mailwoman — it detects the script and format of the query, which is a proxy for the user's region.

3. **Fuzzy matching.** Some variants are informal and appear nowhere in formal databases. "Mickey D's" for McDonalds, regional colloquialisms for common amenities. Exact alias matching won't catch these. A fuzzy-matching layer that handles common informal variants requires training data — either query logs or hand-curated examples.

## What Mailwoman does today

Mailwoman's locale gate (Stage 2) can detect the query's language/script family. A query in Japanese (kanji/kana) can trigger Japanese-specific alias matching. A query in English with an Australian IP (if available) can trigger Australian variant matching. But the alias table and fuzzy-matching layer do not exist.

Regional variants are in the same category as amenity and franchise queries: **the infrastructure to handle them is planned but not yet built.** The architecture supports them — the kind classifier can route variant queries to a variant-aware resolver — but the data and resolver work remain.

## See also

- [Amenity queries](./amenity-queries.md) — the generic-category version of what variants refer to
- [Franchise and brand queries](./franchise-queries.md) — the brand-name version of what variants refer to
- [Exotic POI overview](./exotic-point-of-interest-queries.md) — the series index
