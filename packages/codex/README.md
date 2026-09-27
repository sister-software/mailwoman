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

Printing an address takes more than string concatenation. Germany puts the house number after
the street and the postcode before the city. Spain separates the street from the number with a
comma. Japan writes the largest unit first, opens with a postal mark, and joins the whole admin
run without spaces. A formatter that gets any of these wrong produces a plausible address from
another country.

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

The package covers **197 countries** and needs no dependencies, network, or database. It runs in
Node, the browser, and on an edge worker.

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

`formatAddress` takes a partial map of component tags and a country code, and returns the
envelope form by default. `singleLine: true` joins the lines the way that country joins them:
`", "` for most countries, `" "` for Japan and Korea, and no separator for the Chinese-script
systems.

A missing value never leaves a dangling separator, because a connector renders only when
something rendered on both sides of it:

```ts
formatAddress({ locality: "New York", postcode: "10118" }, "US", { singleLine: true })
// → "New York, 10118"   — not "New York, , 10118"
```

An unknown country returns `""` instead of a guessed order. 55 of the 252 shipped country
records carry no usable layout, and the empty string reports that absence.

### `formatAddressRow(components, countryCode, options?)`

`formatAddressRow` performs the same render and also reports **which tags it printed and which
it could not place**. The second part is the reason this function exists. A country's layout
can legitimately drop components, and searching the output string for each value cannot
distinguish a dropped component from one whose text happens to appear inside another (`Paris`
inside `Rue de Paris`).

```ts
formatAddressRow({ locality: "Paris", region: "Île-de-France", postcode: "75008" }, "FR", { singleLine: true })
// → {
//     raw: "75008 Paris",
//     components: { postcode: "75008", locality: "Paris" },
//     unplaced: ["region"],            // France absorbs the region — named rather than silently dropped
//   }
```

It returns `null` when the render produced no output.

### `canonicalKey(components, options?)`

`canonicalKey` builds a deterministic match key for record linkage. The key is lowercased,
stripped of diacritics and punctuation, and lists fields in a fixed order. Two records for the
same address that differ only in spelling produce the same key.

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

The key excludes venue and attention, because those fields identify an organization and not an
address.

### `renderAddress(layout, components)`

`renderAddress` is the layer under `formatAddress`. It serves callers that need the pieces
instead of a string, such as a syntax highlighter, a template that wraps each component in its
own element, or an aligner that turns a render into labeled spans. It returns `AddressPiece[]`,
and each piece carries the tag that produced it (or `null` for a separator).

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

To check a country, a reviewer reads the shape of an address from that country instead of a
nested call. The line skeletons are derived from
[libaddressinput](https://github.com/google/libaddressinput), Google's address metadata
(Apache-2.0). 186 countries are generated from it. The 11 locales that this project publishes
models for are hand-authored and checked against real addresses on a committed board.

**One rule governs rendering:**

> A node that renders no output removes itself, and its connector goes with it.

A connector between two slots needs a rendered slot on each side. A connector at a line's edge
has only one side, so it binds to the single slot it touches. That is how Japan's 〒 disappears
with an absent postcode while an interior space does not. When several connectors survive in a
row, the strongest one wins. Punctuation outranks whitespace, so `Calle Mayor, 12` keeps its
comma when the street suffix is absent.

This package authors four things that libaddressinput does not model, each based on a
measurement: the street line's spelling (183 countries space-join the number and the name, and
22 comma-join them), the post-office box line, the country line, and the sub-locality line.

## Reference data

The formatter sits on top of the per-address-system tables, which are useful on their own.

