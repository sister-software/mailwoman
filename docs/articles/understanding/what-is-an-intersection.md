---
sidebar_position: 11
title: What is an intersection address?
---

# What is an intersection address?

An intersection address names a location by the crossing of two streets. Unlike a conventional street address ("350 5th Ave"), it does not specify a building number. It says "find where these two streets meet." This is common in urban navigation, emergency dispatch, and some countries (notably Japan) where the street-address system is entirely different.

## Why intersections exist

Intersections predate street numbering. Before municipalities assigned sequential numbers to buildings, people described locations by nearby landmarks and crossroads. "Meet me at the corner of Main and Elm" was a precise location description before "meet me at 123 Main St" existed.

Today, intersections persist for three reasons:

1. **Navigation.** "Broadway and 42nd" is more recognizable to a New Yorker than "1501 Broadway" — even though they describe the same block.
2. **Emergency dispatch.** 911 operators use intersections as fallback locations when the caller does not know the exact address. "I'm at the corner of 5th and Main" is a valid location for a dispatcher.
3. **Countries without street numbers.** Japan, Korea, and some other East Asian addressing systems do not use building numbers along named streets. Japanese addresses use block-based numbering (chōme/banchi/gō). Intersection-based routing is the closest analogue to "cross streets" navigation.

## The two forms

### Explicit intersection

```
5th Ave & 42nd St, New York, NY
Broadway and 42nd Street
Main St at Elm St
```

The address names both streets explicitly, joined by `&`, `and`, `at`, or (in some formats) `+`. The parser's job is to recognize the conjunction, split the street tokens into two groups, and tag them as `intersection_a` and `intersection_b`.

### Implicit intersection (cross streets)

```
350 5th Ave (between 41st and 42nd)
12 Rue de Rivoli (cross street: Rue du Louvre)
```

The address gives the primary street and building number, then adds cross-street information as context. The parser must distinguish the primary street from the cross streets and not confuse the cross-street house numbers with the primary address.

## What makes intersections hard to parse

### The conjunction problem

```
Main St & Elm St
```

The tokenizer splits on `&`, producing `[Main] [St] [&] [Elm] [St]`. The classifier sees two `St` tokens — both are street suffixes. The parser must:

1. Recognize that `&` is an intersection conjunction, not a spacing artifact.
2. Group `[Main] [St]` as one street name and `[Elm] [St]` as another.
3. Assign `intersection_a` to the first and `intersection_b` to the second.

If the parser treats `&` as a delimiter and classifies both street phrases independently, it produces duplicate `street` components — structurally invalid (two streets in one address) unless the schema supports intersections.

### The "Street as venue" confusion

```
New York & Company, 5th Ave, New York, NY
```

"New York & Company" is a clothing retailer — not an intersection. The parser must distinguish `New York & Company` (venue with an ampersand) from `5th Ave & 42nd St` (intersection with an ampersand). Position and context are the only signals: a venue name before a comma-separated address vs an intersection embedded in the street portion.

### The "double street name" ambiguity

```
Martin Luther King Jr Blvd & Malcolm X Blvd
```

Both street names are multi-word. The parser must find the boundary between them — is the split at `Jr Blvd &`? At `Blvd &`? The phrase grouper (Stage 2.7) is essential here: it proposes span boundaries based on structural cues (capitalization, punctuation, suffix patterns), giving the classifier clean spans to type rather than forcing it to discover boundaries from tokens.

### The Japanese problem

Japanese addresses do not use named streets with building numbers. An intersection in Tokyo might be described as:

```
渋谷駅前交差点 (Shibuya Station Front Intersection)
六本木交差点 (Roppongi Intersection)
```

These are named intersections, not street pairs. A parser expecting `StreetA & StreetB` format will fail on Japanese intersection references. The JP-specific tags in Mailwoman's schema (`district`, `block`, `sub_block`) are designed to handle block-based addressing, but named intersections (交差点, kōsaten) are a separate concept that would need schema expansion.

## How Mailwoman handles intersections

Mailwoman's schema includes two dedicated tags:

| Tag              | Meaning                                |
| ---------------- | -------------------------------------- |
| `intersection_a` | First street of an intersection query  |
| `intersection_b` | Second street of an intersection query |

In the staged pipeline:

1. **QueryShape** (Stage 2.5) detects intersection-shaped queries — the presence of `&`, `and`, `at` between street-like tokens — and flags the input as `kind=intersection`.
2. **Phrase grouper** (Stage 2.7) proposes spans on either side of the conjunction.
3. **Classifier** (Stage 3) types each span. The `intersection_a` / `intersection_b` tags tell the downstream resolver "this is not a conventional street address — look up the intersection coordinates."
4. **Resolver** (Stage 6) treats intersection queries differently: instead of resolving a building number on a street, it finds the geographic intersection of two street centerlines.

The intersection tags are part of the schema but the resolver path for intersection queries is deferred until the parser's core components are stable.

## What intersections tell us about address structure

Intersection addresses expose a deeper truth about addresses: **the "housenumber + street" format is one convention among many.** A parser that assumes every address has a building number will fail on intersection queries. A parser that treats `intersection_a` and `intersection_b` as first-class components can handle both conventional and intersection addresses without architectural change.

This is the same principle behind the Japanese street-free addressing system (Phase 6 of the implementation plan): the schema must accommodate address formats that do not fit the Anglophone "number + street + city" template. Intersections are the mildest version of this. Block-based addressing (Japan) and informal addressing (rural areas, developing economies) are the harder versions. The architecture that handles intersections gracefully is the architecture that can scale to those cases.

## See also

- [How mail delivery actually works](./how-mail-delivery-works.md) — the delivery system that handles intersections
- [The knowledge ladder](./the-knowledge-ladder.md) — where QueryShape and kind classification fit in the pipeline
- [Implementation plan — Phase 6 Japan](../plan/phases/PHASE_6_japan.md) — the architecture stress test for non-street-based addressing
