# Template: explanation

An `explanation` page answers a why question. It has no steps and no contract tables, and a reader should be
able to close it having changed their mental model rather than their filesystem. Register rules are in
[`../writing-system.md`](../writing-system.md) under Register by role.

## Frontmatter skeleton

Copy this to the top of the new page. This role carries no fields beyond `role:`.

```yaml
---
title: Why boundary discovery runs before type classification
description: How the phrase grouper splits one hard question into two easier ones.
role: explanation
---
```

## Section order

1. `# Title` — the question, or the claim the page argues.
2. **The question.** Two or three sentences, phrased the way a reader would ask it.
3. **The analog.** The rule-world concept, before any statistical term.
4. **The mechanism.** What the system does, in the order it does it.
5. **What it costs.** Where the design gives something up, and to whom.
6. **Related.** Links to the reference pages that hold the contract.

## Opening move

Open with the question a reader arrived with, in their words, and answer it in the second paragraph rather
than the last.

## Exemplar paragraph

> Reading an address by hand is two questions, not one. First you decide where the pieces start and stop —
> `1600 Amphitheatre Parkway` is one piece, `Mountain View` is another — and only then do you decide what
> each piece is. The phrase grouper (stage 2.7) is the first of those questions on its own. It proposes
> spans with a kind hypothesis and a confidence, so the model at stage 3 answers "what type is this proposed
> span?" instead of discovering boundaries and types at once. Splitting the two costs a page of plumbing and
> buys a smaller question at the point where errors are expensive, because a boundary the grouper proposes
> can be reconsidered, while a boundary a joint decoder has already committed to cannot.

<!-- illustrative -->

```ts
groupPhrases("1600 Amphitheatre Parkway, Mountain View, CA 94043", shape, locale)
// [
//   { text: "1600 Amphitheatre Parkway", kind: "street_phrase", confidence: 0.95 },
//   { text: "Mountain View",             kind: "locality_phrase", confidence: 0.8 },
//   { text: "CA",                        kind: "region_abbreviation", confidence: 0.99 },
//   { text: "94043",                     kind: "postcode", confidence: 0.98 },
// ]
```

## Checks before commit

- The rule-world analog appears before the statistical term, not after it.
- Each term is defined in one sentence at first use, and the registry link carries the rest.
- The page states what the design gives up, not only what it gains.
- No steps, no contract tables. Those belong on a `guide` or a `reference` page, linked from Related.
- The audit checklist in [`../writing-system.md`](../writing-system.md) has been run over the draft.
