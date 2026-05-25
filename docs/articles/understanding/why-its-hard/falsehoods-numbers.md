---
sidebar_position: 25
title: Falsehoods about numbers in addresses
tags:
  - domain
  - falsehoods
  - street
  - international
---

# Falsehoods programmers believe about numbers in addresses

## The falsehoods

Programmers consistently assume building numbers are all-numeric, positive, unique per street, and contiguous. Real addresses violate every one of these assumptions.

### "Building numbers are all-numeric."

Rule-based geocoders from Pelias to libpostal to Google's early API all had a `house_number` classifier that matched `\d+[A-Za-z]?`. This handles `123A` but not:

- **Ranges.** `4-5 Bonhill Street, London, EC2A 4BX`. Two numbers joined by a hyphen. The classifier splits on the hyphen and tags two tokens as `house_number` — structurally invalid (two house numbers for one street). The solver must merge them, but only if it knows ranges are valid.
- **Fractions.** `43rd ½ St, Pittsburgh, PA`. Written as unicode ½, as `43 1/2`, or as `43.5` depending on the database. A regex for `\d+` won't match `½`. A regex for `\d+\.?\d*` will match `43.5` but not `43 1/2`.
- **Alphanumeric with no digits at all.** Some buildings have letter-only identifiers within a numbered range.

### "No buildings are numbered zero."

`0 Egmont Road, Middlesbrough, TS4 2HT` exists. Pelias and libpostal both reject `0` as a house number — the regex `[1-9]\d*` explicitly excludes zero. Google's API returns the street-level coordinate without flagging that the building number was dropped. A human reading `0 Egmont Road` knows it's a real address. A regex does not.

### "No buildings have negative numbers."

`Minusone Priory Road, Newbury, RG14 7QS` is a real address. No database renders this as `-1` — it's the word "Minusone." The street name is "Minusone Priory Road." A parser that expects building numbers to start addresses will see `Minusone` and try to classify it. A parser that allows word-prefix building numbers will try `Minusone` as a building number. Both are wrong. The number IS the street name.

### "Building numbers are unique per street."

`50 Ammanford Road, Tycroes, Ammanford, SA18 3QJ` and `50 Ammanford Road, Llandybie, Ammanford, SA18 3YF` are 4 miles apart. Same street name, same building number, different towns. Without a locality, the street+number pair is not unique. The resolver must use the postcode or locality to disambiguate — but the parser already committed to a `street=Ammanford Road, house_number=50` classification before the resolver runs.

### "The number of buildings is the difference between highest and lowest."

Buildings can be numbered by distance from the start of the road: `Longroad 65` in Antibes, France or rural Finland means the building 750 meters from the start of Longroad. Numbers can skip (even on one side, odd on the other, gaps for undeveloped lots). Numbers can be reused (new construction on a filled-in lot gets the same number as the demolished building). Multiple buildings can share the same number (a subdivided property).

### "A building has exactly one number."

Hong Kong: `15/F, Cityplaza 3, 14 TaiKoo Wan Road, Island East, HKSAR`. The building is number 14 on the road and number 3 in its group of buildings (Cityplaza). Japanese addresses pack multiple numbers into a single address: `4-10-20` is sub-district 4, block 10, lot 20 — three numbers, none of which is a building number in the Western sense.

### "A building name isn't also a number."

`Ten Post Office Sq, Boston MA 02109` is not the same as `10 Post Office Sq, Boston MA 02109`. One is spelled out, one is a digit. Different buildings. A parser that normalizes "Ten" to "10" will merge two different locations.

### "You can omit leading zeros."

`101 Alma St, Apartment 001, Palo Alto` — apartments 1 and 001 were on different floors. The leading zeros are load-bearing. Stripping them produces a different address.

### "A street with a building A won't also have a building Alpha."

`14100 N 46th St., Alpha 39, Tampa, FL 33613` — a condo association with blocks A through Z then Alpha, Beta, Gamma, Delta, and Theta. Mail was routinely misrouted from block Alpha to block A and vice-versa. The resolver must know that "Alpha" and "A" are different — but the parser already classified both as letters, possibly both as building identifiers in the same position.

## How traditional geocoders handled these

