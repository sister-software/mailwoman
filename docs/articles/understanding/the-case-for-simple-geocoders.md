---
sidebar_position: 30
title: The case for simple geocoders
tags:
  - domain
  - hubris
  - motivation
  - rule-based
  - en-us
---

# The case for simple geocoders

_The best critique of a complex system is a simple one that works. This article makes the strongest case for the alternative to Mailwoman's architecture — a rule-based parser, a gazetteer lookup, and a willingness to be wrong 10% of the time. It is not a straw man. It is the architecture most production geocoders actually use, and for many applications it is the right choice._

## The simple architecture

Three pieces:

1. **A regex for postcodes.** `\d{5}` for the US. `\d{5}` for France. `[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}` for the UK. A few dozen patterns cover the countries you care about. Postcodes are the most structured part of any address — they were designed to be machine-readable. A regex matches them perfectly.

2. **A dictionary for administrative names.** US states and their abbreviations. Country names. Region names for the countries you serve. A few thousand entries, loaded into a hash map. Lookups are O(1), deterministic, and trivially updateable when a new country splits or a state changes its abbreviation.

3. **A gazetteer for the rest.** Who's On First, OpenStreetMap, GeoNames — pick one. Tokenize the input, try each token against the gazetteer with a substring or prefix search, classify the hits by placetype. This is what Pelias's `whos_on_first` classifier does. It works for country, region, locality, and neighbourhood. It doesn't handle streets or venues, but you weren't planning to parse those anyway.

That's it. Three pieces of deterministic code. No training data. No GPU. No ONNX export. No corpus pipeline. No phrase grouper. No reconciler. No joint decoding. No concordance scoring. No verdict smokes.

A competent developer can build this in a week. A competent team can productionize it in a month. It will correctly parse roughly 90% of US addresses and a lower but still useful fraction of international ones.

## The honest math

The economic case for simple geocoders is:

| Cost                     | Simple                                                                       | Neural                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Build time               | 1 week                                                                       | 6-18 months                                                                                |
| Infrastructure           | A hash map and a regex engine                                                | GPU for training, ONNX runtime for inference                                               |
| Maintenance              | Update the gazetteer, add a regex when a country changes its postcode format | Retrain the model, rebuild the corpus, re-validate against golden                          |
| Debuggability            | Read the regex, check the dictionary                                         | Inspect per-token confidence, check phrase-grouper proposals, trace reconciler beam search |
| Accuracy (US structured) | ~92%                                                                         | ~95% (target, not yet reached)                                                             |
| Accuracy (international) | ~70%                                                                         | ~85% (target)                                                                              |
| Graceful degradation     | No — binary match/fail                                                       | Yes — per-token confidence                                                                 |
| Browser deployability    | Trivial (a few KB of JSON)                                                   | ~60MB cold load                                                                            |

If you are building a US-only application where 92% accuracy is acceptable and the remaining 8% can be handled by fallback (a Google API call, a manual review queue, a "please re-enter your address" form), the simple architecture is the right choice. It ships faster, costs less to build, costs less to maintain, and is easier to debug when it breaks.

## The fallback argument

The simple geocoder doesn't need to handle every address. It needs to handle enough addresses that the cost of fallback for the rest is acceptable.

If you geocode 100,000 addresses per month:

- 90,000 parse correctly via rules. Cost: near zero.
- 8,000 parse incorrectly but close enough that the downstream system recovers (wrong ZIP centroid but right city, wrong street suffix but right street name). Cost: small.
- 2,000 fail. Cost: $0.50 each for manual review = $1,000/month.

$1,000/month for manual review is cheaper than building and maintaining a neural parser. The simple architecture is the economically rational choice for moderate address volumes where the tail is small enough to buy your way out of.

This math changes when:

- Your volume is 10M addresses per month (2% failure = 200,000 manual reviews = $100,000/month).
- Your failure rate is higher than 10% because your addresses are international, rural, or non-standard.
- Your fallback cost is higher than $0.50 because your use case requires sub-building accuracy (emergency dispatch, delivery routing).
- You cannot use a fallback API for privacy or regulatory reasons.

At those scales, the neural architecture starts to make economic sense. But at the scales most applications operate at, it doesn't.

## Rules are forever

A regex for US postcodes (`\d{5}`) was correct in 1963 and remains correct today. The format has not changed. A neural model trained in 2024 on 2022 data is wrong on postcodes that were added in 2025 — not because the format changed, but because the gazetteer drifted.

