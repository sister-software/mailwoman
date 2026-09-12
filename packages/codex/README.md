<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://mailwoman.ai/img/mailwoman-seal-magenta.svg">
    <img src="https://mailwoman.ai/img/mailwoman-seal-navy.svg" alt="" width="96" height="96">
  </picture>
</p>

<h1 align="center">@mailwoman/codex</h1>

<p align="center"><strong>A postal address formatter, and the per-country reference data behind it.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mailwoman/codex"><img alt="npm version" src="https://img.shields.io/npm/v/@mailwoman/codex?color=ff00b0&label=npm"></a>
  <img alt="dependencies" src="https://img.shields.io/badge/runtime%20deps-0-339933">
  <img alt="license" src="https://img.shields.io/npm/l/@mailwoman/codex?color=663399">
  <img alt="node version" src="https://img.shields.io/node/v/@mailwoman/codex?color=339933">
</p>

Printing an address is not string concatenation. Germany puts the house number after the
street and the postcode before the city. Spain separates the street from the number with a
comma. Japan writes largest unit first, opens with a postal mark, and joins the whole admin
run without spaces. Get any of it wrong and you have produced a plausible address from
somewhere else.

```ts
import { formatAddress } from "@mailwoman/codex/address-format"

formatAddress(
	{ house_number: "1600", street: "Pennsylvania Ave NW", locality: "Washington", region: "DC", postcode: "20500" },
	"US"
)
// → "1600 Pennsylvania Ave NW\nWashington, DC 20500"

formatAddress({ street: "Willy-Brandt-Straße", house_number: "1", locality: "Berlin", postcode: "10557" }, "DE", {
	singleLine: true,
})
// → "Willy-Brandt-Straße 1, 10557 Berlin"

formatAddress({ street: "Calle de Alcalá", house_number: "3", locality: "Madrid", postcode: "28014" }, "ES", {
	singleLine: true,
})
// → "Calle de Alcalá, 3, 28014 Madrid"

formatAddress(
	{
		postcode: "100-0005",
		region: "東京都",
		subregion: "千代田区",
		dependent_locality: "丸の内",
		house_number: "1-9-1",
	},
	"JP",
	{ singleLine: true }
)
// → "〒100-0005 東京都千代田区丸の内1-9-1"
```

**197 countries**, no dependencies, no network, no database. It runs in Node, the browser and
on an edge worker.

## Installation

```bash
npm install @mailwoman/codex
# or
yarn add @mailwoman/codex
```

> [!IMPORTANT]
> Requires Node.js ≥ 24.18.0. Pure ESM.

## Formatting

### `formatAddress(components, countryCode, options?)`

Takes a partial map of component tags and a country code. Returns the envelope form by
default; `singleLine: true` joins the lines the way that country joins them — `", "` for
most, `" "` for Japan and Korea, nothing at all for the Chinese-script systems.

A missing value never leaves a dangling separator behind it, because a connector renders
only when something rendered on both sides of it:

```ts
formatAddress({ locality: "New York", postcode: "10118" }, "US", { singleLine: true })
// → "New York, 10118"   — not "New York, , 10118"
```

An unknown country returns `""` rather than guessing an order. 55 of the 252 shipped country
records carry no usable layout, and saying nothing for one of those reports the absence.

### `formatAddressRow(components, countryCode, options?)`

The same render, plus **which tags it printed and which it could not**. That second half is
the reason this function exists: a country's layout legitimately drops components, and
searching the output string for each value cannot tell a dropped component from one whose
text happens to sit inside another (`Paris` inside `Rue de Paris`).

```ts
formatAddressRow({ locality: "Paris", region: "Île-de-France", postcode: "75008" }, "FR", { singleLine: true })
// → {
//     raw: "75008 Paris",
//     components: { postcode: "75008", locality: "Paris" },
//     unplaced: ["region"],            // France absorbs the region — named, not silently dropped
//   }
```

Returns `null` when nothing rendered at all.

