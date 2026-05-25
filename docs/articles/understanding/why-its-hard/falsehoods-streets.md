---
sidebar_position: 26
title: Falsehoods about street names
tags:
  - domain
  - falsehoods
  - street
  - international
  - ja-jp
---

# Falsehoods programmers believe about street names

## The falsehoods

Programmers consistently assume streets have type suffixes, don't contain numbers, are unique within a city, and that every address has one. Real streets violate all of these.

### "Street names end in descriptors like 'street', 'avenue', or 'drive'."

`Piccadilly, London, W1J 9PN` has no type suffix. Neither does `Broadway, New York, NY` nor `The Strand, London`. Many of the world's most famous streets lack the suffix pattern that address validators demand.

Pelias's `street` classifier uses a suffix dictionary to identify street tokens: if a token ends in "Street," "Avenue," "Road," "Boulevard," etc., it's likely part of a street name. Without a suffix, the classifier relies on position (token after a house number) and neighboring components. `Piccadilly` alone, without a postcode or locality context, could be a venue, a locality, or a street — Pelias has no way to distinguish.

### "When they do have a descriptor, there's only one."

`17 Hill Street, London, W1J 5LJ` has "Hill" (which can be a street type) and "Street." `Avenue Road, Toronto, Ontario` is an entire street name composed of two street type words. A parser that strips suffixes will reduce `Avenue Road` to nothing.

### "The descriptor is at the end."

French addresses place the descriptor at the beginning: `rue de Rivoli`, `avenue des Champs-Élysées`, `place de la Concorde`. Spanish: `Calle Mayor`. Italian: `Via Roma`. German: `Hauptstraße`. The Anglophone "Street at the end" pattern is the exception, not the rule.

This is a structural problem for rule-based classifiers. A US-trained parser expects `[number] [street name] [street type] [city] [state] [zip]`. A French address is `[number] [street type] [street name] [postcode] [city]`. Every positional assumption is wrong. The parser must either maintain per-locale ordering rules or learn ordering from data.

### "A street name won't include a number."

`8 Seven Gardens Burgh, WOODBRIDGE, IP13 6SU`. `Plein 1944, Nijmegen, Netherlands` — streets can be named after years, and those years look like building numbers. When the parser sees `Plein 1944 85` (street Plein 1944, building 85), it must distinguish the year-in-street-name from the building number — two adjacent numbers with different semantic roles.

### "When a numbered street and a building number are adjacent, there's a separator."

Dutch: `Gondel 2695, Lelystad` — area Gondel, street 26, number 95. No separator. The string "2695" is both a street identifier and a building identifier packed into one token. A rule-based parser sees one number and classifies it as one thing — but it's two.

### "Street names don't recur in the same city."

London has seventeen different High Streets. Without a postcode, `10 High Street, London` is ambiguous across seventeen locations. The resolver needs the postcode or locality to disambiguate, but the parser may have already assigned `locality=London` to all seventeen.

This is the same problem as duplicate locality names (Springfield, Paris) but at a finer grain. The resolver's concordance scoring (Stage 5) handles this by checking whether a `(street, locality, region, postcode)` tuple is jointly coherent in WOF — but WOF does not index street names, only administrative places. Street duplication is outside the resolver's concordance reach.

### "A road has exactly one name."

The A1 in the UK is a 410-mile road composed of Goswell Road, Regent Road, and dozens of other named segments. Multiple buildings numbered 1 exist on different segments. The road's official designation (A1) is not the street name anyone uses.

### "Addresses have exactly one street."

Royal Mail "dependent streets": `6 Elm Avenue, Runcorn Road, Birmingham, B12 8QX`. Runcorn Road is the main street; Elm Avenue is a stub that isn't unique within the city. The address requires both for delivery.

### "Addresses have a street at all."

Japan does not use named streets for most addresses: `東京都千代田区丸の内1-1-1` is district Marunouchi, block 1, building 1 — three levels of block-based numbering, no street name. Rural US routes: `Box 1234, R.R. 1, Winthrop, ME 04364` — a box on a route, no street. Nicaragua: `From where the Chinese restaurant used to be, two blocks down` — landmarks and directions, no street.

