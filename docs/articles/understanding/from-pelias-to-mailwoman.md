---
sidebar_position: 10
title: From Pelias to Mailwoman
---

# From Pelias to Mailwoman

A short lineage for readers who already know Pelias.

## Pelias in one paragraph

[Pelias](https://github.com/pelias/pelias) is an open-source geocoder. It takes an input string like `"350 5th Ave, New York, NY 10118"` and returns a structured place. Under the hood, Pelias splits this into two jobs:

- **Parsing** — turn the string into labelled parts (`house_number=350`, `street=5th Ave`, `locality=New York`, `region=NY`, `postcode=10118`). For this, Pelias uses [`libpostal`](https://github.com/openvenues/libpostal), a C library trained on OpenStreetMap data.
- **Resolving** — look up the parsed place in a gazetteer (a large place database, often [Who's On First](https://whosonfirst.org/)) and return coordinates plus IDs.

The two-job split is important. If we get a great parser but a weak gazetteer, results are still bad. If we get a great gazetteer but a weak parser, the gazetteer never sees the right query. Both halves have to be strong.

## Where Mailwoman came from

Mailwoman v1 was an effort to **replace `libpostal`** with a TypeScript-native parser. The motivations were practical:

- `libpostal` is a 2 GB binary that's painful to ship in browsers, serverless functions, or edge runtimes.
- `libpostal` ships as a black box: its training data is OpenStreetMap, its model is a CRF (conditional random field — see [`concepts/crf-decoder.md`](../concepts/crf-decoder.md)), but there is no easy way to retrain it on your own data.
- Pelias's TypeScript ecosystem wanted a parser it could iterate on directly.

Mailwoman v1 used **rule classifiers**: hand-written code that looks at each token (word) of the input and decides what kind of address component it is. A rule like "if it starts with 5 digits, it is a US postcode" is one classifier. There are dozens of them, one per component type. They run in parallel, vote, and a solver picks the best combination. See [`how-it-used-to-work.md`](./how-it-used-to-work.md) for the full story.

This worked, but it ran into the same limit every rule-based parser hits: the long tail. Real-world addresses have shapes the rules do not know about. "Saint Petersburg, FL" is two words but one city. "Mt Tabor Park" is a venue, not a street. Rules can describe these cases, but writing them all out is a never-ending project.

## What changed in 2026

Mailwoman v2 — what you are reading docs for — keeps the rule classifiers but adds a **neural classifier** alongside them. Both run; both produce candidate labels; a per-component **policy** decides which one's vote counts more for each address component type. The migration is gradual on purpose: rules stay until the neural classifier's metrics prove it does better.

The neural classifier is a small transformer model (about 9 million parameters — see [`concepts/neural-classification.md`](../concepts/neural-classification.md)) trained on a 677-million-row corpus built from many open data sources. It ships in two pieces:

- `@mailwoman/neural` — the runtime that loads the model and runs inference (works in Node.js and the browser).
- `@mailwoman/neural-weights-en-us` and `@mailwoman/neural-weights-fr-fr` — the model files (one per locale).

The Pelias side of the equation — the gazetteer + resolver — is also evolving. Mailwoman now ships its own resolver against Who's On First as a SQLite database, both server-side and in the browser via WebAssembly. See [`concepts/resolver-and-wof.md`](../concepts/resolver-and-wof.md).

## What stayed the same

- **The two-job split.** Parse, then resolve. Same as Pelias. Same as every modern geocoder.
- **The output shape.** Mailwoman emits parsed components with confidence scores and offsets, the same surface a Pelias consumer would expect.
- **The CLI ergonomics.** `mailwoman parse <input>` is the entry point.
- **Multi-locale design.** Mailwoman ships separate weight packages per locale (en-us, fr-fr) and the architecture is built around the idea that locales are first-class (see [`plan/reference/ARCHITECTURE.md`](../plan/reference/ARCHITECTURE.md)).

## Next

- [How it used to work](./how-it-used-to-work.md) — the rule-only era in detail
- [How it works now](./how-it-works-now.md) — the hybrid
- [What is an address?](./what-is-an-address.md) — the deep dive on the data model