**libpostal** uses a CRF trained on OpenStreetMap address data. Its `house_number` tag covers `\d+[A-Za-z]?` patterns and hyphenated ranges. It does not handle fractions, spelled-out numbers, or negative building numbers. The CRF's transition model can learn that a token following a street name is likely a house number, but the per-token classification cannot learn that `1/2` following `43rd` is a continuation of the house number — the tokenizer splits on `/` and the CRF sees `[43rd] [1] [/] [2]` as four independent tokens.

**Pelias** uses a regex-based `house_number` classifier: `^\d{1,10}[a-zA-Z]?$`. This rejects zero, fractions, negative numbers, and spelled-out numbers. Pelias also has a `street` classifier that handles prefixed and suffixed street types, but no mechanism for disambiguating "Minusone Priory Road" from a building-number-plus-street pattern. The solver's penalty system can override the `house_number` classification on `Minusone` if the surrounding context suggests it's part of the street, but this is a heuristic, not a learned distribution.

**Google's API** handles these cases reasonably well in practice — it returns a geocode for `0 Egmont Road` — but the confidence score drops for these inputs, and the API does not explain how it arrived at the result. The user cannot tell whether Google recognized `0` as a building number or fell back to street-level geocoding.

## What the neural approach changes

A rule-based classifier must enumerate every valid number format. A neural model learns the **distribution of number-shaped tokens in address contexts**. The model sees `0` in contexts like `0 Egmont Road, Middlesbrough` during training and learns that `0` followed by a street-like token is a house number — not because `0` matches a regex, but because the training corpus contains real `0` house numbers in that position.

This does not require the model to memorize every edge case. It requires the model to learn that **numbers in address contexts exhibit more variety than `[1-9]\d*`**. The training corpus must include fractional building numbers, zero, ranges, and leading-zero apartments for the model to learn these patterns. If the corpus is drawn only from US single-family homes, the model will perpetuate the same falsehoods as the regexes.

The phrase grouper (Stage 2.7) helps with ranges and composites: by proposing `4-5` as a single span (based on hyphen-joining heuristics), the classifier receives a clean `house_number=4-5` instead of having to discover the boundary from `[4] [-] [5]`. The grouper does not need to know that `4-5` is a valid building number range — it only needs to know that `4`, `-`, and `5` are likely a single phrase based on punctuation adjacency.

The reconciler (Stage 5) helps with the "Ten Post Office Sq vs 10 Post Office Sq" problem: if the resolver's WOF gazetteer returns different `wof:id` values for "Ten" and "10," the reconciler can use the resolved parent chain to pick the building that matches the rest of the address. But the reconciler cannot fix the parser's initial classification — if the parser tags "Ten" as a building number in the first place, the reconciler can only re-rank among alternatives that include that classification.

## What Mailwoman still can't do

- **Fractions as tokens.** SentencePiece tokenizes `½` as a single unicode token — good. But `43 1/2` becomes `[43] [1] [/] [2]` — the same problem the CRF had. The phrase grouper can propose `43 1/2` as a span, but only if the training data contains enough fraction-format addresses for the grouper's heuristics to learn the pattern.
- **Negative numbers as part of street names.** "Minusone Priory Road" requires the model to learn that "Minusone" followed by "Priory Road" is a street name, not a building number. This is learnable from corpus co-occurrence, but the corpus must contain examples of word-prefix street names (which are rare in US address data).
- **Leading-zero apartments.** The model can learn that `001` is a valid unit identifier if the corpus contains unit-tagged addresses with leading zeros. Without unit-level tagging in the training data, the model sees `001` as a number and may classify it as a house number rather than a unit.

## References

- [Series overview: Falsehoods about addresses](./falsehoods-about-addresses.md)
- [Michael Tandy's original catalogue](https://www.mjt.me.uk/posts/falsehoods-programmers-believe-about-addresses/)
- [Falsehoods about street names](./falsehoods-streets.md) — the street-side of the number/street pair
- [What is an intersection address?](../the-problem/what-is-an-intersection.md) — why not all addresses have building numbers
- [How can a building have two addresses?](../the-problem/how-can-a-building-have-two-addresses.md) — why buildings change numbers