Mannheim, Germany uses a grid system: `R 5, 6-13, D-68161 Mannheim` — block R, row 5, buildings 6-13. No street. No street type. Pure coordinates.

## How traditional geocoders handled these

**libpostal** handles suffix-less streets through its CRF's transition model: a token between a house number and a locality is likely a street, even without a suffix. It handles prefix-descriptor streets (European) through locale-specific training — the French model learns `rue` as a street prefix, the US model learns `Street` as a suffix. But libpostal's per-locale models are separate binaries; a single deployment serving multiple locales needs to know which model to invoke.

**Pelias** uses a suffix dictionary with locale-specific entries. `street` classification in Pelias relies on suffix matching plus adjacency to known components. `Piccadilly` without a suffix would be classified as `street` only if it appears between a house number and a locality — a positional heuristic that fails when the address has non-standard ordering.

**Google's API** handles most of these cases well in practice. It correctly parses `rue de Rivoli` and Japanese block addresses. But the parser is proprietary — you cannot inspect how it handles the Dutch `Gondel 2695` case or whether it distinguishes Ten Post Office Sq from 10 Post Office Sq.

## What the neural approach changes

The staged pipeline addresses the falsehoods in layers:

**Locale gate (Stage 2)** detects the language/script family before classification. A French address triggers French ordering expectations (postcode before locality, street type before street name). A Japanese address skips street classification entirely and routes to block-based component tags. The classifier does not need to handle every locale's ordering — it only needs to handle the locale the gate has detected.

**Phrase grouper (Stage 2.7)** proposes spans based on structural cues, not dictionaries. `Gondel 2695` would be proposed as a single span (no whitespace, no punctuation boundary) — the grouper does not need to know that "26" and "95" have different semantic roles. The classifier then types the span, and the Joint Decoder (Stage 5) can split it if needed.

**The classifier (Stage 3)** learns street-name distributions from corpus co-occurrence. A token following a house-number-shaped token and preceding a locality-shaped token is likely a street, regardless of suffix. A token like `Piccadilly` that appears frequently in street contexts will be classified as `street` even without a suffix — not because it matches a dictionary, but because the training data consistently labels it as `street`.

**The reconciler (Stage 5)** catches the "seventeen High Streets in London" problem by checking resolved candidates: if `10 High Street` resolves to seventeen different WOF administrative areas within London, the reconciler cannot pick one without additional context (postcode, borough). It surfaces the ambiguity rather than picking one.

## What Mailwoman still can't do

- **Dependent streets.** The schema has no `dependent_street` tag. `6 Elm Avenue, Runcorn Road` would parse as `street=Runcorn Road` with `Elm Avenue` either dropped or classified as a second street. The resolver cannot use dependent-street relationships because WOF doesn't encode them.
- **Street disambiguation without postcodes.** `10 High Street, London` is structurally ambiguous and the resolver cannot resolve it without a postcode or borough. The parser correctly identifies the components; the resolver correctly identifies the ambiguity. The downstream application must decide.
- **Grid-based addressing.** Mannheim's `R 5, 6-13` requires block-and-row tags that Mailwoman's current schema does not have. Japan's `1-1-1` format is supported through the JP-specific tags (`district`, `block`, `sub_block`, `building_number`) but these are deferred to Phase 6.

## References

- [Series overview: Falsehoods about addresses](./falsehoods-about-addresses.md)
- [Michael Tandy's original catalogue](https://www.mjt.me.uk/posts/falsehoods-programmers-believe-about-addresses/)
- [Falsehoods about numbers in addresses](./falsehoods-numbers.md) — the other half of the street+number pair
- [What is an intersection address?](../the-problem/what-is-an-intersection.md) — the street-based format that doesn't use building numbers
- [The tokenization tautology](./the-tokenization-tautology.md) — why the Dutch `Gondel 2695` pattern breaks per-token classification
