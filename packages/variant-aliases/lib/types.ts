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

interface VariantAliasBase {
	/**
	 * The user-typed variant. Always lowercase for the lookup key (CJK preserved as-is).
	 */
	variant: string
	/**
	 * BCP-47 locale tags where this variant is in active use. Used to filter lookups: only consider an alias when the
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
	/**
	 * Canonical amenity category (e.g. `fuel`, `pharmacy`, `convenience`, `alcohol`).
	 */
	category: string
}

export interface BrandAlias extends VariantAliasBase {
	kind: "brand"
	/**
	 * Canonical brand display name (e.g. `McDonald's`, `7-Eleven`).
	 */
	brand: string
}

export type VariantAlias = AmenityAlias | BrandAlias

export interface VariantAliasTable {
	version: string
	description: string
	aliases: ReadonlyArray<VariantAlias>
}

/**
 * How a record's locale scope met the locale a query was read under.
 *
 * - `unscoped` — the record declares no locales and answers under any.
 * - `exact` — the query's locale tag is one the record declares.
 * - `language` — only the language subtag agrees. Weaker on purpose: a regional phrasing reached through its language
 *   alone is a guess about the region.
 */
export type LocaleScope = "unscoped" | "exact" | "language"

/**
 * One locale-scoped record matched under one locale.
 */
export interface LocaleScopeMatch {
	scope: LocaleScope
	/**
	 * `1` for `unscoped` and `exact`, `0.5` for `language`.
	 */
	confidence: number
}

export interface AliasLookupResult {
	alias: VariantAlias
	/**
	 * Confidence in the match. 1.0 = exact locale match. 0.5 = relaxed (locale fallback to language).
	 */
	confidence: number
}
