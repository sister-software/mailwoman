---
sidebar_position: 24
title: Falsehoods about addresses
---

# Falsehoods programmers believe about addresses

This article series is inspired by and cites Michael Tandy's [excellent, exhaustive original](https://www.mjt.me.uk/posts/falsehoods-programmers-believe-about-addresses/) — the canonical catalogue of address falsehoods, maintained since 2013. Tandy's article is a taxonomy of assumptions that break parsers, validators, and databases. This series expands on that taxonomy, adding historical context on how geocoders have handled (or failed to handle) each category, and what Mailwoman's neural approach changes.

## Why this matters for Mailwoman

Tandy's falsehoods are not edge cases. They are the central cases that rule-based geocoders fail on. Each falsehood is a place where a human can see what's happening ("that's a building number, even though it's a fraction") but a regex cannot. The thesis of Mailwoman's neural approach is that a model trained on diverse address data can learn to handle these cases without explicit rules — and more importantly, can handle combinations of falsehoods that no rule set could enumerate.

Mailwoman is not the first project to notice this. Deepparse (2020) showed that a BiLSTM could match libpostal on structured addresses. The academic literature since has confirmed that transformers beat CRFs on noisy and multilingual address data. What Mailwoman adds is a **staged pipeline** that separates concerns: a phrase grouper proposes boundaries, a neural classifier types spans, a CRF enforces sequence validity, and a reconciler checks joint coherence against a gazetteer. Each stage handles a different class of falsehood without the others needing to know about it.

## The categories

Each article in this series takes one category of falsehood, explains what traditional geocoders assumed, what counterexamples broke those assumptions, and how Mailwoman's architecture addresses the class of problem rather than the individual counterexample.

| Category  | Article                                                                | What it covers                                                                        |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Numbers   | [Falsehoods about numbers in addresses](./falsehoods-numbers.md)       | Zero, negative, fractions, duplicates, ranges, names that are numbers                 |
| Streets   | [Falsehoods about street names](./falsehoods-streets.md)               | Missing suffixes, numbered streets, recurring names, addresses with no streets at all |
| Postcodes | [Falsehoods about postcodes](./falsehoods-postcodes.md)                | Leading zeros, multi-city postcodes, per-building postcodes, missing postcodes        |
| Hierarchy | [Falsehoods about administrative hierarchy](./falsehoods-hierarchy.md) | No states, no counties, duplicate city names, city-states                             |
| Format    | [Falsehoods about address format](./falsehoods-format.md)              | Punctuation, non-ASCII, variable ordering, mixed character sets, changing addresses   |

## The original

If you haven't read Michael Tandy's original article, start there: [Falsehoods programmers believe about addresses](https://www.mjt.me.uk/posts/falsehoods-programmers-believe-about-addresses/). It is the reference this series builds on. Every falsehood in these articles originates in Tandy's catalogue or in the operator's own production-geocoder experience. Attribution is in each article's introduction.

## See also

- [How mail delivery actually works](./how-mail-delivery-works.md) — the system these falsehoods enter
- [How humans break addresses](./how-humans-break-addresses.md) — the failure taxonomy organized by root cause
- [The tokenization tautology](./the-tokenization-tautology.md) — why rule-based parsers can't handle combinations of falsehoods
