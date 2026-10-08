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
import type {
	LiveSearchState,
	LoadPOIRuntime,
	POIExplorerResult,
	POILiveSearch,
	POILiveSearchRequest,
	POIRuntime,
} from "#poi/types"

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
	 *
	 * @defaultValue `loadPOIRuntime`
	 */
	loadRuntime?: LoadPOIRuntime

	/**
	 * The live-search probe.
	 * Live search is unavailable when it is absent.
	 */
	runLiveSearch?: POILiveSearch

	/**
	 * Whether the probe can search for brand subjects by Wikidata ID, defaulting to
	 * false. enable it only for a server-side backend, since fetching every row for
	 * a brand over an HTTP range-request database is too slow.
	 */
	brandLiveSearch?: boolean

	/**
	 * The delay in milliseconds before the text is classified.
	 *
	 * @defaultValue `250`
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
	 * The classification for the current debounced text, `null` for empty text
	 * and while classification is pending.
	 */
	result: POIExplorerResult | null

	/**
	 * The live-search state for the current debounced text, `idle` until a search runs.
	 */
	liveSearch: LiveSearchState

	/**
	 * Whether a probe is wired and the subject supports live search with a non-empty place anchor.
	 */
	canSearchLive: boolean

	/**
	 * Starts a live search for the current subject.
	 * It starts no search when `canSearchLive` is false.
	 */
	searchLive: () => Promise<void>
}

function buildOverpass(
	runtime: POIRuntime,
	categoryID: string
): { overpassQL: string | null; overpassError: string | null } {
	const category = runtime.lookup.getPOICategory(categoryID)

	if (!category) {
		return { overpassQL: null, overpassError: null }
	}

	const intent: OverpassIntentLike = {
		subject: { kind: "category", categoryIDs: [categoryID] },
		anchor: null,
	}

	try {
		return {
			overpassQL: emitOverpassQL(intent, category.osmTag ? { osmTags: [category.osmTag] } : {}),
			overpassError: null,
		}
	} catch (error) {
		return { overpassQL: null, overpassError: error instanceof Error ? error.message : String(error) }
	}
}

/**
 * Classifies debounced query text as a POI category or brand request and runs live searches on demand.
 *
 * Each result is keyed to the query that produced it, live search requires a non-empty anchor.
 * Brands need `brandLiveSearch` plus a Wikidata ID.
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

			const matched = kindResult.kind === "poi_query" ? matchPOISubject(trimmed, null, runtime.lexicon) : null

			if (!matched) {
				setStoredResult({ query: trimmed, value: { kindResult, subject: null, overpassQL: null, overpassError: null } })

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
							wikidata: matched.match.wikidata || null,
							matchedPhrase: matched.match.matchedPhrase,
							confidence: matched.match.confidence,
							remainder: matched.remainder,
						},
						overpassQL: null,
						overpassError: null,
					},
				})

				return
			}

			const category = runtime.lookup.getPOICategory(matched.match.categoryID)

			if (!category) {
				setStoredResult({ query: trimmed, value: { kindResult, subject: null, overpassQL: null, overpassError: null } })

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
					...buildOverpass(runtime, matched.match.categoryID),
				},
			})
		})

		return () => {
			cancelled = true
		}
	}, [trimmedText, runtime])

	const result = storedResult?.query === trimmedText ? storedResult.value : null
	const liveSearch: LiveSearchState = storedLive?.query === trimmedText ? storedLive.state : { status: "idle" }

	const subject = result?.subject ?? null

	const subjectLiveCapable =
		subject !== null && (subject.kind === "brand" ? brandLiveSearch && subject.wikidata !== null : !subject.buildLocal)

	const canSearchLive = Boolean(
		runLiveSearch && runtime && subject && subjectLiveCapable && subject.remainder.trim().length > 0
	)

	const searchLive = useCallback(async () => {
		if (!runLiveSearch || !runtime || !subject || !subject.remainder.trim()) return

		let request: POILiveSearchRequest

		if (subject.kind === "brand") {
			if (!brandLiveSearch || !subject.wikidata) return
			request = { kind: "brand", brandName: subject.name, wikidata: subject.wikidata, anchor: subject.remainder }
		} else {
			if (subject.buildLocal) return

			request = {
				kind: "category",
				categoryID: subject.category.id,
				overtureCategoryIDs: runtime.lookup.resolveOvertureCategories(subject.category.id),
				anchor: subject.remainder,
			}
		}

		setStoredLive({ query: trimmedText, state: { status: "loading" } })

		try {
			const response = await runLiveSearch(request)

			if (response.status === "success") {
				setStoredLive({
					query: trimmedText,
					state: { status: "success", hits: response.hits, centerName: response.centerName },
				})
			} else if (response.status === "unplaced") {
				setStoredLive({
					query: trimmedText,
					state: { status: "error", message: `couldn't place "${response.anchor}"` },
				})
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
