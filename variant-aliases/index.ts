/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/variant-aliases` — regional variant alias table for amenity/brand queries.
 *
 *   The data file (`data/aliases.json`) catalogs ~35 hand-curated regional terms: "servo" → fuel
 *   (en-AU), "マクド" → McDonald's (ja-JP), "PFK" → KFC (fr-CA), etc.
 *
 *   See:
 *
 *   - `docs/articles/understanding/exotic-poi/regional-variant-queries.md` for the linguistic
 *       background and the source tables this data is derived from.
 *   - Issue #166 for the v0.6.0+ runtime integration plan (kind classifier consumes this table to emit
 *       `kind=amenity` / `kind=brand` proposals, gated by locale-gate output).
 */

export { VARIANT_ALIAS_VERSION, getAllAliases, lookupVariantAliases } from "./lookup.js"
export type {
	AliasLookupResult,
	AmenityAlias,
	BrandAlias,
	VariantAlias,
	VariantAliasTable,
	VariantKind,
} from "./types.js"
