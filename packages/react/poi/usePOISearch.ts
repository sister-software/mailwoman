/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usePOISearch` — the headless core of the POI explorer. Owns the taxonomy-runtime load, the
 *   debounced classify → subject → OverpassQL derivation, and the "Search live" state machine. The
 *   runtime loader and the live-search probe are both INJECTABLE, so stories/tests drive it with mocks
 *   and no network or db. Presentation is entirely the caller's concern.
 */

import { matchPOISubject } from "@mailwoman/kind-classifier"
import { emitOverpassQL } from "@mailwoman/poi-taxonomy/overpass"
import type { OverpassIntentLike } from "@mailwoman/poi-taxonomy/overpass"
import { computeQueryShape } from "@mailwoman/query-shape"
import { useCallback, useEffect, useEffectEvent, useState } from "react"

import { useDebouncedValue } from "../common/useDebouncedValue.ts"
import { loadPOIRuntime } from "./runtime.ts"
import type { LiveSearchState, LoadPOIRuntime, POIExplorerResult, POILiveSearch, POIRuntime } from "./types.ts"

export interface UsePOISearchOptions {
	/**
	 * The current query text (controlled by the caller).
	 */
	text: string
	/**
	 * Runtime loader. @default loadPOIRuntime
	 */
	loadRuntime?: LoadPOIRuntime
	/**
	 * Injected live-search probe. Absent ⇒ the live-results affordance is disabled.
	 */
	runLiveSearch?: POILiveSearch
	/**
	 * Whether the injected probe can serve BRAND subjects (fetch by Wikidata QID). Default false: brand subjects show the
	 * intent + QID chip but no live-search affordance. The docs' httpvfs probe leaves this off — brand-wide row hydration
	 * is pathological over byte-range (measured) — so brand live search is a server-side-backend capability. Category
	 * live search is unaffected either way.
	 */
	brandLiveSearch?: boolean
	/**
	 * Debounce before (re)classifying. @default 250
	 */
	debounceMs?: number
}

export interface UsePOISearch {
	/**
	 * True once the taxonomy runtime has loaded.
	 */
	runtimeReady: boolean
	/**
	 * The intent result for the current (debounced) query, or null for empty input.
	 */
	result: POIExplorerResult | null
	/**
	 * State of the on-demand live poi.db search.
	 */
	liveSearch: LiveSearchState
	/**
	 * Whether a live search can run right now (a probe is wired + there's a resolved subject with an anchor).
	 */
	canSearchLive: boolean
	/**
	 * Kick off a live search for the current subject. No-op when {@link canSearchLive} is false.
	 */
	searchLive: () => Promise<void>
}

/**
 * Compute the OverpassQL export for a matched subject, capturing any emitter error rather than throwing.
 */
function buildOverpass(
	runtime: POIRuntime,
	categoryID: string,
	matchedPhrase: string,
	remainder: string
): { overpassQL?: string; overpassError?: string } {
	const category = runtime.lookup.getPOICategory(categoryID)

	if (!category) {
		return {}
	}

	const intent: OverpassIntentLike = {
		subject: { kind: "category", categoryIDs: [categoryID], matched: matchedPhrase },
		...(remainder ? { anchor: { text: remainder } } : {}),
	}

	try {
		return { overpassQL: emitOverpassQL(intent, category.osmTag ? { osmTags: [category.osmTag] } : {}) }
	} catch (error) {
		return { overpassError: error instanceof Error ? error.message : String(error) }
	}
}

export function usePOISearch({
	text,
	loadRuntime = loadPOIRuntime,
	runLiveSearch,
	brandLiveSearch = false,
	debounceMs = 250,
}: UsePOISearchOptions): UsePOISearch {
	const [runtime, setRuntime] = useState<POIRuntime | null>(null)
	/**
	 * The classify result KEYED BY the query that produced it. The visible result is derived during render
	 * (`storedResult.query === trimmedText ? … : null`), so a new query invalidates the old answer by derivation — the
	 * effect never writes state synchronously to "reset", which is the react(set-state-in-effect) shape the lint bump
	 * rightly flags.
	 */
	const [storedResult, setStoredResult] = useState<{ query: string; value: POIExplorerResult } | null>(null)
	/**
	 * Live-search state, keyed the same way: launched FOR a query, visible only while that query stands.
	 */
	const [storedLive, setStoredLive] = useState<{ query: string; state: LiveSearchState } | null>(null)

	const debouncedText = useDebouncedValue(text, debounceMs)
	const trimmedText = debouncedText.trim()

	// The load fires exactly ONCE on mount regardless of whether the caller passes a fresh `loadRuntime`
	// closure each render (an inline `async () => …` would otherwise retrigger the effect → reload →
	// re-render loop). `useEffectEvent` reads the LATEST closure without joining the dependency list —
	// the runtime is a load-once resource.
	const loadRuntimeEvent = useEffectEvent(() => loadRuntime())

	useEffect(() => {
		let cancelled = false

		void loadRuntimeEvent().then((loaded) => {
			if (!cancelled) {
				setRuntime(loaded)
			}
		})

		return () => {
			cancelled = true
		}
	}, [])

	// Classify the debounced query and derive the subject + OverpassQL (async, so it lives in an effect).
	// Every state write below happens after an await — invalidation on query change is handled by the
	// key derivation above, not by a synchronous reset here.
	useEffect(() => {
		if (!runtime) return

		const trimmed = trimmedText

		if (!trimmed) return

		let cancelled = false

		const input = { raw: trimmed, normalized: trimmed }
		const shape = computeQueryShape(trimmed)

		runtime.classify(input, shape).then((kindResult) => {
			if (cancelled) return

			const matched = kindResult.kind === "poi_query" ? matchPOISubject(trimmed, undefined, runtime.lexicon) : null

			if (!matched) {
				setStoredResult({ query: trimmed, value: { kindResult } })

				return
			}

			// Brand subject: the lexicon carries the brand's canonical name as `categoryID` + its Wikidata QID. No category
			// record, no OverpassQL (brands are searched by QID against the layer's `brand_wikidata` index, not OSM tags).
			if ((matched.match.kind ?? "category") === "brand") {
				setStoredResult({
					query: trimmed,
					value: {
						kindResult,
						subject: {
							kind: "brand",
							name: matched.match.categoryID,
							...(matched.match.wikidata ? { wikidata: matched.match.wikidata } : {}),
							matchedPhrase: matched.match.matchedPhrase,
							confidence: matched.match.confidence,
							remainder: matched.remainder,
						},
					},
				})

				return
			}

			const category = runtime.lookup.getPOICategory(matched.match.categoryID)

			if (!category) {
				setStoredResult({ query: trimmed, value: { kindResult } })

				return
			}

			setStoredResult({
				query: trimmed,
				value: {
					kindResult,
					subject: {
						kind: "category",
						category,
						matchedPhrase: matched.match.matchedPhrase,
						confidence: matched.match.confidence,
						remainder: matched.remainder,
						buildLocal: runtime.lookup.requiresBuildLocalLayer(category),
					},
					...buildOverpass(runtime, matched.match.categoryID, matched.match.matchedPhrase, matched.remainder),
				},
			})
		})

		return () => {
			cancelled = true
		}
	}, [trimmedText, runtime])

	// Derived visibility: an answer stands only while its query does. A new query reads as null/idle
	// with no reset write anywhere.
	const result = storedResult?.query === trimmedText ? storedResult.value : null
	const liveSearch: LiveSearchState = storedLive?.query === trimmedText ? storedLive.state : { status: "idle" }

	const subject = result?.subject

	// A subject is live-searchable when a probe is wired, it has an anchor, and: a CATEGORY that isn't build-local, or a
	// BRAND with a QID AND a brand-capable probe (`brandLiveSearch`). Brands without a QID / without a brand probe show
	// the intent + QID chip but no live affordance.
	const subjectLiveCapable =
		subject !== undefined &&
		(subject.kind === "brand" ? brandLiveSearch && subject.wikidata !== undefined : !subject.buildLocal)

	const canSearchLive = Boolean(
		runLiveSearch && runtime && subject && subjectLiveCapable && subject.remainder.trim().length > 0
	)

	const searchLive = useCallback(async () => {
		if (!runLiveSearch || !runtime || !subject || !subject.remainder.trim()) return

		if (subject.kind === "category" ? subject.buildLocal : !(brandLiveSearch && subject.wikidata)) return

		setStoredLive({ query: trimmedText, state: { status: "loading" } })

		try {
			const outcome = await runLiveSearch(
				subject.kind === "brand"
					? {
							categoryID: subject.name,
							overtureCategoryIDs: [],
							anchor: subject.remainder,
							brandWikidata: subject.wikidata,
						}
					: {
							categoryID: subject.category.id,
							// Fan the canonical seed id out over its Overture leaves — the same translation the Node reader uses.
							overtureCategoryIDs: runtime.lookup.resolveOvertureCategories(subject.category.id),
							anchor: subject.remainder,
						}
			)

			if (outcome.status === "success") {
				setStoredLive({
					query: trimmedText,
					state: { status: "success", hits: outcome.hits, centerName: outcome.centerName },
				})
			} else if (outcome.status === "unplaced") {
				setStoredLive({ query: trimmedText, state: { status: "error", message: `couldn't place "${outcome.anchor}"` } })
			} else {
				setStoredLive({
					query: trimmedText,
					state: { status: "error", message: "the published POI layer isn't reachable" },
				})
			}
		} catch {
			setStoredLive({
				query: trimmedText,
				state: { status: "error", message: "the published POI layer isn't reachable" },
			})
		}
	}, [runLiveSearch, runtime, subject, brandLiveSearch, trimmedText])

	return { runtimeReady: runtime !== null, result, liveSearch, canSearchLive, searchLive }
}
