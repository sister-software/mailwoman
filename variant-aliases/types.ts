/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the regional variant alias table.
 */

/**
 * The semantic kind of a variant — either a generic amenity category or a specific brand.
 *
 * - `amenity` aliases resolve to a category (`fuel`, `pharmacy`, `convenience`, ...). Several variants can map to the
 *   same category ("servo" and "petrol station" both → `fuel`).
 * - `brand` aliases resolve to a canonical brand name. Multiple regional variants of the same brand ("Macca's", "McDo",
 *   "Mickey D's", "マクド") all map to `McDonald's`.
 */
export type VariantKind = "amenity" | "brand"

export interface VariantAliasBase {
	/** The user-typed variant. Always lowercase for the lookup key (CJK preserved as-is). */
	variant: string
	/**
	 * BCP-47 locale tags where this variant is in active use. Used to gate lookups: only consider an alias when the
	 * detected locale matches one of these. A query in `en-US` won't match Australian "servo" because `en-AU` is not in
	 * `["en-US"]`.
	 */
	locales: ReadonlyArray<string>
	/**
	 * Free-form regional refinement within the locale (e.g. "NYC", "Kansai", "Quebec"). Not used for matching today;
	 * informational. A future enhancement could combine this with a coarse geolocation signal to further disambiguate.
	 */
	regionHint?: string
}

export interface AmenityAlias extends VariantAliasBase {
	kind: "amenity"
	/** Canonical amenity category (e.g. `fuel`, `pharmacy`, `convenience`, `alcohol`). */
	category: string
}

export interface BrandAlias extends VariantAliasBase {
	kind: "brand"
	/** Canonical brand display name (e.g. `McDonald's`, `7-Eleven`). */
	brand: string
}

export type VariantAlias = AmenityAlias | BrandAlias

export interface VariantAliasTable {
	version: string
	description: string
	aliases: ReadonlyArray<VariantAlias>
}

export interface AliasLookupResult {
	alias: VariantAlias
	/** Confidence in the match. 1.0 = exact locale match. 0.5 = relaxed (locale fallback to language). */
	confidence: number
}
