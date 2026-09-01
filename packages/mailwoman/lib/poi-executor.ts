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

/**
 * The compact read-time ancestry triple a result's `ancestry` carries — deepest-first, mirrors `POIResult.ancestry`.
 */
export interface POIAncestryEntry {
	placetype: string
	name: string
	wofID: number
}

export interface POIExecutorOpts {
	/**
	 * Absent = no poi.db configured (intent-only mode, today's Plan-2 behavior for non-build-local categories).
	 */
	lookup: POIExecutorLookup | undefined
	/**
	 * `@mailwoman/poi-taxonomy`'s `requiresBuildLocalLayer(getPOICategory(id)!)`, injected so this stays lexicon-free.
	 */
	requiresBuildLocal: (categoryID: string) => boolean
	/**
	 * `@mailwoman/poi-taxonomy`'s `resolveOvertureCategories(id)`, injected so this stays lexicon-free — maps a canonical
	 * seed category id to the Overture `taxonomy.primary` leaf ids a built `poi.db` actually stores (`supermarket` →
	 * `grocery_store`, …). The category branch probes the full leaf list and re-tags every hit back to the canonical seed
	 * id. Omitted ⇒ identity (`[categoryID]`), the pre-fan-out behavior — 21 of 23 seeds already equal their Overture
	 * leaf.
	 */
	resolveOvertureCategories?: (categoryID: string) => string[]
	/**
	 * Read-time WOF ancestry lookup (the poiQueryKind register row's second debt payment) — injected SYNCHRONOUSLY
	 * because this executor's return type (`POIIntentOutcome`, no Promise) is called synchronously from `poi-intent.ts`'s
	 * `deps.execute`. Absent = no reverse geocoder wired (missing admin gazetteer db, or `poiQueryKind: true` with no
	 * `poiDatabasePath`) — results carry no `ancestry` key at all (house meaning-of-zero: absence, not an empty array).
	 * `runtime-pipeline.ts` wires a `WOFReverseGeocoder`-backed sync adapter; this module never imports
	 * `@mailwoman/resolver-wof-sqlite` itself — stays pure/testable with a stub fn.
	 */
	reverseGeocode?: (latitude: number, longitude: number) => ReadonlyArray<POIAncestryEntry> | undefined
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
	const { lookup, requiresBuildLocal, reverseGeocode } = opts
	// Identity fallback: no injected resolver ⇒ the seed id IS its own Overture probe id.
	const resolveOvertureCategories = opts.resolveOvertureCategories ?? ((categoryID: string) => [categoryID])

	// Bound to `results.map`, so decoration is capped at whatever `limit` bounded the search — the ≤20-calls budget
	// (spec's default DEFAULT_LIMIT) falls out of that, not a separate cap here.
	const toResult = (hit: POISearchHit): POIResult => decorateAncestry(toPOIResult(hit), reverseGeocode)

	return (intent: POIIntent): POIIntentOutcome => {
		const { subject } = intent
		// EVERY category in the union, not any: a set with one member the shipped layer can answer is answerable, and
		// abstaining on it would report a build-local gap the search does not have.
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

			// Brand hits aren't category-scoped — keep whatever raw leaf id each row carries.
			return { type: "intent", intent, results: lookup.search(query).map(toResult) }
		}

		// Category branch: fan EVERY canonical seed id in the union out over its Overture leaves (`supermarket` →
		// grocery_store, …) and probe the lot in one search — `#searchKRing` unions the rows per cell and distance-sorts
		// the pool, so the answer is decided by the candidate ordering the reader already owns and no weight, boost or
		// per-category preference is applied here.
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
			// Re-tag every hit back to the canonical seed whose fan-out reached it, so a caller reads the id it could have
			// typed rather than the Overture leaf, and the board grades `results[0].categoryID` against a canonical seed.
			// A leaf the map does not carry keeps the id the reader gave it: the search probed only mapped leaves, so this
			// cannot fire on a real hit, and inventing a canonical id for one would report a category nothing searched.
			results: results.map((hit) => {
				const canonical = hit.categoryID === null ? undefined : canonicalByLeaf.get(hit.categoryID)

				return canonical === undefined ? toResult(hit) : { ...toResult(hit), categoryID: canonical }
			}),
		}
	}
}

/**
 * Overture leaf id → the canonical seed id whose fan-out reached it, over the whole union.
 *
 * Insertion order is the probe order, so the map's keys are the search's `categoryIDs` with duplicates removed — two
 * seeds rolling up into a shared leaf probe it once. That shared leaf keeps the FIRST seed that reached it, which is a
 * label for a row genuinely belonging to both and not a preference between them: the row is returned either way, and
 * its position in the answer is the distance sort's.
 */
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

/**
 * Decorate one result with its read-time ancestry — a no-op (result unchanged) when no `reverseGeocode` fn was wired,
 * when the fn comes back `undefined` for this particular coordinate (e.g. open ocean, outside gazetteer coverage), or
 * when it comes back an empty array. The empty-array case is defense in depth: `runtime-pipeline.ts`'s
 * `buildSyncReverseGeocode` already collapses `hierarchy: []` to `undefined`, but a bare truthy check here would still
 * let a length-0 array from some OTHER `reverseGeocode` implementation (e.g. a test stub) slip through as "present" —
 * `[]` is truthy. The `ancestry` key is only ever added, never set to `undefined` or `[]` (house meaning-of-zero
 * style).
 */
function decorateAncestry(result: POIResult, reverseGeocode: POIExecutorOpts["reverseGeocode"]): POIResult {
	if (!reverseGeocode) return result
	const ancestry = reverseGeocode(result.latitude, result.longitude)

	return ancestry && ancestry.length ? { ...result, ancestry } : result
}

/**
 * Spatial anchor for the search: the anchor tree's DEEPEST node carrying a resolved centroid (walking roots + one level
 * of children — the resolver decorates `lat`/`lon` on the nodes it wins, Phase 4.3), else the caller-supplied
 * `biasPoint` ("near me"), else undefined (category/brand callers abstain on this; name callers search un-anchored).
 *
 * Exported because an observer reading a finished outcome has to name the point the search was CENTRED ON, and the
 * outcome does not carry it. A second copy of this walk would answer a neighbouring coordinate whenever the anchor tree
 * carries more than one geo node, and the observer would then attribute the answer to the wrong cell — a wrong reading
 * of a correct search, which is indistinguishable downstream from a correct reading.
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
 * One level deep beats a root: a child's centroid is more specific than its parent's.
 */
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
		gersID: hit.gersID,
		...(hit.distanceM !== undefined ? { distanceM: hit.distanceM } : {}),
	}
}
