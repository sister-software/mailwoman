/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import type { POIIntent, POIIntentOutcome, POIResult } from "@mailwoman/core/pipeline"
import type { POISearchHit, POISearchQuery } from "@mailwoman/resolver-wof-sqlite/poi"

/**
 * The single `POILookup` method that the executor calls.
 *
 * Test stubs implement this interface, because the class's private fields prevent structural matching.
 */
export interface POIExecutorLookup {
	search(query: POISearchQuery): POISearchHit[]
}

/**
 * One place in a POI result's `ancestry`, which lists places deepest first.
 */
export interface POIAncestryEntry {
	placetype: string
	name: string
	wofID: number
}

/**
 * Dependencies for {@link createPOIExecutor}.
 */
export interface POIExecutorOpts {
	/**
	 * The poi.db search.
	 *
	 * When it is `undefined`, the executor returns intents without searching.
	 */
	lookup: POIExecutorLookup | undefined

	/**
	 * Whether a category requires a locally built layer.
	 * It is injected so this module avoids the taxonomy lexicon.
	 */
	requiresBuildLocal: (categoryID: string) => boolean

	/**
	 * Maps a canonical category ID to the Overture leaf IDs stored in poi.db,
	 * such as `supermarket` to `grocery_store`.
	 *
	 * The category search probes every leaf and re-tags each hit with its canonical ID.
	 * The default maps each ID to itself.
	 */
	resolveOvertureCategories?: (categoryID: string) => string[]

	/**
	 * Looks up a result's WOF ancestry, deepest first.
	 * It must be synchronous.
	 *
	 * Results get no `ancestry` key when this function is missing or returns nothing.
	 */
	reverseGeocode?: (latitude: number, longitude: number) => ReadonlyArray<POIAncestryEntry> | undefined
}

/**
 * Builds the function that `createPOIIntentStage` calls to search for a matched POI subject.
 *
 * The executor abstains with `requires_build_local_layer` when a build-local
 * category has no lookup or no rows.
 * It abstains with `anchor_required` when a category or brand search has no center.
 */
export function createPOIExecutor(opts: POIExecutorOpts): (intent: POIIntent) => POIIntentOutcome {
	const { lookup, requiresBuildLocal, reverseGeocode } = opts

	const resolveOvertureCategories = opts.resolveOvertureCategories ?? ((categoryID: string) => [categoryID])

	const toResult = (hit: POISearchHit): POIResult => decorateAncestry(toPOIResult(hit), reverseGeocode)

	return (intent: POIIntent): POIIntentOutcome => {
		const { subject } = intent

		const buildLocalCategory = subject.kind === "category" && subject.categoryIDs.every(requiresBuildLocal)

		if (buildLocalCategory && !lookup) {
			return { type: "abstain", reason: "requires_build_local_layer" }
		}

		if (!lookup) {
			return { type: "intent", intent }
		}

		if (subject.kind === "name") {
			const results = lookup.search({
				name: subject.text,
				center: resolvePOISearchCenter(intent),
				limit: intent.limit,
			})

			return { type: "intent", intent, results: results.map(toResult) }
		}

		const center = resolvePOISearchCenter(intent)

		if (!center) {
			return { type: "abstain", reason: "anchor_required" }
		}

		if (subject.kind === "brand") {
			const query: POISearchQuery = subject.wikidata
				? { brandWikidata: subject.wikidata, center, limit: intent.limit }
				: { name: subject.name, center, limit: intent.limit }

			return { type: "intent", intent, results: lookup.search(query).map(toResult) }
		}

		const canonicalByLeaf = resolveCanonicalByLeaf(subject.categoryIDs, resolveOvertureCategories)

		const results = lookup.search({
			categoryIDs: [...canonicalByLeaf.keys()],
			center,
			limit: intent.limit,
		})

		if (buildLocalCategory && !results.length) {
			return { type: "abstain", reason: "requires_build_local_layer" }
		}

		return {
			type: "intent",
			intent,

			results: results.map((hit) => {
				const canonical = hit.categoryID === null ? undefined : canonicalByLeaf.get(hit.categoryID)

				return canonical === undefined ? toResult(hit) : { ...toResult(hit), categoryID: canonical }
			}),
		}
	}
}

function resolveCanonicalByLeaf(
	categoryIDs: ReadonlyArray<string>,
	resolveOvertureCategories: (categoryID: string) => string[]
): Map<string, string> {
	const canonicalByLeaf = new Map<string, string>()

	for (const canonical of categoryIDs) {
		for (const leaf of resolveOvertureCategories(canonical)) {
			if (!canonicalByLeaf.has(leaf)) {
				canonicalByLeaf.set(leaf, canonical)
			}
		}
	}

	return canonicalByLeaf
}

function decorateAncestry(result: POIResult, reverseGeocode: POIExecutorOpts["reverseGeocode"]): POIResult {
	if (!reverseGeocode) return result
	const ancestry = reverseGeocode(result.latitude, result.longitude)

	return ancestry && ancestry.length ? { ...result, ancestry } : result
}

/**
 * Returns the center of a POI search.
 *
 * The center is the first child of an anchor root with a coordinate, then the
 * first root with one, then the caller's `biasPoint`.
 * Observers call this function so that they read the same node as the search.
 */
export function resolvePOISearchCenter(intent: POIIntent): { latitude: number; longitude: number } | undefined {
	const tree = intent.anchor?.tree

	if (tree) {
		const node = deepestGeoNode(tree.roots)

		if (node) return { latitude: node.lat!, longitude: node.lon! }
	}

	return intent.anchor?.biasPoint
}

/**
 * Returns the uppercase country code of the POI search center, or `null` when the anchor tree has none.
 *
 * It reads the node that {@link resolvePOISearchCenter} uses and falls back to the roots.
 */
export function resolvePOIAnchorCountry(intent: POIIntent): string | null {
	const tree = intent.anchor?.tree

	if (!tree) return null

	const node = deepestGeoNode(tree.roots)

	const stamped = [node, ...tree.roots].find(
		(candidate) => typeof candidate?.metadata?.["resolver_country"] === "string"
	)

	const country = stamped?.metadata?.["resolver_country"]

	return typeof country === "string" && country.length ? country.toUpperCase() : null
}

function deepestGeoNode(roots: AddressNode[]): AddressNode | undefined {
	for (const root of roots) {
		for (const child of root.children) {
			if (typeof child.lat === "number" && typeof child.lon === "number") return child
		}
	}

	return roots.find((root) => typeof root.lat === "number" && typeof root.lon === "number")
}

function toPOIResult(hit: POISearchHit): POIResult {
	return {
		name: hit.name,
		categoryID: hit.categoryID,
		brandWikidata: hit.brandWikidata,
		latitude: hit.latitude,
		longitude: hit.longitude,
		country: hit.country,
		confidence: hit.confidence,
		gersID: hit.gersID,
		...(hit.distanceM !== undefined ? { distanceM: hit.distanceM } : {}),
	}
}
