/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-safe entry: the same phrase → category matching as `lookup.ts`, bound to a table the CALLER supplies
 *   instead of one loaded via `node:fs`. Zero node imports — bundler-safe (e.g. the docs tester imports
 *   `data/taxonomy.json` via webpack and injects it here).
 */

import { createLookupCore } from "./lookup-core.ts"
import type { POITaxonomyTable } from "./types.ts"

export type { CategoryMatch, POITaxonomyLookup } from "./lookup-core.ts"

/**
 * Builds a {@link POITaxonomyLookup} bound to `table`. Throws when a synonym's `categoryID` points at an unknown
 * category — same integrity check as the node entry, just run against whatever table the caller injects.
 */
export function createPOITaxonomyLookup(table: POITaxonomyTable) {
	return createLookupCore(table)
}
