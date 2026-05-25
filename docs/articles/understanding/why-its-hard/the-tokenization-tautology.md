---
sidebar_position: 5
title: The tokenization tautology
tags:
  - domain
  - motivation
  - architecture
  - staged-pipeline
  - rule-based
  - neural
  - street
  - venue
---

# The tokenization tautology

Traditional address parsers split the input into tokens, classify each token independently, then try to reassemble the pieces into a coherent parse. This sequence contains a structural circularity: **you cannot group tokens correctly without knowing their types, and you cannot type them correctly without knowing their groups.** The traditional architecture resolves this with heuristics, exceptions, and solver post-processing. The exception pile grows without bound.

This article explains why the circularity exists, how traditional parsers work around it, and why Mailwoman's staged pipeline inverts the approach.

## How traditional parsers tokenize

The standard pipeline (Pelias, libpostal, Mailwoman v1):

```
Input string
    ↓
Tokenize (split on whitespace and punctuation)
    ↓
Classify each token independently (dictionary lookup, regex, pattern match)
    ↓
Reconcile overlapping and conflicting classifications (Cartesian solver)
    ↓
Output: ranked parse solutions
```

The problem is that **Step 2 runs before Step 3 can feed back into it.** The classifier sees independent tokens. It does not see boundaries.

## Act 1 — Split first, ask questions later

Consider `Saint Petersburg, FL`. The tokenizer produces:

```
[Saint] [Petersburg] [,] [FL]
```

The classifier now sees each token independently. "Saint" matches the `street_prefix` dictionary with high confidence — it IS a common street prefix. "Petersburg" matches the WOF locality gazetteer — over 30 populated places are named Petersburg. "FL" matches the US state abbreviation list.

Each individual classification is **correct in isolation**. The error is in the combination: "Saint Petersburg" is one locality, not a street prefix followed by a city name. But the classifier cannot know this because it classifies tokens before grouping them.

The solver receives:

```
{street_prefix: "Saint", confidence: 0.9}
{locality: "Petersburg", confidence: 0.8}
{region: "FL", confidence: 1.0}
```

The solver tries to build a valid address from these pieces. It can produce:

- `street_prefix=Saint, locality=Petersburg, region=FL` (wrong — "Saint" is not a directional)
- `locality=Saint Petersburg, region=FL` (correct — but requires merging two tokens the classifier already labeled differently)

Option 2 requires the solver to **override the classifier's decisions** — to say "you labeled 'Saint' as `street_prefix`, but I'm going to treat it as part of `locality`." This is what the solver actually does, via a penalty system that allows spans to be reassigned. But the penalty system was tuned for the US address shapes the developers tested against. Every new address shape that requires a different reassignment pattern needs new penalty tuning.

## Act 2 — Classification commits before phrase grouping resolves

The problem compounds with multi-word components:

```
P'tit St. Denis' Street Café, 75010 Paris
```

The tokenizer splits on whitespace AND punctuation (commas, apostrophes):

```
[P] ['tit] [St] [.] [Denis] ['] [Street] [Café] [,] [75010] [Paris]
```

The classifier now sees eleven tokens. "St." matches `street_prefix` (abbreviation of "Saint" as a street prefix). "Street" matches `street_suffix`. "Paris" matches `locality`. "75010" matches postcode.

The venue name `P'tit St. Denis' Street Café` has been shredded across seven tokens, three of which look like address components. The solver must recognize that the entire prefix is a venue, overcoming the classifier's high-confidence assignments of `street_prefix` to "St." and `street_suffix` to "Street."

This is the `NY-NY Steakhouse` problem generalized: **any word that appears in both the venue lexicon and the address lexicon will be misclassified, and the misclassification will be high-confidence because the lexicon hit is real.** The token "Street" IS a street suffix in most contexts. The token "NY" IS a region abbreviation. The parser cannot distinguish "venue uses address words" from "this is an address component" without knowing the overall structure of the input.

## Act 3 — Confidence obscures the problem

Traditional parsers report high confidence on dict hits even when the overall parse is wrong. The `street_prefix` classifier is correct that "Saint" can be a street prefix. The `locality` classifier is correct that "Petersburg" is a locality name. Both return confidence > 0.8.

The output:

```
{street_prefix: "Saint", confidence: 0.9}
{locality: "Petersburg", confidence: 0.85}
{region: "FL", confidence: 1.0}
```

To a consumer, this looks like a high-quality parse. Every component has high confidence. The address structure is valid (street prefix + locality + region). The fact that "Saint" should be part of the locality is invisible in the confidence numbers — each individual classifier did its job correctly.

