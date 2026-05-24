---
sidebar_position: 1
title: Start here
---

# Understanding Mailwoman

This track is for readers who want to understand **why** Mailwoman exists, **what problem** it solves, **what it parses**, and **how** it works — in that order. The articles build on each other, but each is self-contained enough to be read independently.

## The four layers

### Tier 0 — The problem (articles 2–7)

These six articles establish the domain. If you are sceptical that address parsing needs a neural model, start here.

1. **[How mail delivery actually works](./how-mail-delivery-works.md)** — the postal system is already fuzzy. It tolerates ambiguity through human intervention.
2. **[How humans break addresses](./how-humans-break-addresses.md)** — the failure taxonomy. Real input is messier than any database expects.
3. **[The database fallacy](./the-database-fallacy.md)** — why "just store all addresses" is economically infeasible and geometrically wrong.
4. **[The tokenization tautology](./the-tokenization-tautology.md)** — why traditional rule-based parsers hit a structural ceiling.
5. **[The 90% trap](./the-90-percent-trap.md)** — why 90% geocoder coverage is deceptively expensive.
6. **[Why a neural parser?](./why-a-neural-parser.md)** — the bitter-lesson argument applied to address parsing. Bridges Tier 0 → Tier 1.

### Tier 0.5 — Postal address concepts (articles 8–12)

These five articles explain the fundamental concepts of postal addressing — the things a parser actually parses and a resolver actually resolves. New as of May 2026.

7. **[What is a postcode?](./what-is-a-postcode.md)** — postcodes are routing instructions, not geographic areas. International comparison.
8. **[What is a ZIP Code and how is it structured?](./what-is-a-zip-code.md)** — the US 11-digit system in detail. Why US-trained parsers fail on non-US postcodes.
9. **[What is a concordance?](./what-is-a-concordance.md)** — how the resolver validates that parsed components form a coherent real-world place.
10. **[What is an intersection address?](./what-is-an-intersection.md)** — crossing streets as locations. Why not all addresses have building numbers.
11. **[How can a building have two addresses?](./how-can-a-building-have-two-addresses.md)** — mailing vs 911 vs utility vs management. An address is a protocol, not a property.

### Tier 1 — The architecture (articles 13–20)

These describe Mailwoman's design. Most existed before May 2026 and have been reordered to follow the domain articles.

12. **[What is an address?](./what-is-an-address.md)** — the data model, moved from concepts.
13. **[Addresses that break geocoders](./addresses-that-break-geocoders.md)** — concrete failure examples, moved from concepts.
14. **[From Pelias to Mailwoman](./from-pelias-to-mailwoman.md)** — the short historical bridge.
15. **[How it used to work](./how-it-used-to-work.md)** — Mailwoman v1 (rule-based) in detail.
16. **[How it works now](./how-it-works-now.md)** — the current rule + neural hybrid.
17. **[How it will work](./how-it-will-work.md)** — the near-future roadmap.
18. **[The knowledge ladder](./the-knowledge-ladder.md)** — the decomposition principle behind the staged pipeline.
19. **[The staged pipeline](./the-staged-pipeline.md)** — the Mailwoman runtime end-to-end.

### Reference

20. **[Glossary](./glossary.md)** — every technical term defined on first use.

### Appendix

21. **[Why not just use Google's API?](./why-not-google-api.md)** — pricing, terms, lock-in, and when renting is the right choice.
22. **[Why not use geocode.earth?](./why-not-geocode-earth.md)** — the open-source hosted alternative and its Pelias parser ceiling.

### The case for simple geocoders

_Steel-manning the reasonably defensible compromises that work for most applications._

23. **[Overview](./the-case-for-simple-geocoders.md)** — when simple is the right choice, and when it isn't.
24. **[Normalize to match](./simple-normalize-to-match.md)** — strip, lowercase, fuzzy-match against a known database.
25. **[Postcode-only](./simple-postcode-only.md)** — extract the postcode, centroid the result.
26. **[Gazetteer-first](./simple-gazetteer-first.md)** — skip parsing, treat as information retrieval.
27. **[Regex-anchored fields](./simple-regex-fields.md)** — extract the 3-4 fields you care about, ignore the rest.
28. **[Locality-only](./simple-locality-only.md)** — find the city, centroid it.
29. **[Human-in-the-loop](./simple-human-in-the-loop.md)** — don't parse, suggest, let the user confirm.
30. **[The case for simple geocoders](./the-case-for-simple-geocoders.md)** — the strongest argument for the alternative: a regex, a dictionary, a gazetteer, and a willingness to be wrong 10% of the time.

### Falsehoods about addresses

_Inspired by and citing Michael Tandy's [original catalogue](https://www.mjt.me.uk/posts/falsehoods-programmers-believe-about-addresses/). Each article takes one category of falsehood, explains how traditional geocoders handled it, and what Mailwoman's neural approach changes._

23. **[Overview](./falsehoods-about-addresses.md)** — the taxonomy and why it matters for Mailwoman.
24. **[Numbers in addresses](./falsehoods-numbers.md)** — zero, negative, fractions, duplicates, ranges.
25. **[Street names](./falsehoods-streets.md)** — missing suffixes, numbered streets, recurring names, no streets at all.
26. **[Postcodes](./falsehoods-postcodes.md)** — leading zeros, multi-city, per-building, missing postcodes.
27. **[Administrative hierarchy](./falsehoods-hierarchy.md)** — no states, no counties, duplicate cities, city-states.
28. **[Address format](./falsehoods-format.md)** — non-ASCII, variable ordering, special characters, changing addresses.

## Reading order

If you are **sceptical about the whole project**, read Tier 0 in order (articles 2–6). It should take about 45 minutes. If you are still sceptical after that, the project has failed to make its case — open an issue.

If you are **new to geocoding but curious**, start with [What is an address?](./what-is-an-address.md) (article 13), then read Tier 0. The data-model article grounds the domain arguments.

If you are **from the Pelias world**, read [From Pelias to Mailwoman](./from-pelias-to-mailwoman.md) (article 14), then [How it works now](./how-it-works-now.md) (article 16). Those two articles bridge your existing knowledge to the current system.

If you want to **go deeper**, see the [`concepts/`](../concepts/README.md) track — per-topic deep dives into tokenization, BIO labels, the CRF decoder, ONNX runtime, training pipeline, corpus construction, and more.

## A note on language

The team behind Mailwoman speaks many languages, and English is a second language for many readers. Our goal in these docs is **plain English with technical terms defined on first use**. If a sentence is hard to follow, that is a documentation bug — please open an issue.

## Where this lives in the repo

```
docs/
├── articles/
│   ├── understanding/     ← you are here
│   ├── concepts/          ← per-concept deep dives
│   ├── plan/              ← operator + agent technical plan
│   └── evals/             ← per-version evaluation reports
└── src/pages/demo/        ← the live browser-side demo
```