```ts
import { us, fr } from "@mailwoman/codex"

us.lookupStreetSuffix("PKWY") // → { primary: "Parkway", standard: "Parkway", … }
fr.postcodePattern // → /^\d{5}$/

const zip: us.ZipCode = "94043" // branded rather than string alone
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

The first call returns three systems. This function tests the code's **shape** and does not
check gazetteer membership, so returning all three is correct. The caller's country scope
narrows the list. Picking one locale here would present a guess as a fact.

### Postcode granularity: three tiers, each earned by measurement

One `postalcode` placetype covers systems that are not comparable. An Irish Eircode identifies
a single address, and an Australian postcode identifies a locality. Most of the world sits
between them, and the question that changes an answer is narrower: **is this code finer than
the locality that contains it?**

The answer depends on a country's _administrative_ geography and not its postal system, and
code length does not predict it. France and Germany both use five digits and land on opposite
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

A system joins a tier only after a measurement, never because its codes look precise. Canada
shows why. Its urban LDU is unit-grade. Its **rural** LDU measures 2.08 km against the
locality's 929 m and is excluded. Canada Post already marks the difference with a `0` in the
second character, so the code itself identifies its type before any lookup runs. The pooled
Canadian number reads 0.10 km and looks like a uniform improvement, but it mixes two
populations. These tables exist to prevent a tier claim that averages two granularities.

## Layout and convention coverage

The layouts and the parsing conventions cover different numbers of places. The difference is
intentional and does not represent a backlog.

| Table                                                         | Keyed by     | Coverage                                         |
| ------------------------------------------------------------- | ------------ | ------------------------------------------------ |
| `ADDRESS_LAYOUTS` (`./address-layouts`)                       | country code | 197 countries; 55 of 252 records carry no layout |
| `ADDRESS_SYSTEM_CONVENTIONS` (`./address-system-conventions`) | `SystemCode` | two rows: `fr`, `gb`                             |
| `SystemCode` (`./postcode-systems`)                           | —            | ten: `us de fr es it ca gb jp au nz`             |

A layout says how to print an address, so a country needs one before it can be served. A
conventions row says what is ungrammatical in that system, and the decoder applies it as a hard
mask before Viterbi. A wrong row therefore breaks parses that currently work. Each row carries
the measurement that justified it. An absent row means "no constraints known" and never "no
constraints exist". Adding a country to the layouts is ordinary work, but adding a conventions
row requires a measured receipt.

### Postal regimes the country code does not name

Three families of addresses need a unit that is finer than, or different from, the ISO country
code. codex cannot express any of them today
([#2323](https://github.com/sister-software/mailwoman/issues/2323)):

- **One code, several postal regimes.** `SH` covers Saint Helena, Ascension Island and Tristan da
  Cunha, which format addresses differently.
- **Routing that is not geography.** BFPO identifiers are routing instructions and not a GB
  locality plus postcode. The American half of this family is modeled in
  `lib/us/military-address.ts`, which covers APO/FPO/DPO and the `AA`/`AE`/`AP` pseudo-states. The
  British half is not modeled.
- **Narrative addresses.** Costa Rica, Nicaragua and parts of Panama and the Caribbean build an
  address from a landmark, a direction and a distance. That is a separate grammar and not a
  variant of the street grammar the layouts assume.

### Out of scope

Research state, source URLs and license terms for address data belong elsewhere. Whether this
project has verified an open national address register for Chile is a fact about the data
backlog and not about how Chileans write an address. That information lives in
[`@mailwoman/corpus`](../corpus#source-provenance).

## What this package does not do

This package does not **parse**. Turning `"1600 Amphitheatre Pkwy, Mountain View CA"` into
components is a sequence-labeling problem, which [`mailwoman`](https://www.npmjs.com/package/mailwoman)
solves with a small transformer encoder that is installed separately. This package does not
geocode either. It covers the inverse direction and the reference tables, and it stays
dependency-free so that a consumer who only wants to print an address does not download a model.

## Design

- **Zero runtime dependencies.** The package is pure TypeScript data and a small evaluator, with
  no database, I/O, or network access. It is suitable for bundling into browser and edge
  environments.
- **Branded types.** ZIP codes, postcodes and abbreviations carry nominal types, so the type
  system catches locale mismatches at compile time.
- **An absence is reported, never invented.** A country with no layout returns `""`, and a
  component that the layout has no slot for is listed in `unplaced`.
- **One definition.** The parser, the resolver, the corpus synthesis layer and the matcher all
  import these tables instead of each keeping a copy.

## The normative tier (codex vs the libpostal dictionaries)

Mailwoman carries two closed-class vocabularies that overlap intentionally and must stay
separate:

- **Codex is normative.** It reproduces USPS Pub-28 (and each system's equivalent) verbatim: the
  canonical word, every _recognized_ variant, and the one _preferred_ abbreviation. Its consumers
  need precision. They are corpus synthesis recipes, the eval harness's invariance transforms, and
  formatting, since rendering `N` or `North` requires knowing which form the authority prints.
- **The libpostal dictionaries** (`core/data/libpostal/dictionaries/`, Pelias lineage) **are
  descriptive.** They list everything people write, including forms that no authority recognizes
  (`en/directionals.txt` lists `lower`/`upper`/`central`). Their consumers need recall. They are
  evidence-lexicon curation laws, street decomposition for training gold, and the street-morphology
  FST.

Adding descriptive forms to codex would corrupt formatting. Narrowing the descriptive lists to
normative forms would weaken the evidence guards. The two vocabularies answer different
questions, so they stay in different tables.

## Related

- [`mailwoman`](https://www.npmjs.com/package/mailwoman): the parser, which turns free text into components.
- [`@mailwoman/record`](../record): the record schema and per-field normalizers for entity matching.
- [`@mailwoman/address-id`](../address-id): stable address primary keys, built on these tables.
- [`@mailwoman/resolver`](../resolver): uses the granularity tiers to order a resolved tree.

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/AGPL-3.0.html)
