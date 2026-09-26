/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `useGeocoderRuntime` — the app's runtime assembly. It builds the real {@link GeocoderRuntime} that
 * `@mailwoman/react/map`'s geocoder consumes, injecting the browser runtime's loaders into
 * `@mailwoman/react`'s `useReleaseRuntime` orchestration and wrapping the loaded assets with the map surface.
 *
 * This is application code on purpose: `@mailwoman/react` keeps its runtime hook free of the ONNX, httpvfs and
 * maplibre graph, and this assembly imports all three.
 */

import { StyleSpecificationComposer, MailwomanBaseTileSetID } from "@mailwoman/cartographer/base"
import { CoverageLayers, CoverageTileSetID, createCoverageSource } from "@mailwoman/cartographer/coverage"
import type { ParseResult, ParsedComponent, ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import type { AssetsLoadContext, ReleaseManifest } from "@mailwoman/react"
import { useReleaseRuntime } from "@mailwoman/react"
import type {
	MapCanvasStyle,
	GeocoderRuntime,
	MapBias,
	OverlaySpec,
	ResolvedMapPlace,
	Suggestion,
} from "@mailwoman/react/map"
import type { ResolveBias } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import { runCascade } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import {
	type HTTPVFSAddressPointLookup,
	type HTTPVFSInterpolator,
	resolveStreet,
	type StreetResolution,
} from "@mailwoman/resolver-wof-wasm/httpvfs/street"
import type { Coordinates2D } from "@mailwoman/spatial"
import {
	DEFAULT_LOCALE,
	parseStageLabelsFor,
	projectCascadeHits,
	resolveDualRoles,
	runClassifyStage,
} from "mailwoman/browser-runtime/classify"
import type { ReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import { loadReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import type { ReleaseInfo } from "mailwoman/browser-runtime/manifest"
import { fetchReleasesManifest } from "mailwoman/browser-runtime/manifest"
import {
	assetURL,
	HOSTED_STREET_SLUGS,
	NATIONAL_STREET_FALLBACK_SLUG,
	NATIONAL_STREET_SLUGS,
	regionToStateSlug,
	streetExtractURL,
} from "mailwoman/browser-runtime/resources"
import type { ParseTraceLike } from "mailwoman/browser-runtime/types"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { EarthConfig } from "#config"
import { loadPolygonDB, type PlaceGeometry, type PolygonDB } from "#runtime/basemap"
import { pruneDBRangeCache } from "#runtime/range-cache"
import { useGeoBias, type GeoBiasControl } from "#runtime/use/geo-bias"

/**
 * Per-region interp-radius conformal factor, with `INTERP_RADIUS_DEFAULT` for unmeasured regions.
 */
const INTERP_RADIUS_BY_REGION: Record<string, number> = { dc: 1.44, ny: 1.53, ca: 1.87, mi: 1.93 }
const INTERP_RADIUS_DEFAULT = 1.95

/**
 * Spans that together make up the street name — assembled in source order for the situs/interp query.
 */
const STREET_COMPONENT_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/**
 * Per-state street lookups loaded together, lazily by region; national (country) extracts carry no interp.
 */
interface StreetLookups {
	situs: HTTPVFSAddressPointLookup
	interp: HTTPVFSInterpolator | undefined
}

interface CandidateExtras {
	bbox?: ResolvedPlaceView["bbox"]
	tier?: "address_point" | "interpolated"
	uncertaintyM?: number
}

export interface GeocoderRuntimeHandle {
	runtime: GeocoderRuntime
	releases: ReleaseInfo[]
	forceWASM: boolean
	geoBias: GeoBiasControl
	calibrator: ((raw: number) => number | null) | undefined
	/**
	 * Resolves `null` when the classifier bundle predates the `traceParse` hook
	 * or the trace fails; feature-detect via {@link supportsTrace}.
	 */
	traceParse: (input: string) => Promise<ParseTraceLike | null>
	supportsTrace: boolean
}

export interface GeocoderRuntimeOptions {
	config: EarthConfig
	/**
	 * Initial map center as `[lon, lat]`.
	 */
	initialCenter: Coordinates2D
}

/**
 * Give a superseded bundle's native memory back; module scope rather than `useCallback`
 * because it closes over no state, so a stable identity is free and cannot churn the hook's effect.
 */
function disposeAssets(assets: ReleaseAssets): Promise<void> {
	return assets.release()
}

/**
 * Build the real {@link GeocoderRuntime} by injecting the browser runtime's
 * loaders into `useReleaseRuntime`.
 */
export function useGeocoderRuntime({ config, initialCenter }: GeocoderRuntimeOptions): GeocoderRuntimeHandle {
	const { sqljsBaseURL } = config

	const loadManifest = useCallback(
		async (): Promise<ReleaseManifest<ReleaseInfo> | null> => fetchReleasesManifest(),
		[]
	)

	const loadAssets = useCallback(
		(release: ReleaseInfo, ctx: AssetsLoadContext): Promise<ReleaseAssets> =>
			loadReleaseAssets(release, ctx, { gazetteer: { sqljsBaseURL } }),
		[sqljsBaseURL]
	)

	const rt = useReleaseRuntime<ReleaseAssets, ReleaseInfo>({ loadManifest, loadAssets, disposeAssets })

	useEffect(() => {
		if (rt.selectedVersion) {
			pruneDBRangeCache(rt.selectedVersion)
		}
	}, [rt.selectedVersion])

	const mapStyle = useMemo<MapCanvasStyle>(
		() =>
			new StyleSpecificationComposer({
				sources: { [MailwomanBaseTileSetID]: { type: "vector", url: String(config.basemapTileJSONURL) } },
			}).toJSON(),
		[config.basemapTileJSONURL]
	)

	/*
	 * These callbacks read `rt.assets` and name it as a dependency: a callback that parses
	 * with a bundle is not the same callback once the bundle changes, and a ref mirror lost
	 * a child-first effect race (a ref written during render is a value React may discard).
	 */

	const geoBias = useGeoBias()

	// Per-candidate map-render extras, keyed by the candidate object `useParsePipeline` hands back verbatim.
	const extrasRef = useRef<WeakMap<ResolvedPlaceView, CandidateExtras>>(new WeakMap())
	// Lazy street-tier situs/interp lookups, cached by parsed state/country slug (in-flight promise dedup).
	const streetLookupsRef = useRef<Map<string, Promise<StreetLookups>>>(new Map())
	// The cache is state rather than a ref so a landed polygon rebuilds `resolveMapPlace`
	// through `useGeocode`'s mapPlace memo; value `undefined` = unfetched,
	// `null` = fetched-absent (fall through to bbox), geometry = present.
	const polygonDBRef = useRef<Promise<PolygonDB> | null>(null)
	const polygonInflightRef = useRef<Set<number>>(new Set())
	const [polygonCache, setPolygonCache] = useState<Map<number, PlaceGeometry | null>>(() => new Map())

	// URLs are version-scoped, so reset polygon state on version change.
	useEffect(() => {
		polygonDBRef.current = null
		polygonInflightRef.current = new Set()
		// oxlint-disable-next-line react/set-state-in-effect -- Polygon IDs and cached geometry are scoped to the selected release.
		setPolygonCache(new Map())
	}, [rt.selectedVersion])

	const ensureStreetLookups = useCallback(
		async (slug: string): Promise<StreetLookups | null> => {
			let p = streetLookupsRef.current.get(slug)

			if (!p) {
				p = (async () => {
					const { loadHTTPVFSDatabase } = await import("@mailwoman/resolver-wof-wasm/httpvfs/resolver")

					const { HTTPVFSAddressPointLookup, HTTPVFSInterpolator } =
						await import("@mailwoman/resolver-wof-wasm/httpvfs/street")

					if (NATIONAL_STREET_SLUGS.has(slug)) {
						const situsW = await loadHTTPVFSDatabase(streetExtractURL(slug, "situs"), sqljsBaseURL)

						return { situs: new HTTPVFSAddressPointLookup(situsW, { streetLocale: slug as "fr" }), interp: undefined }
					}

					const [situsW, interpW] = await Promise.all([
						loadHTTPVFSDatabase(streetExtractURL(slug, "situs"), sqljsBaseURL),
						loadHTTPVFSDatabase(streetExtractURL(slug, "interp"), sqljsBaseURL),
					])

					return { situs: new HTTPVFSAddressPointLookup(situsW), interp: new HTTPVFSInterpolator(interpW) }
				})()

				p.catch(() => streetLookupsRef.current.delete(slug))
				streetLookupsRef.current.set(slug, p)
			}

			return p
		},
		[sqljsBaseURL]
	)

	const runParseWithBias = useCallback(
		async (input: string, bias: MapBias | null, hooks: { onStage: (stage: number) => void }): Promise<ParseResult> => {
			const assets = rt.assets
			const classifier = assets?.classifier

			if (!classifier) throw new Error("Classifier not ready")
			hooks.onStage(0)

			// The classify front half: pipeline import → query-shape/kind → neural runPipeline
			// → flatten, with `onStage(1)` firing between shape and classify.
			const { tree, nodes, kindResult, timing } = await runClassifyStage(
				input,
				{
					classifier,
					fst: assets?.fstMatcher,
					streetMorphology: assets?.streetMorphologyMatcher,
					selectPairIndex: assets?.selectPairIndex,
				},
				{ onClassifierStart: () => hooks.onStage(1) }
			)

			const localityNode = nodes.find((n) => n.tag === "locality")

			const stateNode = nodes
				.filter((n) => n.tag === "region")
				.toSorted((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]

			const postcodeNode = nodes.find((n) => n.tag === "postcode")

			let streetResolution: StreetResolution | null = null

			const streetParts = nodes
				.filter((n) => STREET_COMPONENT_TAGS.has(n.tag) && String(n.value ?? "").trim())
				.toSorted((a, b) => (a.start ?? 0) - (b.start ?? 0))

			const streetValue = streetParts.map((n) => String(n.value).trim()).join(" ")
			const houseNumberNode = nodes.find((n) => n.tag === "house_number")
			const stateSlug = regionToStateSlug(stateNode?.value as string | undefined)

			const streetSlug =
				stateSlug && HOSTED_STREET_SLUGS.has(stateSlug)
					? stateSlug
					: stateSlug
						? undefined
						: NATIONAL_STREET_FALLBACK_SLUG

			if (streetValue && houseNumberNode?.value && streetSlug) {
				try {
					const street = await ensureStreetLookups(streetSlug)

					if (street) {
						streetResolution = await resolveStreet(
							streetValue,
							String(houseNumberNode.value),
							postcodeNode?.value ? String(postcodeNode.value) : undefined,
							localityNode?.value ? String(localityNode.value) : undefined,
							street.situs,
							street.interp,
							INTERP_RADIUS_BY_REGION[streetSlug] ?? INTERP_RADIUS_DEFAULT
						)
					}
				} catch (error) {
					console.warn("[mailwoman earth] street tier unavailable; falling back to admin cascade", error)
				}
			}

			const asView = (nds: typeof nodes): ParsedComponent[] =>
				nds.map((n) => ({
					tag: n.tag || "unknown",
					value: n.value,
					confidence: n.confidence,
					start: n.start,
					end: n.end,
				}))

			const wofLookup = assets?.lookup ?? null

			if (!wofLookup) {
				return {
					input,
					tree,
					nodes: asView(nodes),
					resolved: null,
					candidates: [],
					kindResult,
					fstActive: assets?.fstMatcher != null,
					fstProvenance: assets?.fstProvenance ?? null,
					timing,
				}
			}

			hooks.onStage(2)

			// Open the polygon DB now (no await) so its worker spawn overlaps the cascade below.
			const release = rt.selectedRelease
			const version = rt.selectedVersion

			if (release?.hasPolygons && version && !polygonDBRef.current) {
				const loading = loadPolygonDB(assetURL(DEFAULT_LOCALE, version, "wof-polygons.db"), sqljsBaseURL)
				polygonDBRef.current = loading

				loading.catch(() => {
					if (polygonDBRef.current === loading) {
						polygonDBRef.current = null
					}
				})
			}

			// Viewport bias: the map center as a population-ceilinged soft proximity hint,
			// with a granted device location joining as a weaker second hint.
			const resolveBias: ResolveBias = []

			if (bias) {
				resolveBias.push({ lat: bias.center[1], lon: bias.center[0], weight: 1 })
			}

			if (geoBias.locationRef.current) {
				resolveBias.push({ ...geoBias.locationRef.current, weight: 0.6 })
			}

			const tBeforeResolve = performance.now()
			const cascadeHits = await runCascade(wofLookup, tree, input, resolveBias)
			const tResolve = performance.now()

			// Postcode-only dead end: synthesize an approximate anchor-centroid hit from `postcode-*.bin`.
			if (!cascadeHits.length && postcodeNode?.value && assets?.anchorLookup) {
				const anchorHit = assets.anchorLookup.get(String(postcodeNode.value).toUpperCase())

				if (anchorHit && (anchorHit.lat !== 0 || anchorHit.lon !== 0)) {
					cascadeHits.push({
						id: 0,
						name: `${postcodeNode.value} (anchor centroid)`,
						placetype: "postcode",
						lat: anchorHit.lat,
						lon: anchorHit.lon,
						score: 0,
					} as (typeof cascadeHits)[number])
				}
			}

			const candidates: ResolvedPlaceView[] = projectCascadeHits(cascadeHits)

			cascadeHits.forEach((c, i) => {
				extrasRef.current.set(candidates[i]!, { bbox: c.bbox })
			})

			// A street-level coordinate wins the pin; `id: 0` marks a non-WOF synthesized place,
			// `tier` + `uncertaintyM` ride on the candidate so the result panel renders the precision row
			// instead of a `WOF id 0`, and the map render reads them back through `extrasRef`.
			if (streetResolution) {
				const streetCandidate: ResolvedPlaceView & { tier: StreetResolution["tier"]; uncertaintyM: number } = {
					id: 0,
					name: `${String(houseNumberNode!.value)} ${streetValue}`,
					placetype: streetResolution.tier,
					lat: streetResolution.lat,
					lon: streetResolution.lon,
					score: 1,
					tier: streetResolution.tier,
					uncertaintyM: streetResolution.uncertaintyM,
				}

				extrasRef.current.set(streetCandidate, {
					tier: streetResolution.tier,
					uncertaintyM: streetResolution.uncertaintyM,
				})

				candidates.unshift(streetCandidate)
			}

			// Whether the resolved place doubles as another admin tier; best-effort,
			// and the helper skips a synthesized street/anchor pin (`id === 0`).
			const dualRoles = await resolveDualRoles(wofLookup, candidates[0])

			return {
				input,
				tree,
				nodes: asView(nodes),
				resolved: candidates[0] ?? null,
				candidates,
				kindResult,
				fstActive: assets?.fstMatcher != null,
				fstProvenance: assets?.fstProvenance ?? null,
				timing: { ...timing, resolve: tResolve - tBeforeResolve },
				dualRoles: dualRoles as ParseResult["dualRoles"],
			}
		},
		[ensureStreetLookups, geoBias.locationRef, sqljsBaseURL, rt.assets, rt.selectedRelease, rt.selectedVersion]
	)

	const runParse = useCallback(
		(input: string, hooks: { onStage: (stage: number) => void }) => runParseWithBias(input, null, hooks),
		[runParseWithBias]
	)

	const autocomplete = useCallback(
		async (query: string): Promise<Suggestion[]> => {
			const fst = rt.assets?.fstMatcher

			if (!fst) return []

			try {
				const { autocomplete: fstAutocomplete } = await import("@mailwoman/resolver-wof-sqlite/fst/autocomplete")

				const res = fstAutocomplete(fst as Parameters<typeof fstAutocomplete>[0], query, {
					maxSuggestions: 6,
					dedupeByName: true,
				})

				return res.suggestions.map((s) => ({ value: s.name, placetype: s.placetype }))
			} catch {
				return []
			}
		},
		[rt.assets]
	)

	const resolveMapPlace = useCallback(
		(candidate: ResolvedPlaceView): ResolvedMapPlace | null => {
			const extras = extrasRef.current.get(candidate) ?? {}

			const place: ResolvedMapPlace = {
				...candidate,
				bbox: extras.bbox,
				tier: extras.tier,
				uncertaintyM: extras.uncertaintyM,
			}

			// Crisp admin polygon only for a real WOF place with no street tier, because
			// `computeMapPlaceRenderSpec` prefers `geometry` and the cache update re-runs this enricher.
			const release = rt.selectedRelease
			const version = rt.selectedVersion

			if (!place.tier && candidate.id && release?.hasPolygons && version) {
				const cached = polygonCache.get(candidate.id)

				if (cached) {
					place.geometry = cached
				} else if (cached === undefined && !polygonInflightRef.current.has(candidate.id)) {
					polygonInflightRef.current.add(candidate.id)
					const placeID = candidate.id

					void (async () => {
						try {
							if (!polygonDBRef.current) {
								polygonDBRef.current = loadPolygonDB(assetURL(DEFAULT_LOCALE, version, "wof-polygons.db"), sqljsBaseURL)
							}

							const geom = await (await polygonDBRef.current).get(placeID)
							setPolygonCache((prev) => new Map(prev).set(placeID, geom ?? null))
						} catch (error) {
							console.error("Crisp polygon unavailable; falling back to bbox", error)

							setPolygonCache((prev) => new Map(prev).set(placeID, null))
							polygonDBRef.current = null
						} finally {
							polygonInflightRef.current.delete(placeID)
						}
					})()
				}
			}

			return place
		},
		[sqljsBaseURL, polygonCache, rt.selectedRelease, rt.selectedVersion]
	)

	const traceParse = useCallback(
		async (input: string): Promise<ParseTraceLike | null> => {
			const classifier = rt.assets?.classifier

			if (!classifier?.traceParse) return null

			try {
				return await classifier.traceParse(input, { addressSystemConventions: "auto" })
			} catch {
				return null
			}
		},
		[rt.assets]
	)

	const overlays = useMemo<OverlaySpec[]>(
		() => [
			{
				id: CoverageTileSetID,
				source: createCoverageSource(new URL(`${CoverageTileSetID}.json`, config.tileWorkerURL).href),
				layers: CoverageLayers,
				visible: false,
				label: "Coverage",
			},
		],
		[config.tileWorkerURL]
	)

	const availableVersions = useMemo(
		() => (rt.manifest?.releases ?? []).map((r) => ({ version: r.version, label: r.label })),
		[rt.manifest]
	)

	const parseStageLabels = useMemo(
		() => parseStageLabelsFor(rt.selectedRelease?.hasWOFDB ?? false),
		[rt.selectedRelease]
	)

	const calibrator = useMemo<((raw: number) => number | null) | undefined>(() => {
		const c = rt.assets?.calibrator

		return c ? (raw: number) => c(raw) : undefined
	}, [rt.assets])

	const runtime = useMemo<GeocoderRuntime>(() => {
		return {
			ready: rt.ready,
			runParse,
			parseStageLabels,
			loading: {
				progress: rt.loadingProgress,
				stepLabels: rt.loadingStepLabels,
				stepIndex: rt.loadingStepIndex,
				byteFraction: rt.loadingByteFraction,
			},
			errorMessage: rt.errorMessage,
			mapStyle,
			overlays,
			initialCenter: [initialCenter[0], initialCenter[1]],
			initialZoom: 3,
			runParseWithBias,
			autocomplete,
			calibrator,
			resolveMapPlace,
			availableVersions,
			selectedVersion: rt.selectedVersion ?? undefined,
			selectVersion: rt.selectVersion,
			activeBackend: rt.activeBackend,
			forceWASM: rt.forceWASM,
			setForceWASM: rt.setForceWASM,
		}
	}, [
		mapStyle,
		rt.ready,
		rt.loadingProgress,
		rt.loadingStepLabels,
		rt.loadingStepIndex,
		rt.loadingByteFraction,
		rt.errorMessage,
		rt.selectedVersion,
		rt.activeBackend,
		rt.forceWASM,
		rt.selectVersion,
		rt.setForceWASM,
		initialCenter,
		runParse,
		runParseWithBias,
		autocomplete,
		calibrator,
		resolveMapPlace,
		availableVersions,
		parseStageLabels,
		overlays,
	])

	return {
		runtime,
		releases: rt.manifest?.releases ?? [],
		forceWASM: rt.forceWASM,
		geoBias: { active: geoBias.active, error: geoBias.error, toggle: geoBias.toggle },
		calibrator,
		traceParse,
		supportsTrace: rt.assets?.classifier?.traceParse != null,
	}
}
