/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createBrandLookupCore } from "#brands/lookup-core"
import { readPackagedTable } from "#packaged-data"
import type { BrandRecord, POIBrandSourceLayer, POIBrandTable } from "#types"

const TABLE = await readPackagedTable<POIBrandTable>("brands.json")
const CORE = createBrandLookupCore(TABLE)

/**
 * Re-exports the result type of {@link lookupPOIBrand} so callers of the bundled
 * table need not import the lookup core.
 */
export type { BrandMatch } from "#brands/lookup-core"

/**
 * Finds the brands whose name or alias equals `text`, ignoring case and surrounding whitespace.
 *
 * Each brand appears once with confidence 1, and the matches are sorted by `rows`
 * descending with ties broken by Wikidata ID.
 */
export function lookupPOIBrand(text: string) {
	return CORE.lookupPOIBrand(text)
}

/**
 * The single best exact-phrase brand match, if any.
 */
export function resolveBrandName(name: string): BrandRecord | undefined {
	return CORE.resolveBrandName(name)
}

/**
 * Fetch a brand by its Wikidata QID.
 */
export function getBrand(wikidata: string): BrandRecord | undefined {
	return CORE.getBrand(wikidata)
}

/**
 * Enumerate the full table (corpus synthesis, builders, docs).
 */
export function getAllBrands(): ReadonlyArray<BrandRecord> {
	return CORE.getAllBrands()
}

/**
 * Version of the bundled POI brand table, for cache keys and diagnostics.
 */
export const POI_BRAND_TABLE_VERSION = TABLE.version

/**
 * Source layer the brand table was derived from, recorded so a consumer can tell which snapshot it has.
 */
export const POI_BRAND_SOURCE_LAYER: POIBrandSourceLayer = TABLE.sourceLayer
