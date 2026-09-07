/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useGeocoderRuntime` — the app's runtime assembly. It builds the REAL {@link GeocoderRuntime} that
 *   `@mailwoman/react/map`'s geocoder consumes, wiring the browser runtime's async fetchers and factories into the
 *   fully client-side geocoder.
 *
 *   The shared load orchestration (version-selection state machine, per-version sequencing, ready/error state) is
 *   owned by `@mailwoman/react`'s `useReleaseRuntime`; this module injects the loaders from `mailwoman/browser-runtime`
 *   into it (the onnx-web classifier, the httpvfs gazetteer, the FST, the releases manifest, the calibration table,
 *   the postcode-anchor lookup). Around that loader it assembles the map surface: the composed cartographer basemap
 *   style, the parse+resolve+street+anchor cascade as a bias-aware `runParseWithBias`, the FST autocomplete, and a
 *   `resolveMapPlace` enricher (bbox / street tier / lazily-fetched crisp polygon) that feeds the declarative
 *   overlays.
 *
 *   This is application code on purpose: `@mailwoman/react` keeps its runtime hook free of the ONNX, httpvfs and
 *   maplibre graph, and this assembly imports all three.
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

/**
 * Per-region interp-radius conformal factor (#374); default for unmeasured regions. Mirrors `_app.tsx`.
 */
const INTERP_RADIUS_BY_REGION: Record<string, number> = { dc: 1.44, ny: 1.53, ca: 1.87, mi: 1.93 }
const INTERP_RADIUS_DEFAULT = 1.95

/**
 * Spans that together make up the street name — assembled in source order for the situs/interp query.
 */
const STREET_COMPONENT_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/**
 * The per-state street lookups, loaded together (lazy by region). National (country) extracts carry no interp.
 */
interface StreetLookups {
	situs: HTTPVFSAddressPointLookup
	interp: HTTPVFSInterpolator | undefined
}

/**
 * Per-candidate map-render extras stashed during a parse (bbox / street tier), read back by `resolveMapPlace`.
 */
interface CandidateExtras {
	bbox?: ResolvedPlaceView["bbox"]
	tier?: "address_point" | "interpolated"
	uncertaintyM?: number
}

/**
 * Device-location proximity-bias control (the "📍 Use my location" button state + toggle).
 */
interface GeoBiasControl {
	/**
	 * Whether a device location is currently applied as a soft bias.
	 */
	active: boolean
	/**
	 * Toggle the device-location bias on/off (prompts for geolocation when turning on).
	 */
	toggle: () => void
}

export interface GeocoderRuntimeHandle {
	/**
	 * The composed runtime the geocoder consumes.
	 */
	runtime: GeocoderRuntime
	/**
	 * The selectable releases (for the host compare panel that loads its own second classifier).
	 */
	releases: ReleaseInfo[]
	/**
	 * Whether the CPU/WASM backend is forced (threaded into the host compare classifier load).
	 */
	forceWASM: boolean
	/**
	 * The device-location proximity-bias control (the "Use my location" row).
	 */
	geoBias: GeoBiasControl
	/**
	 * The version's isotonic calibrator (raw softmax → calibrated probability), or `null` if none loaded.
	 */
	calibrator: ((raw: number) => number | null) | undefined
	/**
	 * Trace the current input through the decode path (for the dev-mode ModelVisualizer drawer). Resolves `null` when the
	 * classifier bundle predates the `traceParse` hook or the trace fails. Feature-detect via {@link supportsTrace}.
	 */
	traceParse: (input: string) => Promise<ParseTraceLike | null>
	/**
	 * Whether the loaded classifier exposes the `traceParse` decode-path hook (enables the dev-mode toggle).
	 */
	supportsTrace: boolean
}

export interface GeocoderRuntimeOptions {
	/**
	 * The origins and the same-origin sql.js path the runtime reads from.
	 */
	config: EarthConfig
	/**
	 * Initial map center as `[lon, lat]`.
	 */
	initialCenter: Coordinates2D
}

/**
 * Build the real {@link GeocoderRuntime}. Injects the browser runtime's loaders into the shared `useReleaseRuntime`
 * orchestration, then wraps the loaded assets with the map surface (style / overlays / bias-aware parse / autocomplete
 * / calibrator / map-place enricher).
 */
export function useGeocoderRuntime({ config, initialCenter }: GeocoderRuntimeOptions): GeocoderRuntimeHandle {
	const { sqljsBaseURL } = config

	// ── Injected loaders ──────────────────────────────────────────────────────
	const loadManifest = useCallback(
		async (): Promise<ReleaseManifest<ReleaseInfo> | null> => fetchReleasesManifest(),
		[]
	)

	const loadAssets = useCallback(
		(release: ReleaseInfo, ctx: AssetsLoadContext): Promise<ReleaseAssets> =>
			loadReleaseAssets(release, ctx, { gazetteer: { sqljsBaseURL } }),
		[sqljsBaseURL]
	)

	const rt = useReleaseRuntime<ReleaseAssets, ReleaseInfo>({ loadManifest, loadAssets })

	// The service worker keeps one release's gazetteer chunks; tell it which.
	useEffect(() => {
		if (rt.selectedVersion) {
			pruneDBRangeCache(rt.selectedVersion)
		}
	}, [rt.selectedVersion])

	// ── Composed basemap style: MapLibre reads the TileJSON itself when a vector source names its URL. ──────
	const mapStyle = useMemo<MapCanvasStyle>(
		() =>
			new StyleSpecificationComposer({
				sources: { [MailwomanBaseTileSetID]: { type: "vector", url: String(config.basemapTileJSONURL) } },
			}).toJSON(),
		[config.basemapTileJSONURL]
	)

	// ── Mutable refs the stable parse/enrich callbacks read (avoids stale closures without churning identity) ──
	const assetsRef = useRef<ReleaseAssets | null>(rt.assets)
	const releaseRef = useRef<ReleaseInfo | null>(rt.selectedRelease)
	const versionRef = useRef<string | null>(rt.selectedVersion)

	useEffect(() => {
		assetsRef.current = rt.assets
		releaseRef.current = rt.selectedRelease
		versionRef.current = rt.selectedVersion
	}, [rt.assets, rt.selectedRelease, rt.selectedVersion])

	// ── Device-location bias (#938): the "Use my location" button's soft proximity hint. A ref (not state) so
	// granting it mid-session doesn't re-create the parse callback; `geoBiasActive` drives only the button's pressed
	// state. `runParseWithBias` reads the ref and joins it as a weaker second hint (weight 0.6) below the map-center one.
	const geoBiasRef = useRef<{ lat: number; lon: number } | null>(null)
	const [geoBiasActive, setGeoBiasActive] = useState(false)

	const toggleGeoBias = useCallback(() => {
		if (geoBiasRef.current) {
			geoBiasRef.current = null
			setGeoBiasActive(false)

			return
		}

		if (typeof navigator === "undefined" || !navigator.geolocation) return

		navigator.geolocation.getCurrentPosition(
			(pos) => {
				geoBiasRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude }
				setGeoBiasActive(true)
			},
			() => setGeoBiasActive(false),
			{ maximumAge: 600_000, timeout: 8000 }
		)
	}, [])

	// Per-candidate map-render extras, keyed by the candidate object `useParsePipeline` hands back verbatim.
	const extrasRef = useRef<WeakMap<ResolvedPlaceView, CandidateExtras>>(new WeakMap())
	// Lazy street-tier situs/interp lookups, cached by parsed state/country slug (in-flight promise dedup).
	const streetLookupsRef = useRef<Map<string, Promise<StreetLookups>>>(new Map())
	// Lazy crisp-polygon DB + per-id cache. The cache is STATE (not a ref) so a landed polygon rebuilds
	// `resolveMapPlace` → the runtime → `useGeocode`'s mapPlace memo, drawing the geometry. Cache value:
	// `undefined` = unfetched, `null` = fetched-absent (fall through to bbox), geometry = present.
	const polygonDBRef = useRef<Promise<PolygonDB> | null>(null)
	const polygonInflightRef = useRef<Set<number>>(new Set())
	const [polygonCache, setPolygonCache] = useState<Map<number, PlaceGeometry | null>>(() => new Map())

	// Reset polygon state on version change (URLs are version-scoped).
	useEffect(() => {
		polygonDBRef.current = null
		polygonInflightRef.current = new Set()
		// oxlint-disable-next-line react/set-state-in-effect -- Polygon IDs and cached geometry are scoped to the selected release.
		setPolygonCache(new Map())
	}, [rt.selectedVersion])

	// Lazy-load (and cache) the situs + interp httpvfs lookups for a parsed region's state extract. Ported from `_app.tsx`.
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

	// ── The bias-aware parse+resolve — the god-component `onSubmit` re-expressed as a pure ParseResult factory. ──
	const runParseWithBias = useCallback(
		async (input: string, bias: MapBias | null, hooks: { onStage: (stage: number) => void }): Promise<ParseResult> => {
			const assets = assetsRef.current
			const classifier = assets?.classifier

			if (!classifier) throw new Error("Classifier not ready")
			hooks.onStage(0)

			// Shared classify front-half (#861 / #1278 boundary): 4-way pipeline import → query-shape/kind → neural
			// runPipeline → flatten, with the two front-half timings captured. `onStage(1)` fires between shape and
			// classify, exactly as before.
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

			// `city`, `state`, `postal_code` and `house_number_prefix` are libpostal vocabulary, not `ComponentTag`s,
			// so the `|| n.tag === "…"` arms that used to sit on these four finds could never match. They compiled
			// only while the flattener returned `{ tag: string }`; against the real tag union they are type errors.
			const localityNode = nodes.find((n) => n.tag === "locality")

			const stateNode = nodes
				.filter((n) => n.tag === "region")
				.toSorted((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]

			const postcodeNode = nodes.find((n) => n.tag === "postcode")

			// ── Street tier (#377): exact situs point / TIGER interpolation, ahead of the admin cascade. ──
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

			// No WOF DB for this release — return the classify-only result (no candidates).
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
			const release = releaseRef.current
			const version = versionRef.current

			if (release?.hasPolygons && version && !polygonDBRef.current) {
				const loading = loadPolygonDB(assetURL(DEFAULT_LOCALE, version, "wof-polygons.db"), sqljsBaseURL)
				polygonDBRef.current = loading

				loading.catch(() => {
					if (polygonDBRef.current === loading) {
						polygonDBRef.current = null
					}
				})
			}

			// Viewport bias (#938): the map center as a SOFT proximity hint. The library's decay is population-ceilinged.
			// The device location (when granted via the "Use my location" button) joins as a weaker second hint.
			const resolveBias: ResolveBias = []

			if (bias) {
				resolveBias.push({ lat: bias.center[1], lon: bias.center[0], weight: 1 })
			}

			if (geoBiasRef.current) {
				resolveBias.push({ ...geoBiasRef.current, weight: 0.6 })
			}

			const tBeforeResolve = performance.now()
			const cascadeHits = await runCascade(wofLookup, tree, input, resolveBias)
			const tResolve = performance.now()

			// Anchor-centroid fallback (postcode-only dead ends): synthesize an approximate hit from postcode-*.bin.
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

			// Stash the map-render extras (bbox) keyed by the candidate object.
			cascadeHits.forEach((c, i) => {
				extrasRef.current.set(candidates[i]!, { bbox: c.bbox })
			})

			// Street-level coordinate wins the pin (more precise than any admin centroid). id=0 → not a WOF place. The
			// `tier` + `uncertaintyM` ride on the candidate itself (`ResolvedPlaceView` carries both) so the result panel
			// renders the "precision ≈ interpolated · ±N m" row instead of a "WOF id 0" — the map render still reads them
			// back through `extrasRef` below.
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

			// Dual-role (#402): whether the resolved place doubles as another admin tier. Best-effort + optional
			// (shared with the MDX-embed path). A synthesized street/anchor pin (`id === 0`) is skipped by the helper.
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
		[ensureStreetLookups, sqljsBaseURL]
	)

	const runParse = useCallback(
		(input: string, hooks: { onStage: (stage: number) => void }) => runParseWithBias(input, null, hooks),
		[runParseWithBias]
	)

	/**
	 * FST autocomplete, the combobox's injected fetcher.
	 */
	const autocomplete = useCallback(async (query: string): Promise<Suggestion[]> => {
		const fst = assetsRef.current?.fstMatcher

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
	}, [])

	/**
	 * Map-place enricher: candidate → ResolvedMapPlace (bbox / tier / lazily-fetched crisp polygon).
	 */
	const resolveMapPlace = useCallback(
		(candidate: ResolvedPlaceView): ResolvedMapPlace | null => {
			const extras = extrasRef.current.get(candidate) ?? {}

			const place: ResolvedMapPlace = {
				...candidate,
				bbox: extras.bbox,
				tier: extras.tier,
				uncertaintyM: extras.uncertaintyM,
			}

			// Crisp admin polygon (like `_app.tsx`): only for a real WOF place with no precise street tier. The pure
			// `computeMapPlaceRenderSpec` cascade prefers `geometry` when present; the async fetch stays here (a runtime
			// concern), populating a cache + bumping a nonce so the enricher re-runs with the geometry in hand.
			const release = releaseRef.current
			const version = versionRef.current

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
		[sqljsBaseURL, polygonCache]
	)

	// ── Decode-path trace (dev-mode ModelVisualizer): trace the current input through the loaded classifier. ──
	const traceParse = useCallback(async (input: string): Promise<ParseTraceLike | null> => {
		const classifier = assetsRef.current?.classifier

		if (!classifier?.traceParse) return null

		try {
			return await classifier.traceParse(input, { addressSystemConventions: "auto" })
		} catch {
			return null
		}
	}, [])

	// ── Coverage "fog of war" overlay: the XYZ vector source + default-off fill layers, handed to the package's
	// declarative `<OverlayLayers>`. Default-off (`visible: false`); the LayerToggleControl (injected via
	// `panels.mapControls`) flips each fog reading on. The tile-worker `race-dots` overlay stays off. ──
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

	// ── Version + backend surface (mirror the loader state; the picker/backend controls drive these) ─────────
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
			// PipelineRuntime surface
			ready: rt.ready,
			runParse,
			parseStageLabels,
			loading: {
				progress: rt.loadingProgress,
				stepLabels: rt.loadingStepLabels,
				stepIndex: rt.loadingStepIndex,
			},
			errorMessage: rt.errorMessage,
			// Map surface
			mapStyle,
			overlays,
			initialCenter: [initialCenter[0], initialCenter[1]],
			initialZoom: 3,
			runParseWithBias,
			autocomplete,
			calibrator,
			resolveMapPlace,
			// Version + backend
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
		geoBias: { active: geoBiasActive, toggle: toggleGeoBias },
		calibrator,
		traceParse,
		supportsTrace: rt.assets?.classifier?.traceParse != null,
	}
}
