# @mailwoman/codex

**Per-address-system postal reference data and branded types.**

Every country's postal authority (USPS, La Poste, Deutsche Post, …) has its own
conventions for what a postcode, a street suffix, or a unit designator looks like.
`@mailwoman/codex` is the shared, dependency-free home for that reference knowledge,
kept apart from the locale-agnostic tokenizer/solver in `@mailwoman/core` and from
the training pipeline in `@mailwoman/corpus`.

The parser, the resolver, and the synthesis layer all reach for the same tables
instead of each carrying their own copy.

```ts
import { us, fr, gb, de } from "@mailwoman/codex"

// USPS street suffix lookup
us.lookupStreetSuffix("PKWY") // → { primary: "Parkway", standard: "Parkway", ... }
us.lookupStreetSuffix("PKY") // → { primary: "Parkway", standard: "Parkway", ... }

// French postcode pattern
fr.postcodePattern // → /^\d{5}$/

// US ZIP code branded type
import { us } from "@mailwoman/codex"
const zip: us.ZipCode = "94043" // branded, not just string
```

## Supported address systems

Each system is exposed as a namespace and as a subpath import:

```ts
import { us } from "@mailwoman/codex"
import { lookupStreetSuffix } from "@mailwoman/codex/us"
```

| System   | Scope                                                                                |
| -------- | ------------------------------------------------------------------------------------ |
| **`us`** | USPS street suffixes, directional abbreviations, ZIP code types, state abbreviations |
| **`fr`** | La Poste postcode format, CEDEX conventions, département codes                       |
| **`gb`** | Royal Mail postcode format, post town conventions                                    |
| **`de`** | Deutsche Post postcode format, Bundesland abbreviations                              |
| **`ca`** | Canada Post postcode format, province abbreviations                                  |
| **`au`** | Australia Post postcode format, state abbreviations                                  |

## Cross-system utilities

```ts
import { candidateSystemsForPostcode } from "@mailwoman/codex"

// Which systems could "94043" belong to?
candidateSystemsForPostcode("94043") // → ["us"]
candidateSystemsForPostcode("75008") // → ["fr"]
candidateSystemsForPostcode("10115") // → ["de"]

// Address system conventions (forbidden tags, expected shapes, etc.)
import { ADDRESS_SYSTEM_CONVENTIONS, conventionsForSystem } from "@mailwoman/codex"
```

## Design

- **Zero runtime dependencies.** Pure TypeScript data tables — no database, no I/O,
  no network. Suitable for bundling into browser and edge environments.
- **Branded types.** ZIP codes, postcodes, and abbreviations carry nominal types
  so the type system catches locale mismatches at compile time.
- **Single source of truth.** The resolver, the decoder's convention masks, the
  corpus synthesis layer, and the matcher all import from `@mailwoman/codex`.

## The normative tier (codex vs the libpostal dictionaries)

Mailwoman carries two closed-class vocabularies that overlap on purpose and must not
be merged:

- **Codex is normative.** USPS Pub-28 (and each system's equivalent) verbatim: the
  canonical word, every _recognized_ variant, and the one _preferred_ abbreviation.
  Its consumers are precision-shaped — corpus synthesis recipes, the eval harness's
  invariance transforms, and formatting (rendering `N` vs `North` requires knowing
  which form the authority prints).
- **The libpostal dictionaries** (`core/data/libpostal/dictionaries/`, Pelias
  lineage) **are descriptive**: everything people actually write, including forms no
  authority recognizes (`en/directionals.txt` lists `lower`/`upper`/`central`).
  Their consumers are recall-shaped — evidence-lexicon curation laws, street
  decomposition for training gold, the street-morphology FST. See the README in
  that directory for the full consumer map and the four-tier curated-data layering.

Broadening codex with descriptive forms would corrupt formatting; narrowing the
descriptive lists to normative forms would weaken the evidence guards. Different
questions, different tables.

## Related

- [`@mailwoman/core`](../core) — `ComponentTag` schema, pipeline infrastructure
- [`@mailwoman/address-id`](../address-id) — uses codex for stable address primary keys
- [Address system conventions](https://mailwoman.sister.software/articles/plan/reference/SCHEMA/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
