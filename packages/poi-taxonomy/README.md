# @mailwoman/poi-taxonomy

This package maps point-of-interest (POI) phrases to categories and brand names. It includes the taxonomy and brand tables used by Mailwoman.

Public library. Install with `npm install @mailwoman/poi-taxonomy`.

## Quick start

```ts
import { lookupPOICategory, resolveOvertureCategories } from "@mailwoman/poi-taxonomy"

const matches = lookupPOICategory("supermarket", "en-GB")
const storedCategories = resolveOvertureCategories("supermarket")

console.log(matches)
console.log(storedCategories.includes("grocery_store")) // true
```

`lookupPOICategory` matches a complete phrase after lowercasing and trimming.
It deduplicates by category, keeps the best confidence for each category and sorts
by descending confidence. Extract phrases from longer queries before calling it.

Unrestricted synonyms match at confidence `1`. Locale-restricted synonyms match
at `1` for an exact locale or `0.5` for a shared language. A restricted synonym
does not match an unknown locale.

## Category and brand APIs

| API                                 | Purpose                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `getPOICategory(id)`                | Return one category or `null`.                                                                              |
| `getAllCategories()`                | Enumerate the bundled taxonomy.                                                                             |
| `resolveOvertureCategories(id)`     | Map a canonical category to the Overture category IDs stored in a POI database. An unknown ID returns `[]`. |
| `requiresBuildLocalLayer(category)` | Report whether the category requires data available only in a local build.                                  |
| `lookupPOIBrand(text)`              | Match a complete brand name or alias, ignoring case and surrounding whitespace.                             |
| `resolveBrandName(text)`            | Return the best exact brand match or `null`.                                                                |
| `getBrand(wikidata)`                | Retrieve a brand by Wikidata ID.                                                                            |

Brand matches have confidence `1` and are ordered by observed row count, then
Wikidata ID. `getAllBrands()` enumerates the brand table.
`POI_TAXONOMY_VERSION`, `POI_BRAND_TABLE_VERSION` and
`POI_BRAND_SOURCE_LAYER` identify the bundled data and the brand table's source.

The package also exposes separate locale-normalized and typo lookup functions.
Their rules are implemented in [the lookup core](lib/lookup/core.ts).
The default exact lookup does not invoke them.

## Browser use

The root entry loads packaged JSON through Node filesystem helpers. For browser
code, import the factories from `@mailwoman/poi-taxonomy/table` and supply
parsed tables:

```ts
import { createPOITaxonomyLookup } from "@mailwoman/poi-taxonomy/table"
import type { POITaxonomyTable } from "@mailwoman/poi-taxonomy/types"

function createCategorySearch(table: POITaxonomyTable) {
	return createPOITaxonomyLookup(table)
}
```

`createPOIBrandLookup` provides the equivalent brand API. Both factories share
the matching implementation with the Node entry. JSON assets are exported at
`@mailwoman/poi-taxonomy/data/*.json`.

## Maintain the tables

The taxonomy generator combines the Overture category snapshot with
[`curated-overlay.json`](data/curated-overlay.json). Run it from the repository
root to regenerate the table from the local inputs:

```bash
node packages/poi-taxonomy/tools/generate-taxonomy.ts
```

Inspect [the generator](tools/generate-taxonomy.ts) before refreshing the upstream
snapshot or changing its version. Brand data is built from the POI database by
the gazetteer tools. See [the POI runbook](../../docs/engineering/reference/poi-layer-runbook.mdx).

```bash
yarn test --run packages/poi-taxonomy
```

## License

The package declares `AGPL-3.0-only OR LicenseRef-Commercial`.
