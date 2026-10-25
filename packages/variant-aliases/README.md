# @mailwoman/variant-aliases

This package maps regional amenity and brand expressions to canonical values using a detected locale.

Public library. Install with `npm install @mailwoman/variant-aliases`.

## Quick start

```ts
import { lookupVariantAliases } from "@mailwoman/variant-aliases"

const matches = lookupVariantAliases("servo", "en-AU")

for (const { alias, confidence } of matches) {
	const value = alias.kind === "amenity" ? alias.category : alias.brand
	console.log(value, confidence) // fuel 1
}
```

An amenity alias supplies a category, such as `fuel`. A brand alias supplies a
display name, such as `McDonald's`. The caller chooses how to use multiple
matches.

## Lookup behavior

The lookup trims surrounding whitespace and lowercases the query. It matches
the entire resulting phrase against the bundled table. It does not extract
phrases from a longer query or perform fuzzy matching.

| Locale relationship    | Result            |
| ---------------------- | ----------------- |
| Exact locale tag       | Confidence `1`.   |
| Shared language subtag | Confidence `0.5`. |
| Different language     | No match.         |

For example, `servo` with `en-US` can still match the Australian entry through
the language fallback, at confidence `0.5`. Locale comparison is case-sensitive.
Use consistently cased tags such as `en-AU`. A `regionHint` is descriptive
metadata and does not filter results.

## API and data

- `lookupVariantAliases(text, locale)` returns all matches in descending confidence order.
- `resolveLocaleScope(locales, locale)` exposes the shared locale comparison. A `null` locale list is unrestricted, while a scoped entry with no detected locale returns `null`.
- `getAllAliases()` returns the bundled records.
- `VARIANT_ALIAS_VERSION` identifies the data version.

The Node entry loads [`data/aliases.json`](data/aliases.json) at module
initialization. Treat returned table records as read-only. When editing the
table, update its version and exercise the lookup tests:

```bash
yarn test --run packages/variant-aliases
```

The [POI taxonomy package](../poi-taxonomy) provides category and brand lookup
over its own tables.

## License

The package declares `AGPL-3.0-only OR LicenseRef-Commercial`.
