/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   POI intent executor (spec §3.4) — turns a `POIIntent` into results by querying a `POILookup`
 *   (`@mailwoman/resolver-wof-sqlite/poi-lookup`), or into one of two abstain outcomes when the query
 *   can't be answered as asked. Injectable + pure: no `@mailwoman/poi-taxonomy` import here — the
 *   `requiresBuildLocal` predicate and the `POILookup` instance are both handed in by the caller
 *   (`runtime-pipeline.ts`'s wiring), so this module stays testable with a stub lookup and a fake
 *   predicate, no sqlite or taxonomy data required.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import type { POIIntent, POIIntentOutcome, POIResult } from "@mailwoman/core/pipeline"
import type { POISearchHit, POISearchQuery } from "@mailwoman/resolver-wof-sqlite/poi-lookup"

/**
 * The executor's view of a POI lookup — just the `search` method, not the full `POILookup` class. `POILookup` carries
 * private (`#`) fields, which makes the class type non-structural: a plain stub object can't satisfy it, only a real
 * instance can. Narrowing to this one-method shape keeps the executor unit-testable with a stub while any real
 * `POILookup` instance still satisfies it (its `search` signature matches exactly).
 */
export interface POIExecutorLookup {
	search(query: POISearchQuery): POISearchHit[]
}

export interface POIExecutorOpts {
	/** Absent = no poi.db configured (intent-only mode, today's Plan-2 behavior for non-build-local categories). */
	lookup: POIExecutorLookup | undefined
	/** `@mailwoman/poi-taxonomy`'s `requiresBuildLocalLayer(getPOICategory(id)!)`, injected so this stays lexicon-free. */
	requiresBuildLocal: (categoryID: string) => boolean
}

/**
 * Build the `execute` fn `createPOIIntentStage` runs after a subject match. Abstain precedence:
 *
 * 1. `requires_build_local_layer` — a build-local category with no local rows. Fires with NO lookup configured at all
 *    (trivially: no db, no local rows possible) as well as with a lookup present that comes back empty for the
 *    category.
 * 2. `anchor_required` — a category/brand subject with a lookup present but no resolvable center (name subjects don't need
 *    one; the FTS path searches un-anchored).
 * 3. No lookup + non-build-local subject → the bare intent, unchanged (intent-only mode).
 * 4. Otherwise: run `lookup.search(...)` and attach the mapped results.
 */
export function createPOIExecutor(opts: POIExecutorOpts): (intent: POIIntent) => POIIntentOutcome {
	const { lookup, requiresBuildLocal } = opts

	return (intent: POIIntent): POIIntentOutcome => {
		const { subject } = intent
		const buildLocalCategory = subject.kind === "category" && requiresBuildLocal(subject.categoryID)

		if (buildLocalCategory && !lookup) {
			return { type: "abstain", reason: "requires_build_local_layer" }
		}

		if (!lookup) {
			return { type: "intent", intent }
		}

		if (subject.kind === "name") {
			const results = lookup.search({ name: subject.text, center: resolveCenter(intent), limit: intent.limit })

			return { type: "intent", intent, results: results.map(toPOIResult) }
		}

		const center = resolveCenter(intent)

		if (!center) {
			return { type: "abstain", reason: "anchor_required" }
		}

		const query: POISearchQuery =
			subject.kind === "brand"
				? subject.wikidata
					? { brandWikidata: subject.wikidata, center, limit: intent.limit }
					: { name: subject.name, center, limit: intent.limit }
				: { categoryID: subject.categoryID, center, limit: intent.limit }

		const results = lookup.search(query)

		if (buildLocalCategory && results.length === 0) {
			return { type: "abstain", reason: "requires_build_local_layer" }
		}

		return { type: "intent", intent, results: results.map(toPOIResult) }
	}
}

/**
 * Spatial anchor for the search: the anchor tree's DEEPEST node carrying a resolved centroid (walking roots + one level
 * of children — the resolver decorates `lat`/`lon` on the nodes it wins, Phase 4.3), else the caller-supplied
 * `biasPoint` ("near me"), else undefined (category/brand callers abstain on this; name callers search un-anchored).
 */
function resolveCenter(intent: POIIntent): { latitude: number; longitude: number } | undefined {
	const tree = intent.anchor?.tree

	if (tree) {
		const node = deepestGeoNode(tree.roots)

		if (node) return { latitude: node.lat!, longitude: node.lon! }
	}

	return intent.anchor?.biasPoint
}

/** One level deep beats a root: a child's centroid is more specific than its parent's. */
function deepestGeoNode(roots: AddressNode[]): AddressNode | undefined {
	for (const root of roots) {
		for (const child of root.children) {
			if (typeof child.lat === "number" && typeof child.lon === "number") return child
		}
	}

	return roots.find((root) => typeof root.lat === "number" && typeof root.lon === "number")
}

/**
 * `POISearchHit` → `POIResult`: field-compatible but a foreign type (from `@mailwoman/resolver-wof-sqlite`) — mapped
 * explicitly, never spread.
 */
function toPOIResult(hit: POISearchHit): POIResult {
	return {
		name: hit.name,
		categoryID: hit.categoryID,
		brandWikidata: hit.brandWikidata,
		latitude: hit.latitude,
		longitude: hit.longitude,
		country: hit.country,
		confidence: hit.confidence,
		...(hit.distanceM !== undefined ? { distanceM: hit.distanceM } : {}),
	}
}
