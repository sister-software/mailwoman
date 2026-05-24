---
sidebar_position: 3
title: How humans break addresses
tags:
  - domain
  - motivation
  - street
  - locality
  - postcode
  - region
  - country
  - international
  - multilingual
  - non-latin
---

# How humans break addresses

Users do not type addresses the way gazetteers store them. They type what they know, in the order they think of it, with the spellings their keyboard supports, trusting autocomplete suggestions they didn't verify. A parser that only handles well-formed addresses fails on real input.

This article catalogs the failure modes by root cause, not by symptom. The point is not that humans are careless — it is that **none of these are user errors**. They are system-design failures. The human provided enough information for a knowledgeable local to find the right place. The parser couldn't because it was designed for addresses, not for people.

## I. They use the wrong name for places

### Neighborhood as city

| What they type   | What the gazetteer expects   |
| ---------------- | ---------------------------- |
| `Brooklyn, NY`   | New York City                |
| `Hollywood, CA`  | Los Angeles                  |
| `SoHo, NY`       | New York City                |
| `Shibuya, Japan` | Tokyo (with Shibuya as ward) |

USPS accepts borough names as "preferred last line" cities for many New York City ZIP codes. Brooklyn, Queens, Bronx, and Staten Island are all valid mailing cities. But administratively, Brooklyn is a borough of New York City, not an independent municipality. Some systems normalize `Brooklyn, NY → New York, NY`. Others preserve the postal locality exactly. Both choices are valid. Neither is universally correct. The parser has to handle the ambiguity, not resolve it.

### Independent city assumed part of larger metro

| What they type               | What they mean                                     |
| ---------------------------- | -------------------------------------------------- |
| `Cambridge → Boston`         | Cambridge is a separate city in a different county |
| `Santa Monica → Los Angeles` | Santa Monica is an independent city                |
| `Jersey City → New York`     | Different state, different city                    |
| `Oakland → San Francisco`    | Separated by a bay and a century of rivalry        |

The human typed what they think of as "the metro area." The gazetteer disagrees. A well-trained parser will place Cambridge in Middlesex County, MA. A human would say "close enough — it's right across the river." Which answer is correct depends on whether the use case is delivery routing or statistical aggregation. The parser cannot know the use case from the input alone.

### Colloquial vs. official names

| Colloquial | Official         |
| ---------- | ---------------- |
| Saigon     | Ho Chi Minh City |
| Bombay     | Mumbai           |
| Peking     | Beijing          |
| Kiev       | Kyiv             |

These are not errors — they are valid names used by millions of people. The speaker's choice of name often carries political or generational information. A parser that rejects `Bombay` is rejecting real usage. A parser that silently converts `Bombay → Mumbai` is making a political choice the user didn't ask for. The correct behavior is to recognize both and surface the ambiguity.

### Postal city ≠ municipal city

USPS uses delivery names that often differ from municipal boundaries:

| USPS mailing city     | Actual municipality |
| --------------------- | ------------------- |
| Los Angeles, CA 90210 | Beverly Hills       |
| Los Angeles, CA 90069 | West Hollywood      |
| Miami, FL 33122       | Doral               |
| Miami, FL 33134       | Coral Gables        |

USPS assigns mailing city names for carrier-route efficiency, not for geographic correctness. The same physical building can have a mailing address in "Los Angeles" and a legal address in "Beverly Hills." Both are real. Neither is wrong. The parser's job is to recognize the distinction, not to pick one.

## II. They put things in the wrong order

### Postcode before locality

```
75008 Paris               ← French format (postcode first)
Paris 75008               ← Anglophone format (locality first)
```

Both describe the same place. A parser trained exclusively on US-formatted addresses (number → street → city → state → postcode) will mislabel the postcode as a house number and fail on the locality entirely. The ordering assumption is a training-data bias, not a structural requirement of addresses.

### Building number after street (non-Anglophone)

```
République 12              ← French/European format
12 Rue de la République    ← Anglophone reordered
```

Many European addressing systems place the building number after the street name. German, Dutch, and Scandinavian addresses do the same. A parser that expects number-first will split `République` from `12` and tag them independently, missing the phrase boundary.

### Administrative before local

```
Île-de-France Paris        ← Administrative hierarchy, descending
Paris, Île-de-France        ← Local-to-administrative, ascending
```

Aggregators and government databases sometimes emit administrative hierarchy in decreasing granularity (region → locality). A parser expecting local-to-administrative order will see a region token where it expected a locality and fail the classification.

## III. They spell things wrong

### Transposition

| Intended   | Typed     |
| ---------- | --------- |
| Potsdam    | Postdam   |
| Boulevard  | Boulvard  |
| Pittsburgh | Pittsburg |

Adjacent-character swaps are the most common typing error for English-language addresses. They are especially damaging for gazetteer lookups because the misspelling produces no match, not a near match — the string differs by edit distance 1 but shares no substring index entry.

### Phonetic substitution

| Intended  | Typed     |
| --------- | --------- |
| Fillmore  | Philmore  |
| Camarillo | Camarillo |
| Peachtree | Peachtree |

The human sounds out the word and types what they hear. These errors are especially common for place names in languages the speaker does not speak: a non-French speaker typing `Versailles` from memory might produce `Versai`, `Versaille`, or `Versales`.

### Missing diacritics