This is the confidence trap: **aggregating per-component confidence hides combination errors.** The parser is confident about each piece and wrong about the whole. The consumer trusts the high scores and routes the package to "Street address: Saint, City: Petersburg, FL" — which the USPS will reject or misroute.

## Why rules can't fix it

Every new address shape that combines tokens differently requires a new rule, a new penalty adjustment, or a new exception in the solver. The rule set grows without bound:

| Address shape                     | Rule needed                             | Why the rule is fragile                                                                                                     |
| --------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Saint Petersburg, FL`            | Multi-word locality patterns            | What about "St. Petersburg"? "Saint Peter"? "San Juan"?                                                                     |
| `NY-NY Steakhouse, Houston TX`    | Venue-before-address boundary detection | The comma is the only signal — no comma, no boundary                                                                        |
| `350 5th Ave, New York, NY 10118` | Number-as-house-number, not postcode    | Positional assumption: first number is housenumber. Fails on `10118 350 5th Ave`.                                           |
| `47110 Sainte-Livrade-sur-Lot`    | Postcode-first detection                | Pattern match on 5-digit leading token. Fails on `90210 Beverly Hills` (postcode looks like ZIP, but context is different). |
| `West 26th Street, New York`      | Directional prefix detection            | "West" is a directional, not a locality. But "West New York" is a town in NJ.                                               |

Each rule works for the specific case it was written for. Each rule introduces false positives in cases that resemble the target but aren't. The rule set accretes, and the false-positive rate compounds. After enough rules, adding a new one fixes one address and breaks three others.

The Cartesian solver that reconciles these rules is what the operator's "Paris, Texas" talk calls **"Sparkling Bogosort"** — it enumerates valid permutations of all possible label assignments, filters the ones that violate hard constraints, and scores the rest. The name is accurate. For well-constrained inputs (a standard US address with a 5-digit ZIP that matches the state), the permutation space is small. For loosely-constrained inputs (an international address with missing components), the permutation space explodes.

## Mailwoman's inversion

Mailwoman inverts the traditional order. Instead of:

```
tokenize → classify → reconcile
```

It runs:

```
phrase-group → classify-spans → reconcile
```

The **phrase grouper** (Stage 2.7) proposes coherent input units _before_ the classifier runs:

```
Input:  "350 5th Ave, New York, NY 10118"
Spans:  [350] [5th Ave] [New York] [NY] [10118]
```

The grouper uses structural cues — punctuation, capitalization, numeric patterns, token proximity — not dictionaries. It does not know what the spans mean. It only knows where the boundaries are.

The **neural classifier** (Stage 3) then types each proposed span. Because the classifier sees the full token sequence simultaneously (it's a transformer, not a per-token classifier), it conditions each span's type on the surrounding spans:

- "5th Ave" next to "350" → likely a street with a house number
- "5th Ave" next to "Brooklyn" → likely a street in a locality
- "NY" next to "10118" → likely a state abbreviation next to a ZIP code
- "NY" followed by "NY Steakhouse" → likely part of a venue name

The classifier can disagree with the grouper's boundaries (it can merge or split spans) but it starts from a better prior than token-level independent classification.

The **reconciler** (Stage 5) then picks the joint interpretation that maximizes coherence — not just per-span correctness, but cross-component consistency. This is where the `NY-NY Steakhouse` problem gets solved: the reconciler sees that labeling the first "NY" as `region` and the second "NY" as `region` produces a joint parse with two regions for different places, which the resolver's hierarchy cannot reconcile. The alternative interpretation — the "NY" tokens are part of a `venue` name — produces a joint-consistent parse. The reconciler switches.

## What this doesn't solve

The staged pipeline doesn't eliminate ambiguity. It moves the ambiguity to where the model has the most information:

- The grouper can still propose wrong boundaries. But it's cheap to improve (rule-based, fast iteration) and wrong boundaries are upstream of classification rather than downstream of it.
- The classifier can still mis-type a span. But it has the full context of the input, not just one token.
- The reconciler can still pick a wrong joint interpretation. But it has resolver feedback — the world hierarchy is a constraint the traditional solver never had.

The point is not that Mailwoman is perfect. The point is that the traditional pipeline has a structural ceiling: **context-free decisions that context-sensitive decisions downstream cannot reverse.** Mailwoman moves the context-sensitive decisions upstream, where they belong.

## See also

- [The staged pipeline](../our-approach/the-staged-pipeline.md) — the Mailwoman runtime in detail
- [The knowledge ladder](../our-approach/the-knowledge-ladder.md) — the principle behind the decomposition
- [How it used to work](../our-approach/how-it-used-to-work.md) — the traditional Mailwoman v1 pipeline
- [How it works now](../our-approach/how-it-works-now.md) — the current rule + neural hybrid
