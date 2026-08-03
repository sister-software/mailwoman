# Template: landing

A `landing` page routes. It defines one thing in a sentence a reader can repeat, then sends them to the page
that does the work. Register rules are in [`../writing-system.md`](../writing-system.md) under Register by
role.

## Frontmatter skeleton

Copy this to the top of the new page. `audience` is required for this role; the values in use are
`product-reader`, `contributor`, and `maintainer`.

```yaml
---
title: Address identifiers
description: A stable, parseable primary key for a postal address.
role: landing
audience: product-reader
source-of-truth: self
---
```

## Section order

1. `# Title` — the noun, not a slogan.
2. **Definition.** One or two sentences. A reader should be able to repeat it to a colleague.
3. **Routes.** Two to four `## I want to …` sections, each ending in one link.
4. **One worked example.** A single concrete case, complete on this page.
5. **Call to action.** Exactly one.

## Opening move

Define the thing in one sentence, in the reader's vocabulary rather than the codebase's, then route.

## Exemplar paragraph

> `@mailwoman/address-id` turns a parsed address into a key you can `GROUP BY` or `JOIN ON`. The key has
> three parts: a coarse region prefix, an H3 cell at resolution 9, and a hash of the address after
> normalization. Because the hash runs on the normalized form, `123 Main St` and `123 MAIN STREET` produce
> the same key; because the cell is coarse, two geocodes of the same building a few metres apart still land
> together. This is the exact-match half of record resolution. When two records disagree in ways
> normalization cannot settle, you want the fuzzy matcher instead.

<!-- illustrative -->

```ts
createPostalAddressID({
	components: { street: "123 Main St", locality: "Austin", region: "TX", postcode: "78701" },
	coordinate: { lat: 30.2672, lon: -97.7431 },
})
// → "tx.882830829dfffff.abc123def456"
```

## Checks before commit

- The definition sentence is repeatable without the page open.
- Every number on the page is sourced.
- A superlative appears only where the same sentence pair cashes it out.
- There is one call to action, and cost or limit facts are answered on this page rather than assembled from
  three others.
- The audit checklist in [`../writing-system.md`](../writing-system.md) has been run over the draft.
