/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phrase → category lookup over `data/taxonomy.json`. Same loader + locale-gating shape as
 *   `@mailwoman/variant-aliases` (its slang table resolves INTO these category ids). Matching is
 *   exact-phrase over a lowercased index; n-gram extraction from longer queries is the kind
 *   classifier's job, not this package's.
 *
 *   The pure index/matching core lives in `lookup-core.ts` and is shared with the browser-safe `./table` entry
 *   (`table.ts`) — this module only owns the `node:fs` load + the module-level singleton.
 */

import { createLookupCore } from "./lookup-core.ts"
import { readPackagedTable } from "./packaged-data.ts"
import type { CategoryRecord, POITaxonomyTable } from "./types.ts"

const TABLE = readPackagedTable<POITaxonomyTable>("taxonomy.json")
const CORE = createLookupCore(TABLE)

export type { CategoryMatch } from "./lookup-core.ts"

/**
 * Exact-phrase category lookup. `locale` gates locale-restricted synonyms with the variant-aliases semantics: exact
 * locale 1.0, language-only 0.5, otherwise no match. Ungated phrases always match at 1.0. Deduplicated by category
 * (best confidence wins), sorted by confidence descending.
 */
export function lookupPOICategory(text: string, locale?: string) {
	return CORE.lookupPOICategory(text, locale)
}

/**
 * Fetch a category by id.
 */
export function getPOICategory(id: string): CategoryRecord | undefined {
	return CORE.getPOICategory(id)
}

/**
 * Enumerate the full table (corpus synthesis, builders, docs).
 */
export function getAllCategories(): ReadonlyArray<CategoryRecord> {
	return CORE.getAllCategories()
}

/**
 * True when the category's data exists only in ODbL sources — answering needs a build-local layer.
 */
export function requiresBuildLocalLayer(category: CategoryRecord): boolean {
	return CORE.requiresBuildLocalLayer(category)
}

/**
 * Resolve a canonical seed category id to the Overture `taxonomy.primary` leaf ids a built `poi.db` stores for it. Seed
 * ids that declare no `overtureCategories` resolve to `[seedID]` (identity); an unknown seed id resolves to `[]`. The
 * POI executor fans a category query out over this list and re-tags the hits with the canonical seed id.
 */
export function resolveOvertureCategories(seedID: string): string[] {
	return CORE.resolveOvertureCategories(seedID)
}

/**
 * Version of the bundled POI category taxonomy, for cache keys and diagnostics.
 */
export const POI_TAXONOMY_VERSION = TABLE.version
