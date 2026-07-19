/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phrase → brand lookup over `data/brands.json` — the QID-keyed chain-brand table built from a real
 *   `poi.db` by `mailwoman/gazetteer-pipeline/poi/build-brands.ts` (`mailwoman gazetteer build
 *   poi-brands`). Same loader + module-level-singleton shape as `lookup.ts`'s category lookup.
 *
 *   Matching is exact-phrase only, no locale gating (brand names aren't a locale-synonym concern the way
 *   "chemist"/"drugstore" are) — see `brands-lookup-core.ts` for the shared matching core with the
 *   browser-safe `./table` entry.
 *
 *   Deliberately NOT wired to `@mailwoman/variant-aliases` here — that would couple two independently
 *   published packages. {@link resolveBrandName} exists so a caller (the mailwoman runtime wiring, part 2
 *   of the brand-lexicon work) can chain `variant-aliases` → this table itself.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { createBrandLookupCore } from "./brands-lookup-core.ts"
import type { BrandRecord, POIBrandSourceLayer, POIBrandTable } from "./types.ts"

const moduleDir = import.meta.dirname

function loadBrandTable(): POIBrandTable {
	const candidates = [
		resolve(moduleDir, "data/brands.json"),
		resolve(moduleDir, "../data/brands.json"),
		resolve(moduleDir, "../../poi-taxonomy/data/brands.json"),
	]

	for (const path of candidates) {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as POIBrandTable
		} catch {
			// try next
		}
	}
	throw new Error("poi-taxonomy: could not find data/brands.json")
}

const TABLE = loadBrandTable()
const CORE = createBrandLookupCore(TABLE)

export type { BrandMatch } from "./brands-lookup-core.ts"

/**
 * Exact-phrase brand lookup against `name` + `aliases`. Confidence is always 1.0 (exact match only). Deduplicated by
 * brand, sorted by `rows` descending — ties broken by `wikidata`.
 */
export function lookupPOIBrand(text: string) {
	return CORE.lookupPOIBrand(text)
}

/** The single best (highest-`rows`) brand for an exact-phrase match, if any — the chaining seam for part 2. */
export function resolveBrandName(name: string): BrandRecord | undefined {
	return CORE.resolveBrandName(name)
}

/** Fetch a brand by its Wikidata QID. */
export function getBrand(wikidata: string): BrandRecord | undefined {
	return CORE.getBrand(wikidata)
}

/** Enumerate the full table (corpus synthesis, builders, docs). */
export function getAllBrands(): ReadonlyArray<BrandRecord> {
	return CORE.getAllBrands()
}

export const POI_BRAND_TABLE_VERSION = TABLE.version
export const POI_BRAND_SOURCE_LAYER: POIBrandSourceLayer = TABLE.sourceLayer
