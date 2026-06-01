---
sidebar_position: 10
title: What is a concordance?
tags:
  - domain
  - concepts
  - architecture
  - resolver
  - staged-pipeline
  - locality
  - region
---

# What is a concordance?

In Mailwoman's architecture, a **concordance** is the resolver's answer to the question: "Do these parsed components form a coherent place in the real world?" It is the mechanism that prevents the parser from emitting a parse that is structurally valid but geographically impossible — like "Paris, Texas" labelled as "Paris, Île-de-France" or "NY-NY Steakhouse, Houston TX" with "NY" tagged as a region.

## Why concordance exists

Traditional address parsers validate their output structurally: the parse must have at most one of each component, spans must not overlap, and the BIO tag sequence must be valid. But structural validity does not guarantee geographical validity:

| Parse                                  | Structurally valid? | Geographically valid?                     |
| -------------------------------------- | ------------------- | ----------------------------------------- |
| `locality=Paris, region=TX`            | Yes                 | Yes — Paris, Texas exists                 |
| `locality=Paris, region=Île-de-France` | Yes                 | Yes — Paris, France exists                |
| `locality=NY, region=TX`               | Yes                 | **No** — NY is not a locality in Texas    |
| `locality=Houston, region=NY`          | Yes                 | **No** — Houston is not in New York state |
| `locality=Springfield, region=IL`      | Yes                 | Yes — Springfield, IL exists              |
| `locality=Springfield, region=MA`      | Yes                 | Yes — Springfield, MA ALSO exists         |

The last two rows are the hard case: both parses are structurally valid AND geographically valid. The parser cannot tell them apart from the text alone — "Springfield" without a state is ambiguous, and "Springfield, IL" vs "Springfield, MA" with a state is unambiguous but requires knowing which states contain a Springfield. That knowledge lives in the gazetteer, not the parser.

Concordance is the mechanism that brings gazetteer knowledge into the parsing decision.

## How concordance works in Mailwoman

Mailwoman's resolver (Stage 6) maintains a gazetteer — currently Who's On First (WOF), a global database of places with stable identifiers and parent-child relationships. Every WOF record has:

- A `wof:id` (unique numeric identifier).
- A `parent_id` pointing to the containing administrative entity.
- A `placetype` (country, region, locality, neighbourhood, etc.).
- A name and alternate names.

The parent-child chain encodes geographic containment:

```
Springfield, IL (wof:id=4258867, parent_id=...)
  → Sangamon County, IL (parent)
    → Illinois (parent)
      → United States (parent)

Springfield, MA (wof:id=85950363, parent_id=...)
  → Hampden County, MA (parent)
    → Massachusetts (parent)
      → United States (parent)
```

When the parser emits `locality=Springfield, region=IL`, the resolver looks up Springfield, IL and walks the parent chain. It finds Illinois as the parent region. The parsed `region=IL` matches the gazetteer's parent — **concordance achieved**. The parse is geographically coherent.

When the parser emits `locality=Springfield, region=MA`, the resolver does the same walk and finds that Springfield, MA has parent Massachusetts. A different parse, but also concordant.

When the parser emits `locality=Springfield, region=TX`, the resolver finds no Springfield record whose parent chain contains Texas. **Concordance failure.** The parse is structurally valid but geographically impossible.

## The joint decoding loop

Concordance is part of the parsing decision itself, not a separate check applied afterward. Mailwoman's **reconciler** (Stage 5) performs beam search over `(span × tag × resolver candidate)` triples, scoring each beam with:

```
score = phrase_conf × classifier_score × resolver_score × concordance_bonus
```

The concordance bonus is a log-space reward for parent-chain consistency. A fully consistent WOF parent chain contributes `+concordanceWeight` (default 1.0). An explicit contradiction — the parsed region is not in the locality's WOF parent chain — is a hard veto.

This means the reconciler can pick a less-confident classifier output over a more-confident one if the more-confident one fails concordance. The concrete example from Mailwoman's kryptonite catalogue:

**Input:** `NY-NY Steakhouse, Houston, TX`

The phrase grouper proposes spans: `[NY] [-] [NY] [Steakhouse] [,] [Houston] [,] [TX]`

The classifier emits per-span top-3 tag distributions. For the first two `NY` tokens, the top tags might be:

```
Token "NY" (first):  {region: 0.6, venue: 0.2, locality: 0.1}
Token "NY" (second): {region: 0.5, venue: 0.3, locality: 0.1}
```

The argmax path tags both as `region` — highly confident, structurally valid, and completely wrong. The joint detector takes the top-K for each span and tries combinations:

1. `{NY:region, NY:region, Houston:locality, TX:region}` → Concordance: two regions ("NY" and "TX") in the same parse. No WOF hierarchy contains both as containing regions of Houston. **Vetoed.**

2. `{NY:venue, NY:venue, Houston:locality, TX:region}` → Concordance: Houston, TX exists in WOF. "NY-NY" as a venue does not need a parent chain — venues don't participate in administrative hierarchy. **Concordant.**

The reconciler picks option 2 because it is joint-coherent, even though the per-token classifier was more confident about option 1.

## Why concordance is not post-processing

A naive approach would be: parse first, then check concordance, then fall back if it fails. This works for simple cases but fails for adversarial ones:

- If the first parse is `Paris, France`, the resolver confirms it and returns.
- If the first parse is `Paris, TX` tagged as French Paris, the resolver rejects it — and the fallback path has to try alternatives. But the **alternatives were discarded** by the argmax step. The classifier never emitted "Paris, TX" as a candidate because it went all-in on "Paris, France."

Joint decoding avoids this by keeping the top-K alternatives alive through the concordance check. The resolver sees multiple interpretations and picks the geographically coherent one, rather than receiving one interpretation and saying "yes" or "no."

## What concordance does not do

- It does not guarantee correctness. If the gazetteer is wrong (wrong parent_id chain, missing locality, outdated boundaries), concordance can reward wrong parses and punish correct ones. This is why the WOF parent-id spot check exists as a diagnostic step.
- It does not resolve ambiguity alone. When two parses are both concordant (Springfield IL vs Springfield MA), the downstream application must decide — population prior, user context, or an explicit "did you mean?" prompt.
- It does not replace the classifier. If the classifier never emits the correct tag in its top K, no amount of concordance can recover it. The reconciler re-ranks, it does not invent.

## See also

- [The knowledge ladder](../our-approach/the-knowledge-ladder.md) — where reconcile sits in the staged pipeline
- [The staged pipeline](../our-approach/the-staged-pipeline.md) — runtime end-to-end
- [Joint decoding walkthrough](../../concepts/joint-decoding-walkthrough.md) — concrete example with NY-NY Steakhouse
- [Resolver and Who's On First](../../concepts/resolver-and-wof.md) — the gazetteer that concordance depends on