### `canonicalKey(components, options?)`

A deterministic match key for record linkage — lowercased, diacritic-stripped,
punctuation-flattened, fields in a fixed order. Two records for the same address that differ
only in spelling produce the same key.

```ts
import { canonicalKey } from "@mailwoman/codex/address-key"

canonicalKey({
	house_number: "123",
	street: "Main",
	street_suffix: "St",
	locality: "Portland",
	region: "OR",
	postcode: "97201",
})
// → "123|main|st|portland|or|97201"
```

Venue and attention are excluded on purpose: those carry organization identity, not address
identity.

### `renderAddress(layout, components)`

The layer under `formatAddress`, for callers that need the pieces rather than a string — a
syntax highlighter, a template that wraps each component in its own element, an aligner
turning a render into labeled spans. It returns `AddressPiece[]`, each piece carrying the
tag that produced it (or `null` for a separator).

## Where the order comes from

Each country's layout is **data**, written as a tagged template that reads in the order it
prints:

```ts
// %N%n%O%n%A%n%C, %S %Z
US: addr`${attention}
${venue}
${numberFirstStreet}
${locality}, ${region} ${postcode}
${country}`,
```

Checking a country means looking at the shape of an address from there, not at a nested call.
The line skeletons are derived from [libaddressinput](https://github.com/google/libaddressinput),
Google's address metadata (Apache-2.0); 186 countries are generated from it and the 11 locales
this project publishes models for are hand-authored and checked against real addresses on a
committed board.

**One rule governs rendering:**

> A node that renders nothing removes itself, and its connector goes with it.

A connector between two slots needs a rendered slot on each side. A connector at a line's edge
has only one side, so it binds to the single slot it touches — which is how Japan's 〒
disappears along with an absent postcode while an interior space does not. Where several
connectors survive in a row, the strongest wins: punctuation outranks whitespace, so
`Calle Mayor, 12` keeps its comma when the street suffix is absent.

Four things libaddressinput does not model are authored here, each from a measurement rather
than a guess: the street line's spelling (183 countries space-join the number and the name, 22
comma-join), the post-office box line, the country line, and the sub-locality line.

## Reference data

The formatter sits on top of the per-address-system tables, which are useful on their own.

```ts
import { us, fr } from "@mailwoman/codex"

us.lookupStreetSuffix("PKWY") // → { primary: "Parkway", standard: "Parkway", … }
fr.postcodePattern // → /^\d{5}$/

const zip: us.ZipCode = "94043" // branded, not string alone
```

| System   | Scope                                                                                |
| -------- | ------------------------------------------------------------------------------------ |
| **`us`** | USPS street suffixes, directional abbreviations, ZIP code types, state abbreviations |
| **`fr`** | La Poste postcode format, CEDEX conventions, département codes                       |
| **`gb`** | Royal Mail postcode format, post town conventions                                    |
| **`de`** | Deutsche Post postcode format, Bundesland abbreviations                              |
| **`ca`** | Canada Post postcode format, province abbreviations, the urban/rural FSA split       |
| **`au`** | Australia Post postcode format, state abbreviations                                  |

### Which country is this postcode from?

```ts
import { candidateSystemsForPostcode } from "@mailwoman/codex"

candidateSystemsForPostcode("94043") // → ["us", "de", "fr"]
candidateSystemsForPostcode("SW1A 1AA") // → ["gb"]
```

Note the first answer. This is a **shape** test, not a gazetteer membership test, and
returning all three is the correct answer rather than a hedge — the caller's country scope is
what narrows it. Picking one locale here would be a guess wearing a fact's clothes.

### Postcode granularity: three tiers, each earned by measurement

One `postalcode` placetype covers systems that are not comparable. An Irish Eircode names a
single address; an Australian postcode names a locality. Between them sit most of the world,
and the distinction that changes an answer is narrower: **is this code finer than the locality
that contains it?**

That is a fact about a country's _administrative_ geography, not its postal system, and code
length does not predict it. France and Germany are both five digits and land on opposite
sides.

