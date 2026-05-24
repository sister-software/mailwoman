---
sidebar_position: 23
title: Why not use geocode.earth?
---

# Why not use geocode.earth?

If Google's API is the proprietary default, [geocode.earth](https://geocode.earth) is the open-source default. It runs Pelias — the geocoder Mailwoman forked — as a hosted service with global coverage, open data, and transparent pricing. For many applications, geocode.earth is the right answer. For applications that need to own their parser, it has the same fundamental limitation as every hosted API: you do not own the parsing layer.

## What geocode.earth is

Geocode.earth is a hosted geocoding service built on Pelias, the open-source geocoding engine. It uses the same rule-based parser that Mailwoman v1 was built on, combined with Elasticsearch-backed gazetteer lookup against Who's On First, OpenStreetMap, OpenAddresses, and other open data sources.

The key differences from Google:

| Factor       | Google                        | geocode.earth                         |
| ------------ | ----------------------------- | ------------------------------------- |
| Parser       | Proprietary, neural (assumed) | Pelias, rule-based (open-source)      |
| Data sources | Proprietary, global           | WOF, OSM, OpenAddresses — all open    |
| Pricing      | $5/1K requests                | ~$0.50/1K requests                    |
| Terms        | No caching beyond 30 days     | Cacheable, self-hostable              |
| Audit trail  | No                            | Yes — open data sources are traceable |
| Self-hosting | No                            | Yes — Pelias is open-source           |

Geocode.earth's core selling point is that you can inspect the data, run it yourself, or pay them to run it for you. The hosted service is a convenience, not a lock-in.

## The Pelias parser

Geocode.earth uses the same Pelias rule-based parser that Mailwoman v1 was forked from. This parser is:

- **Deterministic.** The same input always produces the same output.
- **Debuggable.** When a classification is wrong, you can read the rule and see why.
- **Battle-tested.** Pelias has been geocoding addresses in production since 2014.

It also has the same limitations that motivated Mailwoman's neural classifier:

- **The tokenization tautology.** Rules classify tokens independently; context-dependent decisions (multi-word place names, venue-vs-address ambiguity) require solver post-processing.
- **The exception pile.** Each new address format adds a new rule; rules accumulate and conflict.
- **International fragility.** Every locale needs its own rule set, hand-written by someone who reads the language.
- **No graceful degradation.** Rules match or don't — binary. There is no confidence gradient between "confident" and "guess."

These are not bugs for geocode.earth's use case — Pelias on hosted infrastructure is fast, reliable, and good enough for most address formats. They are the reason Mailwoman exists as a separate project: building a neural parser that can learn from data rather than encoding every address shape as a rule.

## Why not self-host Pelias?

If the parser is open-source, why not run your own Pelias instance and avoid the API cost?

**Self-hosting Pelias is operationally expensive.** A production Pelias deployment requires:

- Elasticsearch cluster (the gazetteer index — hundreds of GB).
- Multiple data import pipelines (WOF, OSM, OpenAddresses — each requires downloading, transforming, and indexing).
- Ongoing data updates (WOF is updated weekly, OSM continuously).
- Infrastructure management (Elasticsearch tuning, monitoring, failover).

The team at Geocode Earth estimates that running a production Pelias instance costs **$500-2,000 per month** in infrastructure alone, plus engineering time for maintenance and updates. For a company with one or two full-time geospatial engineers, this is viable. For a team without dedicated infrastructure staff, it is not.

Geocode.earth's hosted service abstracts this cost: you pay per request instead of managing infrastructure. For most organizations, this is a better deal than self-hosting.

## The parser is the ceiling

Whether you use geocode.earth's hosted service or self-host Pelias, the parser is the same rule engine. If a specific address class fails — a regional addressing convention, a non-Western format, a venue-vs-address ambiguity — you cannot fix it by paying geocode.earth more or by tuning Elasticsearch. The parser is the bottleneck, and the parser is rules.

Mailwoman exists because the parser ceiling is real and the only fix is a different parser architecture. A neural model that learns from data can handle the long tail of address formats without accumulating rules. The neural parser can coexist with Pelias — the policy registry lets you use the neural model for components where it outperforms rules and keep the rule classifiers for components where they are already correct.

## When geocode.earth is the right choice

Geocode.earth is the right choice when:

- You need geocoding today and cannot invest in building a parser.
- You value open data and auditability over the highest possible accuracy.
- Your address volume is moderate (under 1M requests per month) and the API cost is lower than infrastructure cost.
- You need to self-host eventually but want to start with a hosted service.
- You are already in the Pelias ecosystem and want a managed version.

## When Mailwoman is the right choice

Mailwoman is the right choice when:

- You need to fix specific address failure modes that the Pelias rule engine cannot handle.
- You want a parser that improves over time as you add training data.
- You need browser-side or edge deployment (the ONNX runtime runs in environments where Elasticsearch cannot).
- You are building a new geocoding product and want a parser with an explicit policy registry for component-level migration.
- You want structured candidate output with concordance scoring rather than a single best-guess coordinate.

Mailwoman is not a geocode.earth competitor — it addresses a different layer of the stack. Geocode.earth could run Mailwoman as its parser in the future. The projects are complementary: geocode.earth solves the infrastructure problem, Mailwoman solves the parser problem.

## See also

- [Why not just use Google's API?](./why-not-google-api.md) — the proprietary alternative
- [From Pelias to Mailwoman](./from-pelias-to-mailwoman.md) — the fork history
- [The tokenization tautology](./the-tokenization-tautology.md) — the Pelias parser's structural ceiling
- [How it used to work](./how-it-used-to-work.md) — Mailwoman v1 (pre-fork Pelias) in detail
