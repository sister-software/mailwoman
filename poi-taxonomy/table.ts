/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-safe entry: the same phrase → category/brand matching as `lookup.ts`/`brands.ts`, bound to a table
 *   the CALLER supplies instead of one loaded via `node:fs`. Zero node imports — bundler-safe (e.g. the docs
 *   tester imports `data/taxonomy.json`/`data/brands.json` via webpack and injects them here).
 */

import { createBrandLookupCore } from "./brands-lookup-core.ts"
import { createLookupCore } from "./lookup-core.ts"
import type { POIBrandTable, POITaxonomyTable } from "./types.ts"

export type { CategoryMatch, POITaxonomyLookup } from "./lookup-core.ts"
export type { BrandMatch, POIBrandLookup } from "./brands-lookup-core.ts"

/**
 * Builds a {@link POITaxonomyLookup} bound to `table`. Throws when a synonym's `categoryID` points at an unknown
 * category — same integrity check as the node entry, just run against whatever table the caller injects.
 */
export function createPOITaxonomyLookup(table: POITaxonomyTable) {
	return createLookupCore(table)
}

/** Builds a {@link POIBrandLookup} bound to `table` — same matching semantics as the node entry's `brands.ts`. */
export function createPOIBrandLookup(table: POIBrandTable) {
	return createBrandLookupCore(table)
}
