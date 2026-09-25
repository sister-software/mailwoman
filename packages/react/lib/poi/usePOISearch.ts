/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { matchPOISubject } from "@mailwoman/kind-classifier"
import { emitOverpassQL } from "@mailwoman/poi-taxonomy/overpass"
import type { OverpassIntentLike } from "@mailwoman/poi-taxonomy/overpass"
import { computeQueryShape } from "@mailwoman/query-shape"
import { useCallback, useEffect, useEffectEvent, useState } from "react"

import { useDebouncedValue } from "#common/useDebouncedValue"
import { loadPOIRuntime } from "#poi/runtime"
import type { LiveSearchState, LoadPOIRuntime, POIExplorerResult, POILiveSearch, POIRuntime } from "#poi/types"

/**
 * Options for {@link usePOISearch}.
 */
export interface UsePOISearchOptions {
	/**
	 * The current query text, owned and updated by the caller.
	 */
	text: string

	/**
	 * The loader that the hook calls once on mount.
	 * It defaults to `loadPOIRuntime`.
	 */
	loadRuntime?: LoadPOIRuntime

	/**
	 * The live-search probe.
	 * Live search is unavailable when it is absent.
	 */
	runLiveSearch?: POILiveSearch

	/**
	 * Whether the probe can search for brand subjects by Wikidata ID.
	 * It defaults to false.
	 *
	 * Enable it only for a server-side backend.
	 * Fetching every row for a brand over an HTTP range-request database is too slow.
	 */
	brandLiveSearch?: boolean

	/**
	 * The delay in milliseconds before the text is classified.
	 * It defaults to 250.
	 */
	debounceMs?: number
}

/**
 * The state that {@link usePOISearch} returns.
 */
export interface UsePOISearch {
	/**
	 * True once the taxonomy runtime has loaded.
	 */
	runtimeReady: boolean

	/**
	 * The classification for the current debounced text.
	 *
	 * It is null for empty text and while classification is pending.
	 */
	result: POIExplorerResult | null

	/**
	 * The live-search state for the current debounced text.
	 * It stays `idle` until a search runs.
	 */
	liveSearch: LiveSearchState

	/**
	 * Whether a probe is wired and the subject supports live search with a non-empty place anchor.
	 */
	canSearchLive: boolean

	/**
	 * Starts a live search for the current subject.
	 * It does nothing when `canSearchLive` is false.
	 */
	searchLive: () => Promise<void>
}

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

/**
 * Classifies debounced query text as a POI category or brand request and runs live searches on demand.
 *
 * Each result is keyed to the query that produced it, so the hook never shows a stale result for newer text.
 * Live search requires a non-empty anchor.
 *
 * It is unavailable for categories that need a locally built layer.
 * It is available for brands only when `brandLiveSearch` is set and the brand has a Wikidata ID.
 */
export function usePOISearch({
	text,
	loadRuntime = loadPOIRuntime,
	runLiveSearch,
	brandLiveSearch = false,
	debounceMs = 250,
}: UsePOISearchOptions): UsePOISearch {
	const [runtime, setRuntime] = useState<POIRuntime | null>(null)

	const [storedResult, setStoredResult] = useState<{ query: string; value: POIExplorerResult } | null>(null)

	const [storedLive, setStoredLive] = useState<{ query: string; state: LiveSearchState } | null>(null)

	const debouncedText = useDebouncedValue(text, debounceMs)
	const trimmedText = debouncedText.trim()

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

	const result = storedResult?.query === trimmedText ? storedResult.value : null
	const liveSearch: LiveSearchState = storedLive?.query === trimmedText ? storedLive.state : { status: "idle" }

	const subject = result?.subject

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