```ts
import { isUnitGradePostcodeHit, areaPostcodeLeadsLocality } from "@mailwoman/codex"

isUnitGradePostcodeHit("N7 0BT", "n70bt") // → true  (GB unit, and the resolver hit the FULL code)
isUnitGradePostcodeHit("N7 0BT", "n7") // → false (the resolver answered with the outward district)
areaPostcodeLeadsLocality("DE") // → true  (a Gemeinde can be the size of Berlin)
areaPostcodeLeadsLocality("FR") // → false (one code postal often spans several communes)
```

| Tier                                                                              | Members                           | What earned it                                                            |
| --------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| **unit-grade** (`UNIT_GRADE_POSTCODE`)                                            | NL PC6, GB unit, CA **urban** LDU | measured against rooftop truth — GB 38 m median, CA urban 78 m            |
| **area, but still finer than the locality** (`AREA_POSTCODE_FINER_THAN_LOCALITY`) | DE                                | full-panel measurement: 5.84 km → 1.24 km p50, better on every percentile |
| **area** (the default)                                                            | everything else                   | the locality-first convention                                             |

Membership is earned by a measurement, never by a shape that looks tight. Canada is the case
that shows why: its urban LDU is unit-grade, its **rural** LDU measures 2.08 km against the
locality's 929 m and is excluded — and Canada Post already marks the difference with a `0` in
the second character, so the code says which before any lookup runs. The pooled Canadian
number reads 0.10 km and looks like a uniform win; it is two populations, and a tier claim
that averages two granularities is exactly what these tables exist to prevent.

## What this package does not do

It does not **parse**. Turning `"1600 Amphitheatre Pkwy, Mountain View CA"` into components is
a sequence-labeling problem, and that is [`mailwoman`](https://www.npmjs.com/package/mailwoman)
— a small transformer encoder, installed separately. It does not geocode either. This package
is the inverse direction and the reference tables, and it stays dependency-free so a consumer
who only wants to print an address does not pull a model down.

## Design

- **Zero runtime dependencies.** Pure TypeScript data and a small evaluator — no database, no
  I/O, no network. Suitable for bundling into browser and edge environments.
- **Branded types.** ZIP codes, postcodes and abbreviations carry nominal types, so the type
  system catches locale mismatches at compile time.
- **An absence is reported, never invented.** A country with no layout returns `""`; a
  component the layout has no slot for is named in `unplaced`.
- **One definition.** The parser, the resolver, the corpus synthesis layer and the matcher all
  import these tables rather than each carrying a copy.

## The normative tier (codex vs the libpostal dictionaries)

Mailwoman carries two closed-class vocabularies that overlap on purpose and must not be
merged:

- **Codex is normative.** USPS Pub-28 (and each system's equivalent) verbatim: the canonical
  word, every _recognized_ variant, and the one _preferred_ abbreviation. Its consumers are
  precision-shaped — corpus synthesis recipes, the eval harness's invariance transforms, and
  formatting (rendering `N` vs `North` requires knowing which form the authority prints).
- **The libpostal dictionaries** (`core/data/libpostal/dictionaries/`, Pelias lineage) **are
  descriptive**: everything people write, including forms no authority recognizes
  (`en/directionals.txt` lists `lower`/`upper`/`central`). Their consumers are recall-shaped —
  evidence-lexicon curation laws, street decomposition for training gold, the street-morphology
  FST.

Broadening codex with descriptive forms would corrupt formatting; narrowing the descriptive
lists to normative forms would weaken the evidence guards. Different questions, different
tables.

## Related

- [`mailwoman`](https://www.npmjs.com/package/mailwoman) — the parser: free text → components
- [`@mailwoman/record`](../record) — record schema and per-field normalizers for entity matching
- [`@mailwoman/address-id`](../address-id) — stable address primary keys, built on these tables
- [`@mailwoman/resolver`](../resolver) — consumes the granularity tiers to order a resolved tree

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
