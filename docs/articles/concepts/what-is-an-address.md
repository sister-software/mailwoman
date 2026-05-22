---
sidebar_position: 2
title: What is an address?
---

# What is an address?

Addresses look obvious. You see one every day. But parsing them turns out to be one of the harder problems in natural language processing, because a single string can mean many places, and a single place can be written many ways.

This article defines what Mailwoman means by "address" and what data shape comes out of the parser.

## The data model

Mailwoman models an address as a **bag of typed components**. Each component is a `(tag, value)` pair where the tag comes from a fixed vocabulary:

| tag                                | example value                                | always present?   |
| ---------------------------------- | -------------------------------------------- | ----------------- |
| `country`                          | `"United States"`, `"USA"`, `"FR"`           | no                |
| `region`                           | `"NY"`, `"Île-de-France"`                    | no                |
| `subregion`                        | `"Brooklyn"`, `"Manhattan"`                  | no                |
| `locality`                         | `"New York"`, `"Paris"`                      | usually           |
| `dependent_locality`               | `"Greenpoint"` (neighbourhood)               | no                |
| `postcode`                         | `"10118"`, `"75008"`                         | no                |
| `cedex`                            | `"CEDEX 08"` (FR-specific)                   | no                |
| `street`                           | `"5th Ave"`, `"Rue Lafayette"`               | when street-level |
| `house_number`                     | `"350"`, `"10 bis"`                          | when street-level |
| `venue`                            | `"Wrigley Field"`, `"Empire State Building"` | sometimes         |
| `unit`                             | `"Apt 4B"`, `"Suite 200"`                    | sometimes         |
| `po_box`                           | `"PO Box 1234"`                              | sometimes         |
| `intersection_a`, `intersection_b` | `"5th Ave"`, `"42nd St"`                     | for intersections |
| `attention`                        | `"c/o Jane Smith"`                           | for postal mail   |

The full canonical vocabulary lives in `core/types/component.ts`. Adding a tag requires a written rationale because everything downstream is keyed off this list.

A parsed result is therefore not a tree — it is a **flat dictionary** with optional repeated tags (rare; usually each tag appears at most once). The exact shape:

```ts
interface ParsedAddress {
	raw: string // the original input
	components: {
		[tag: ComponentTag]: string // the surface text from raw, not normalized
	}
	confidence: number // overall confidence, 0..1
	source: "rule" | "neural" | "merged"
}
```

## Why this is hard

A few properties of real-world addresses make parsing harder than it looks:

**1. Components are optional and order varies.**

```
350 5th Ave, New York, NY 10118
Pier 39, San Francisco, CA 94133
90210
"Wrigley Field, 1060 W Addison St, Chicago, IL 60613"
4 Rue Lafayette, 75008 Paris
```

All five are valid addresses. The first has six components, the third has one, the fifth puts the postcode before the locality. A parser that demands a fixed structure misses most of the real input distribution.

**2. The same string can be multiple components.**

```
Buffalo, NY
Buffalo Wild Wings, Buffalo, NY 14201
Buffalo Buffalo (the famous Cornell sentence)
```

"Buffalo" can be a locality (Buffalo, NY), a venue (Buffalo Wild Wings has it in the name), an animal name, or even a verb. Context decides which. A rule that hardcodes "Buffalo = locality" is wrong in two of the three cases.

**3. Multi-word components are common.**

```
Saint Petersburg, FL
North Hollywood, CA
San Francisco, CA
New York, NY
```

A parser that labels one token at a time has to decide that "Saint" and "Petersburg" go together. The first version of Mailwoman's neural classifier (v0.2.0) got "Saint Petersburg" wrong because the second token's label was independent of the first — see [BIO labels](./bio-labels.md) for the fix.

**4. Spelling, capitalization, and punctuation vary.**

```
1600 Pennsylvania Ave NW, Washington, DC 20500
1600 Pennsylvania Avenue Northwest, Washington, District of Columbia 20500
1600 pennsylvania ave nw washington dc 20500
1600 PENNSYLVANIA AVENUE NW, WASHINGTON DC 20500
```

Four ways to write the same address. The parser has to handle all of them, and the resolver has to map all four to the same Who's On First place ID.

**5. Different locales have different rules.**

US addresses put the postcode after the region. French addresses put it before the locality. Japanese addresses are essentially the reverse of European ones — country first, then prefecture, then municipality, then a building number. Mailwoman's model is per-locale (separate weights for en-US and fr-FR; Japan is a planned future locale) precisely because there is no universal address grammar.

## The adversarial cases

The Mailwoman team keeps a [hand-labelled adversarial corpus](https://github.com/sister-software/mailwoman/blob/main/data/eval/golden/v0.1.2/adversarial.jsonl) of 54 entries that target known failure modes. A few examples:

| category           | example                                        | the trap                                     |
| ------------------ | ---------------------------------------------- | -------------------------------------------- |
| place-name-venue   | `Buffalo Wild Wings, Buffalo, NY`              | "Buffalo" appears twice with different roles |
| place-shaped-venue | `Empire State Building, 350 5th Ave`           | the venue name has place-like words          |
| disambiguation     | `Portland, ME or Portland, OR?`                | multi-state city names                       |
| typo               | `Pennsylvana Ave`                              | misspelled street                            |
| no-commas          | `1600 pennsylvania ave nw washington dc 20500` | no separators                                |
| label-prefix       | `Address: 350 5th Ave`                         | leading metadata                             |
| trailing-junk      | `350 5th Ave, NY (across from Macy's)`         | trailing parenthetical                       |

The neural classifier is trained against these cases (synthesized variations end up in the training corpus too), and each iteration's eval reports them separately so we can see if a regression specifically broke an adversarial category.

## Where this lives in the code

- `core/types/component.ts` — the canonical `ComponentTag` union
- `data/eval/golden/v0.1.2/` — the golden evaluation set, by file: `us.jsonl`, `fr.jsonl`, `adversarial.jsonl`
- `corpus/src/types.ts` — the `CanonicalRow` shape that adapters produce

## See also

- [Tokenization](./tokenization.md) — how strings become tokens before parsing
- [BIO labels](./bio-labels.md) — how the neural classifier marks component boundaries
- [Resolver and Who's On First](./resolver-and-wof.md) — turning parsed components into coordinates
