# Component Schema

This document defines the canonical `ComponentTag` union. It is the single source of truth.

**Rule:** any change to this file requires:

1. A written rationale in the commit message.
2. A migration plan for existing corpus rows tagged with the old schema.
3. A check that downstream alignment, training, and inference code is updated in the same commit.

## Tag inventory

### Universal (Phase 1, all locales)

| Tag                  | Description                                             | Example                         |
| -------------------- | ------------------------------------------------------- | ------------------------------- |
| `country`            | Sovereign state name or code                            | `USA`, `France`, `FR`           |
| `region`             | First-level admin (state, région)                       | `OR`, `Île-de-France`           |
| `locality`           | City, town, commune                                     | `Portland`, `Paris`             |
| `dependent_locality` | Sub-locality (neighborhood, arrondissement, ward)       | `Brooklyn`, `8e arrondissement` |
| `postcode`           | Postal code                                             | `97215`, `75008`                |
| `subregion`          | Optional county-level admin between region and locality | `Multnomah County`              |

### Street-level (Phase 2)

| Tag                      | Description                                    | Example                            |
| ------------------------ | ---------------------------------------------- | ---------------------------------- |
| `house_number`           | Building number on a street                    | `6220`, `12bis`                    |
| `street`                 | Street name proper                             | `Salmon St`, `République`          |
| `street_prefix`          | Directional or descriptive prefix (Anglophone) | `SE`, `North`                      |
| `street_prefix_particle` | Non-English grammatical particle (FR)          | `de la`, `du`, `des`               |
| `street_suffix`          | Street type suffix (Anglophone)                | `Street`, `Boulevard`, `Ave`       |
| `intersection_a`         | First street of an intersection query          | `5th Ave` (in "5th Ave & 42nd St") |
| `intersection_b`         | Second street of an intersection query         | `42nd St` (in "5th Ave & 42nd St") |
| `unit`                   | Apartment, suite, floor                        | `Apt 4B`, `Suite 200`, `5e étage`  |

### Venue-level (Phase 3)

| Tag         | Description                            | Example                           |
| ----------- | -------------------------------------- | --------------------------------- |
| `venue`     | Named place (business, landmark, park) | `Mt Tabor Park`, `Eiffel Tower`   |
| `attention` | "Attention" or "care of" line          | `c/o Jane Doe`, `Att: Sales Dept` |
| `po_box`    | Post office box                        | `PO Box 1234`, `BP 42`            |

### Locale-specific

| Tag     | Locale | Description                        | Example                              |
| ------- | ------ | ---------------------------------- | ------------------------------------ |
| `cedex` | FR     | Special postal routing designation | `CEDEX 08` in `75008 PARIS CEDEX 08` |

### JP-specific (Phase 6 — listed for forward compatibility, not used in Phase 1–3)

| Tag               | Description                         | Example                |
| ----------------- | ----------------------------------- | ---------------------- |
| `prefecture`      | JP first-level admin (都道府県)     | `東京都`, `Tokyo`      |
| `municipality`    | JP city/ward (市区町村)             | `千代田区`, `Chiyoda`  |
| `district`        | JP district (大字)                  | `丸の内`, `Marunouchi` |
| `block`           | JP chōme (丁目)                     | `1丁目`                |
| `sub_block`       | JP banchi (番地)                    | `1番地`                |
| `building_number` | JP gō (号)                          | `1号`                  |
| `building_name`   | JP named building (often in romaji) | `Tokyo Building`       |

**Note for JP-forward-compatibility:** the JP-specific tags above must not be referenced anywhere in core code in Phases 0–5. They exist in this document so that schema additions in Phase 6 do not require a core rewrite. The `componentsSupported` field on `LocaleProfile` is how the system knows which tags a locale actually uses.

## BIO labeling

For training and inference, each tag `T` becomes two labels:

- `B-T` — beginning of a span tagged `T`
- `I-T` — inside (continuation) of a span tagged `T`

Plus one universal label:

- `O` — outside any address component (punctuation, noise, junk)

Example labeling of `"6220 SE Salmon St, Portland OR"`:

```
Token    Label
─────    ─────
6220     B-house_number
SE       B-street_prefix
Salmon   B-street
St       I-street
,        O
Portland B-locality
OR       B-region
```

## Implementation notes

### TypeScript representation

```ts
// packages/core/src/types/component.ts

export const COMPONENT_TAGS = [
	// Universal
	"country",
	"region",
	"locality",
	"dependent_locality",
	"postcode",
	"subregion",
	// Street-level
	"house_number",
	"street",
	"street_prefix",
	"street_prefix_particle",
	"street_suffix",
	"intersection_a",
	"intersection_b",
	"unit",
	// Venue-level
	"venue",
	"attention",
	"po_box",
	// FR-specific
	"cedex",
	// JP-specific (Phase 6 — declared but unused until then)
	"prefecture",
	"municipality",
	"district",
	"block",
	"sub_block",
	"building_number",
	"building_name",
] as const

export type ComponentTag = (typeof COMPONENT_TAGS)[number]

export const BIO_LABELS = ["O", ...COMPONENT_TAGS.flatMap((t) => [`B-${t}`, `I-${t}`])] as const

export type BioLabel = (typeof BIO_LABELS)[number]
```

The `as const` and derived types are deliberate. TypeScript will surface schema-aware errors at compile time wherever a tag is referenced.

### Validation rule

A `LocaleProfile.componentsSupported` array must be a subset of `COMPONENT_TAGS`. Runtime check at profile registration. Fail loudly if violated.

## Rationale for specific choices

**Why `dependent_locality` and not `neighborhood` or `borough`?** WOF and ISO use `dependent_locality` for the general concept. Names like `borough` are locale-specific. Pick the umbrella term.

**Why split `street_prefix` from `street_prefix_particle`?** English `SE` and French `de la` are grammatically different and synthesis pipelines need to treat them differently. Conflating them produces worse training data.

**Why expose `subregion` if it's optional?** Some US addresses include county (rare in display but common in government data). Modeling it explicitly is better than forcing it into `region` or `locality`.

**Why `cedex` is FR-specific and not subsumed by `postcode`?** A CEDEX designation is a postal routing instruction, not a postcode. Treating it as one corrupts FR postal code statistics.

**Why list JP tags here at all before Phase 6?** Forces Phase 0 type design to handle them. If core code reaches Phase 6 and needs to add seven new tags plus rewrite the policy system, the schema-first principle failed.
