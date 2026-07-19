/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the POI category taxonomy. Categories come from two namespaces: the Overture Places
 *   `taxonomy` snapshot (shipped-tier data; the old `categories` property is dead as of Overture's
 *   Sept 2026 release, so ONLY the new property is modeled), and the `mailwoman-infra` extension
 *   for street-furniture/infrastructure classes that exist only in ODbL sources (fire hydrants,
 *   post boxes) — recognized by the lexicon even when no build-local layer is present.
 */

declare const POICategoryIDBrand: unique symbol

/** A category id, e.g. `hospital`, `gas_station`, `fire_hydrant`. Branded — cast via {@link toPOICategoryID}. */
export type POICategoryID = string & { readonly [POICategoryIDBrand]: true }

/** Brand a raw string as a {@link POICategoryID}. Purely a compile-time assertion. */
export function toPOICategoryID(id: string): POICategoryID {
	return id as POICategoryID
}

/** Which namespace a category belongs to. */
export const CategorySource = {
	/** The Overture Places `taxonomy` snapshot (CDLA-Permissive-2.0). */
	Overture: "overture",
	/** Mailwoman's infrastructure extension — data lives only in build-local (ODbL) layers. */
	MailwomanInfra: "mailwoman-infra",
} as const
export type CategorySource = (typeof CategorySource)[keyof typeof CategorySource]

/** One category node. */
export interface CategoryRecord {
	id: POICategoryID
	/** Human-readable display label, e.g. `Gas station`. */
	label: string
	/** Ordered ancestry, top level first, ENDING with this category's own id. */
	hierarchy: POICategoryID[]
	/** Overture "basic category" display tier, when the snapshot provides one. */
	basicLabel: string | null
	/**
	 * The OSM tag this category maps to, `key=value` form (e.g. `amenity=hospital`) — consumed by the OverpassQL export
	 * emitter. Curated alongside the category; NOT an Overture field.
	 */
	osmTag?: string
	source: CategorySource
}

/** One lexicon entry mapping a query phrase to a category. */
export interface SynonymEntry {
	/** The phrase as typed, lowercase, e.g. `drinking fountain`. */
	phrase: string
	categoryID: POICategoryID
	/**
	 * BCP-47 locale gate, same semantics as `@mailwoman/variant-aliases`: omitted = ungated (matches any locale at
	 * confidence 1.0); present = 1.0 on exact locale, 0.5 on language-only.
	 */
	locales?: string[]
}

/** The on-disk shape of `data/taxonomy.json`. */
export interface POITaxonomyTable {
	version: string
	/** Overture release the category snapshot was taken from; null until Plan 3 lands the full snapshot. */
	overtureRelease: string | null
	categories: CategoryRecord[]
	synonyms: SynonymEntry[]
}

declare const POIBrandWikidataIDBrand: unique symbol

/** A brand's Wikidata QID, e.g. `Q38076` (McDonald's). Branded — cast via {@link toPOIBrandWikidataID}. */
export type POIBrandWikidataID = string & { readonly [POIBrandWikidataIDBrand]: true }

/** Brand a raw string as a {@link POIBrandWikidataID}. Purely a compile-time assertion. */
export function toPOIBrandWikidataID(id: string): POIBrandWikidataID {
	return id as POIBrandWikidataID
}

/**
 * One brand, aggregated from a built `poi.db`'s `(brand_wikidata, name)` pairs (see
 * `mailwoman/gazetteer-pipeline/poi/build-brands.ts`).
 */
export interface BrandRecord {
	wikidata: POIBrandWikidataID
	/** The modal (most-frequently observed) name variant. */
	name: string
	/** Other observed name variants clearing the build's noise floor, e.g. `["McDonalds", "Mc Donald's"]`. */
	aliases: string[]
	/** Total `poi.db` rows carrying this QID, across every observed name variant. */
	rows: number
}

/** Which built layer a {@link POIBrandTable} was aggregated from — the layer manifest's own identity fields. */
export interface POIBrandSourceLayer {
	/** The layer's manifest name, e.g. `poi`. */
	name: string
	/** The layer manifest's own `version` field. */
	version: string
	/** The layer manifest's `sourceVintage`, e.g. an Overture release string. */
	sourceVintage: string
}

/** The on-disk shape of `data/brands.json`. */
export interface POIBrandTable {
	/** The brand TABLE's own schema/data version — independent of {@link POIBrandSourceLayer.version}. */
	version: string
	sourceLayer: POIBrandSourceLayer
	brands: BrandRecord[]
}