Administrative names change. The county of Gwent, UK no longer exists. South Sudan became a country in 2011. Eircode launched in Ireland in 2015. When a country changes its postcode format or a new country is created, a rules-based system updates by adding one regex or one dictionary entry. A neural system updates by retraining — rebuilding the corpus, re-running training, re-exporting ONNX, re-validating against golden.

The simple architecture's maintenance cost scales with the frequency of administrative changes, which is low. The neural architecture's maintenance cost scales with the frequency of all address-form changes, which is continuous. For a system that needs to be correct about administrative names in 2028, a dictionary that can be updated with a single commit is more maintainable than a model that must be retrained.

## What you lose

The honest case for simple geocoders must also acknowledge what it cannot do:

- **It cannot parse streets or venues.** The dictionary-and-gazetteer approach covers administrative places (country, region, locality). It does not cover street names, building numbers, or venue names — those require a larger model or a separate rule system. If your application needs street-level parsing, the simple architecture is incomplete by design.
- **It cannot handle ambiguity.** `Springfield` without a state returns 34 candidates. The simple geocoder picks one (population-weighted default) or returns an error. It cannot surface the ambiguity to the user. If the default is wrong, the user receives a confident wrong answer with no indication that alternatives exist.
- **It cannot learn context.** `Paris Texas` requires knowing that "Paris" followed by "Texas" is a city in Texas, not the capital of France. The gazetteer has both entries. The simple geocoder picks the one with higher population (Paris, France). The neural model can learn this distinction from training data — not by memorizing every city, but by learning that a city name followed by a US state abbreviation is a US city, regardless of population.
- **It cannot degrade gracefully.** A regex matches or doesn't. A gazetteer lookup finds an entry or doesn't. There is no "I'm 60% sure this is a locality" — there is only "this token matches a WOF locality entry" or "it doesn't." When the input is ambiguous, the simple geocoder has no way to signal its uncertainty. The downstream system receives a confident answer or an error. Nothing in between.
- **It does not scale internationally.** Every new country requires a new postcode regex, new administrative dictionaries, and new gazetteer coverage. The rules are per-locale; the person writing them must read the language. For a US-only application, this is manageable. For a global application, the rule set grows without bound, and the person maintaining it must be a polyglot geocoding expert — a rare and expensive combination.
- **The 10% tail is concentrated.** As argued in [The 90% trap](./the-90-percent-trap.md), the addresses the simple geocoder fails on are not randomly distributed. They cluster in rural areas, multifamily housing, developing economies, and addresses that use non-Anglophone formatting. If your user base includes these populations, the 10% headline number understates your actual failure rate.

These are real limitations. Whether they matter depends on what you're building.

## When to choose simple

The simple architecture is the right choice when:

- You are geocoding US addresses only.
- You need administrative-level accuracy (city, state, postcode), not street-level.
- Your volume is under 1 million addresses per month.
- You can fall back to a paid API for the failures.
- You have a week, not a year.
- You do not need to parse streets, venues, or building numbers.
- You do not need graceful degradation — a confident wrong answer is acceptable if it's rare enough.

These conditions describe most geocoding use cases. The simple architecture is not the wrong choice for most applications. It is the right choice. Mailwoman exists for the applications where it is not.

## When to choose Mailwoman

Mailwoman is the right choice when:

- You need street-level or venue-level parsing.
- You serve international users with non-Anglophone address formats.
- Your volume makes fallback costs material.
- You cannot use a third-party API for privacy, regulatory, or cost reasons.
- You need honest confidence — ambiguous inputs should surface their ambiguity, not produce a confident wrong answer.
- You are willing to invest in infrastructure (corpus pipeline, training, ONNX export) for long-term accuracy gains.

Mailwoman is not a replacement for the simple architecture. It is an alternative for the applications where the simple architecture's limitations are the bottleneck. The two architectures coexist — in fact, Mailwoman's policy registry is designed to let you use rules for the components where rules are correct (postcodes, state abbreviations) and neural for the components where rules fail (streets, venues, international addresses).

## See also

- [Why a neural parser?](./why-a-neural-parser.md) — the affirmative case for the neural approach
- [The 90% trap](./the-90-percent-trap.md) — the economic argument for going past 90%
- [The tokenization tautology](./the-tokenization-tautology.md) — the structural ceiling of rule-based parsers
- [How it used to work](./how-it-used-to-work.md) — the simple architecture, as Mailwoman v1
- [How it works now](./how-it-works-now.md) — the hybrid that keeps the simple parts