| Intended  | Typed     |
| --------- | --------- |
| Montréal  | Montreal  |
| Zürich    | Zurich    |
| São Paulo | Sao Paulo |

The human's keyboard does not have the character. Or the form field stripped it. Or the database that stored it normalized to ASCII. The parser must handle both forms. A system that treats `Montreal` and `Montréal` as different cities is wrong even when both rows exist in different source databases.

### Script confusion

```
Москва, ул. Тверская 12              ← Entirely in Cyrillic
Moscow, 12 Tverskaya St               ← Transliterated
Moscow, ул. Тверская 12               ← Mixed — English city, Cyrillic street
```

The mixed-script case is the hardest: the human typed the city in the script they know (English) and the street in the script they received (Cyrillic, copied from a local source). A tokenizer that treats non-Latin scripts as opaque byte sequences will produce garbage for the street while correctly recognizing the city. The parser fails silently on half the address.

## IV. They make structural assumptions the parser doesn't share

### Administrative hierarchy confusion

| What they type | What they mean       | What the parser thinks                          |
| -------------- | -------------------- | ----------------------------------------------- |
| `Washington`   | Washington, DC       | Washington state? George Washington University? |
| `Paris`        | Paris, France        | Paris, Texas? Paris, Ontario?                   |
| `Quebec`       | Province of Quebec   | Quebec City?                                    |
| `Mexico`       | Mexico (the country) | Mexico City?                                    |

The human assumes context the parser doesn't have. The human means "the Washington everyone knows" — the capital, not the state, not the university. The parser has to guess from statistical priors. The correct answer is "it depends on what the rest of the address says, and sometimes you need to ask."

### Crossing metro areas / border cities

| Address                                           | Problem                                           |
| ------------------------------------------------- | ------------------------------------------------- |
| Kansas City, KS vs Kansas City, MO                | Same name, different states, separated by a river |
| Basel addresses near France/Germany border        | Same city, three countries' postal systems        |
| "Washington metro" addresses in Virginia/Maryland | Metro area crosses state lines                    |

The human knows which Kansas City they meant. The parser sees a name that resolves to two different places with equal name-matching confidence. A population-weighted tiebreak picks Kansas City, MO (larger). That's wrong if the user meant Kansas City, KS. The correct behavior is to say "there are two" and let the downstream system resolve.

### Duplicate street names across municipalities

```
123 Main St, Springfield
```

Springfield exists in 34 US states. Main Street exists in most of them. Without a state, the parser has no way to know which Springfield the human meant. With a state but no ZIP, the parser can narrow to one state but still has street deduplication across towns within the state.

### Missing unit or apartment

```
123 Main St       ← typed
123 Main St, Apt 4B   ← actual delivery point
```

The building at 123 Main Street contains 20 apartments. The human omitted the unit number. A geocoder that resolves to the building rooftop will place the result at the building entrance — correct for the building, wrong for the apartment. A delivery driver needs the unit number. A statistical analysis might not. The parser cannot know which.

## V. They trust systems that lie to them

### ZIP code centroid as exact address

A ZIP code is a delivery route, not a point. But many mapping services return a centroid when given only a ZIP code — and label it "the address." The human copies the coordinates. The parser now has what looks like a high-confidence geocode that is actually a ZIP-level approximation, off by up to several miles.

This is an input-quality problem, not a parser problem, but the parser is the first system that can detect it: if the input is `90210` and nothing else, the parser should return `postcode=90210` at high confidence and `locality` at low confidence — not `locality=Beverly Hills` at high confidence inferred from the postcode.

### Autocomplete contamination

The human typed `Spring` and clicked the first suggestion. It was `Springfield, IL 62701`. They meant `Springfield, MA 01103`. The autocomplete system returned the most-popular Springfield (IL has higher query volume). The human trusted it without verifying. The parser receives `Springfield, IL 62701` — a fully-specified address — and has no signal that it's wrong.

This failure class is outside the parser's reach. It lives in the UI layer: autocomplete should show "did you mean Springfield, MA?" when the user's location context suggests a different Springfield. The parser's contribution is making those alternatives available.

## What this means for a parser

The failure taxonomy converges on one principle: **the parser should be honest about ambiguity.** Every failure above is a case where the human provided enough information for a knowledgeable local to find the right place, but the parser returned a single confident answer that was wrong.

The correct design response is not to make the parser smarter. It is to make the parser more honest:

- Return candidates, not a single answer.
- Surface ambiguity when multiple equally-valid interpretations exist.
- Distinguish "I'm confident this is a locality" from "I'm confident this locality resolves to this WOF ID."
- Let the downstream system decide how much ambiguity it can tolerate.

The postal system already works this way. The Remote Encoding Center operator sees an ambiguous address and keys in their best guess. The carrier sees the guess and corrects it with local knowledge. The parser is the first link in that chain — its job is to give the next link enough information to decide.

## See also

- [How mail delivery actually works](./how-mail-delivery-works.md) — the system these addresses enter
- [Addresses that break geocoders](./addresses-that-break-geocoders.md) — concrete failure examples from the geocoding literature
- [The database fallacy](./the-database-fallacy.md) — why there is no perfect reference set that fixes these problems
- [Falsehoods about addresses](./falsehoods-about-addresses.md) — the falsehoods catalogue, organized by category
