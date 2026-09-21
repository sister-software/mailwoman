/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phrase → brand lookup over `data/brands.json` — the QID-keyed chain-brand table built from a real
 *   `poi.db` by `mailwoman/gazetteer-pipeline/poi/build-brands.ts` (`mailwoman gazetteer build
 *   poi-brands`). Same loader + module-level-singleton shape as `lookup.ts`'s category lookup.
 *
 *   Matching is exact-phrase only, no locale filtering (brand names aren't a locale-synonym concern the way
 *   "chemist"/"drugstore" are) — see `brands-lookup-core.ts` for the shared matching core with the
 *   browser-safe `./table` entry.
 *
 *   Variant aliases are composed by the runtime, keeping these independently published packages separate.
 */

import { createBrandLookupCore } from "#brands/lookup-core"
import { readPackagedTable } from "#packaged-data"
import type { BrandRecord, POIBrandSourceLayer, POIBrandTable } from "#types"

const TABLE = await readPackagedTable<POIBrandTable>("brands.json")
const CORE = createBrandLookupCore(TABLE)

export type { BrandMatch } from "#brands/lookup-core"

/**
 * Exact-phrase brand lookup against `name` + `aliases`.
 *
 * Confidence is always 1.0 (exact match only).
 * Deduplicated by brand, sorted by `rows` descending — ties broken by `wikidata`.
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
