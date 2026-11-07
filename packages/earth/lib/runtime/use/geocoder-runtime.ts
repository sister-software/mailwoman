/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `useGeocoderRuntime` — the app's runtime assembly. It builds the real {@link GeocoderRuntime} that
 * `@mailwoman/react/map`'s geocoder consumes, injecting the browser runtime's loaders into
 * `@mailwoman/react`'s `useReleaseRuntime` orchestration and wrapping the loaded assets with the map surface.
 *
 * This is application code on purpose. `@mailwoman/react` keeps its runtime hook free of the ONNX, httpvfs and
 * maplibre graph. This assembly imports all three.
 */

import {
	StyleSpecificationComposer,
	MailwomanBaseTileSetID,
	MailwomanBuildingsTileSetID,
} from "@mailwoman/cartographer/base"
import { GuideMapLight, GuideMapSky } from "@mailwoman/cartographer/base/theme"
import {
	createUnderseaLabelSource,
	UnderseaLabelLayers,
	UnderseaTileSetID,
} from "@mailwoman/cartographer/base/undersea"
import { CoverageLayers, CoverageTileSetID, createCoverageSource } from "@mailwoman/cartographer/coverage"
import {
	createJurisdictionSource,
	JurisdictionLayers,
	JurisdictionTileSetID,
} from "@mailwoman/cartographer/jurisdictions"
import type {
	ParseResult,
	ParsedComponent,
	ResolvedPlaceView,
	ComponentMatch,
} from "@mailwoman/core/pipeline/client-result"
import { startEarly } from "@mailwoman/core/promises"
import type { LandmarkLookup } from "@mailwoman/core/resolver"
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
import type { PlaceGeometry } from "@mailwoman/react/map/geometry"
import type { ResolveBias } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import { resolvedSpanResults, runCascade } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import {
	type HTTPVFSAddressPointLookup,
	type HTTPVFSInterpolator,
	resolveStreet,
	type StreetResolution,
} from "@mailwoman/resolver-wof-wasm/httpvfs/street"
import { LandmarkSource, RemoteLandmarkLookup } from "@mailwoman/resolver-wof-wasm/remote-landmark"
import { postPruneMessage } from "@mailwoman/service-worker-cache/prune"
import type { Coordinates2D } from "@mailwoman/spatial"
import {
	DEFAULT_LOCALE,
	parseStageLabelsFor,
	projectCascadeHits,
	runClassifyStage,
} from "mailwoman/browser-runtime/classify"
import { FamilyBundles, silentAssetProgress } from "mailwoman/browser-runtime/family-bundles"
import type { ReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import { loadReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import type { ReleaseInfo, ReleasesManifest } from "mailwoman/browser-runtime/manifest"
import { fetchReleasesManifest } from "mailwoman/browser-runtime/manifest"
import { postcodeCentroidFor, postcodeFallbackKeys } from "mailwoman/browser-runtime/postcode-fallback"
import {
	assetURL,
	HOSTED_STREET_SLUGS,
	NATIONAL_STREET_FALLBACK_SLUG,
	NATIONAL_STREET_SLUGS,
	regionToStateSlug,
	streetExtractURL,
} from "mailwoman/browser-runtime/resources"
import type { ParseTraceLike } from "mailwoman/browser-runtime/types"
// The binary that `onnxruntime-web/wasm` instantiates.
// Vite emits one file for this import and for the bundle's own reference.
// The loader's early download is therefore the file the session would request.
import ortWASMURL from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { EarthConfig } from "#config"
import { pageSearchParam, pageTilesetParam } from "#routes"
import { loadPolygonDB, type PolygonDB } from "#runtime/basemap"
import { loadUnderseaIndex, underseaPlaceView } from "#runtime/undersea"
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
 * Per-state street lookups loaded together, lazily by region.
 * National (country) extracts have no interpolation.
 */
interface StreetLookups {
	situs: HTTPVFSAddressPointLookup
	interp: HTTPVFSInterpolator | null
}

interface CandidateExtras {
	bbox: ResolvedPlaceView["bbox"] | null
	tier: "address_point" | "interpolated" | null
	uncertaintyM: number | null
}

export interface GeocoderRuntimeHandle {
	runtime: GeocoderRuntime
	releases: ReleaseInfo[]
	geoBias: GeoBiasControl
	calibrator: ((raw: number) => number) | null
	/**
	 * Resolves `null` when the classifier bundle predates the `traceParse` hook or the trace fails.
	 * Feature-detect via {@link supportsTrace}.
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
	/**
	 * Initial map zoom.
	 * Defaults to 3.
	 */
	initialZoom?: number
}

/**
 * Give a superseded bundle's native memory back.
 *
 * This sits at module scope rather than in `useCallback` because it closes over no state,
 * so a stable identity is free and cannot churn the hook's effect.
 */
function disposeAssets(assets: ReleaseAssets): Promise<void> {
	return assets.release()
}

/**
 * The releases-manifest fetch the entry module starts before React mounts,
 * taken by the first manifest load.
 */
let earlyManifest: Promise<ReleasesManifest | null> | null = null

/**
 * Start the releases-manifest fetch ahead of the first render, so the model download
 * begins as soon as the manifest arrives rather than after the app has mounted.
 *
 * The first manifest load of {@link useGeocoderRuntime} takes this promise.
 * Every later load fetches afresh.
 */
export function prefetchReleasesManifest(): void {
	if (modelDisabled()) return

	// The hook awaits and reports a failure, so the early promise must not report it a second time.
	earlyManifest ??= startEarly(fetchReleasesManifest())
}

/**
 * Returns true when the page URL contains `?no-model`.
 *
 * Map-style work needs the basemap only, and the model download is tens of megabytes per load.
 * With the flag the runtime receives no manifest, so it loads no release and the geocoder stays idle.
 */
function modelDisabled(): boolean {
	return pageSearchParam("no-model") !== null
}

/**
 * The basemap's TileJSON: the tileset `?basemap=` asks for on the tile worker, or the configured basemap.
 */
/**
 * Reads one landmark layer, and keeps a search working when the Worker does not answer.
 *
 * The layers improve a bare place name, and the page geocodes offline without them.
 * A failed read goes to the console with its layer, and the gazetteer's own answer stands.
 */
function landmarkLayer(baseURL: URL, source: LandmarkSource): LandmarkLookup {
	const lookup = new RemoteLandmarkLookup(baseURL, source)

	return {
		find: (name) =>
			lookup.find(name).catch((error: unknown) => {
				console.warn(`The ${source} landmark layer did not answer for the name "${name}"`, error)

				return []
			}),
	}
}

function basemapTileJSONURL(config: EarthConfig): URL {
	const name = pageTilesetParam("basemap")

	return name ? new URL(`${name}.json`, config.tileWorkerURL) : config.basemapTileJSONURL
}

/**
 * The TileJSON of the separate buildings tileset `?buildings=` asks for, or `null`
 * to draw the footprints from the basemap's own `buildings` layer.
 */
function buildingsTileJSONURL(config: EarthConfig): URL | null {
	const name = pageTilesetParam("buildings")

	return name ? new URL(`${name}.json`, config.tileWorkerURL) : null
}

/**
 * Source layers only a `mailwoman/basemaps` build holds.
 *
 * When the basemap's TileJSON is unreadable, the style keeps the other basemap layers and drops these.
 */
const BUILD_ONLY_SOURCE_LAYERS = new Set(["trees", "infrastructure"])

/**
 * The source layers a TileJSON lists in `vector_layers`.
 *
 * An unreadable TileJSON answers an empty set and logs the failure.
 */
async function readVectorLayers(tileJSONURL: string): Promise<ReadonlySet<string>> {
	try {
		const response = await fetch(tileJSONURL)

		if (!response.ok) throw new Error(`${tileJSONURL} answered ${response.status}`)

		const tileJSON = (await response.json()) as { vector_layers?: Array<{ id: string }> }

		return new Set((tileJSON.vector_layers ?? []).map((layer) => layer.id))
	} catch (error) {
		console.warn("[mailwoman earth] basemap TileJSON unreadable; drawing without the build-only layers", error)

		return new Set()
	}
}

function takeReleasesManifest(): Promise<ReleasesManifest | null> {
	if (modelDisabled()) return Promise.resolve(null)

	const early = earlyManifest

	earlyManifest = null

	return early ?? fetchReleasesManifest()
}

/**
 * Whether a basemap style layer reads a source layer the basemap holds.
 *
 * MapLibre logs an error for every style layer that reads a missing source layer,
 * such as `address_label` over a basemap built without `buildings`.
 * With an unreadable TileJSON (an empty `vectorLayers`), only the build-only layers are dropped.
 */
function basemapHasSourceLayer(
	layer: ReturnType<StyleSpecificationComposer["toJSON"]>["layers"][number],
	vectorLayers: ReadonlySet<string>
): boolean {
	if (!("source-layer" in layer) || layer.source !== MailwomanBaseTileSetID) return true

	const sourceLayer = String(layer["source-layer"])

	return vectorLayers.size ? vectorLayers.has(sourceLayer) : !BUILD_ONLY_SOURCE_LAYERS.has(sourceLayer)
}

/**
 * The composed basemap style both geocoder runtimes render, or `null` until the basemap's TileJSON is read.
 *
 * The style waits for the TileJSON so that it never changes after the map loads it.
 * A changed style makes MapLibre rebuild the style from scratch and request every loaded tile again.
 */
export function useEarthMapStyle(config: EarthConfig): MapCanvasStyle | null {
	const tileJSONURL = useMemo(() => basemapTileJSONURL(config).href, [config])
	const buildingsURL = useMemo(() => buildingsTileJSONURL(config)?.href ?? null, [config])

	const [vectorLayers, setVectorLayers] = useState<ReadonlySet<string> | null>(null)

	useEffect(() => {
		let current = true

		void readVectorLayers(tileJSONURL).then((layers) => {
			if (current) {
				setVectorLayers(layers)
			}
		})

		return () => {
			current = false
		}
	}, [tileJSONURL])

	return useMemo<MapCanvasStyle | null>(() => {
		if (vectorLayers === null) return null

		const style = new StyleSpecificationComposer({
			sources: {
				[MailwomanBaseTileSetID]: { type: "vector", url: tileJSONURL },
				...(buildingsURL ? { [MailwomanBuildingsTileSetID]: { type: "vector", url: buildingsURL } as const } : {}),
				[UnderseaTileSetID]: createUnderseaLabelSource(config.underseaFeaturesURL.href),
			},
			// Undersea names draw under the ocean and island labels, so a sea's name wins a collision with a seamount's.
			layers: UnderseaLabelLayers.map((layer) => ({ ...layer, beforeID: UNDERSEA_LABELS_BEFORE })),
			light: GuideMapLight,
			sky: GuideMapSky,
		}).toJSON()

		return {
			...style,
			layers: style.layers.filter((layer) => basemapHasSourceLayer(layer, vectorLayers)),
		}
	}, [tileJSONURL, buildingsURL, vectorLayers, config.underseaFeaturesURL])
}

/**
 * The most suggestions the search field lists.
 */
const AUTOCOMPLETE_LIMIT = 6

/**
 * The Protomaps label layer the undersea labels draw beneath: the ocean and sea names.
 */
const UNDERSEA_LABELS_BEFORE = "water_label_ocean"

/**
 * The coverage and jurisdiction overlays both geocoder runtimes offer, hidden until toggled.
 */
export function useEarthOverlays(config: EarthConfig): OverlaySpec[] {
	return useMemo<OverlaySpec[]>(
		() => [
			{
				id: CoverageTileSetID,
				source: createCoverageSource(new URL(`${CoverageTileSetID}.json`, config.tileWorkerURL).href),
				layers: CoverageLayers,
				visible: false,
				label: "Coverage",
			},
			{
				id: JurisdictionTileSetID,
				source: createJurisdictionSource(new URL(`${JurisdictionTileSetID}.json`, config.tileWorkerURL).href),
				layers: JurisdictionLayers,
				visible: false,
				label: "Jurisdictions",
			},
		],
		[config.tileWorkerURL]
	)
}

/**
 * Build the real {@link GeocoderRuntime} by injecting the browser runtime's
 * loaders into `useReleaseRuntime`.
 */
export function useGeocoderRuntime({
	config,
	initialCenter,
	initialZoom = 3,
}: GeocoderRuntimeOptions): GeocoderRuntimeHandle {
	const { sqliteRuntimeBaseURL } = config

	const loadManifest = useCallback(async (): Promise<ReleaseManifest<ReleaseInfo> | null> => takeReleasesManifest(), [])

	const loadAssets = useCallback(
		(release: ReleaseInfo, ctx: AssetsLoadContext): Promise<ReleaseAssets> =>
			loadReleaseAssets(release, ctx, { gazetteer: { sqliteRuntimeBaseURL }, ortWASMURL }),
		[sqliteRuntimeBaseURL]
	)

	const rt = useReleaseRuntime<ReleaseAssets, ReleaseInfo>({ loadManifest, loadAssets, disposeAssets })

	// A weights family other than the base loads its own bundle on the first input written in its script.
	// The bundle reads the base release's gazetteer through the cascade, so it loads no gazetteer of its own.
	const familyBundles = useMemo(
		() =>
			new FamilyBundles<ReleaseAssets>({
				load: (family, release) => loadReleaseAssets(release, silentAssetProgress(), { ortWASMURL, locale: family }),
				dispose: disposeAssets,
			}),
		[]
	)

	useEffect(
		() => () => {
			void familyBundles.dispose()
		},
		[familyBundles]
	)

	useEffect(() => {
		if (rt.selectedVersion) {
			postPruneMessage(rt.selectedVersion)
		}
	}, [rt.selectedVersion])

	const mapStyle = useEarthMapStyle(config)

	/*
	 * These callbacks read `rt.assets` and name it as a dependency.
	 *
	 * A callback that parses with a bundle changes when the bundle changes.
	 * A ref mirror lost a child-first effect race (a ref written during render is a value React may discard).
	 */

	const geoBias = useGeoBias()

	// Per-candidate map-render extras, keyed by the candidate object `useParsePipeline` hands back verbatim.
	const extrasRef = useRef<WeakMap<ResolvedPlaceView, CandidateExtras>>(new WeakMap())
	// Lazy street-tier situs/interp lookups, cached by parsed state/country slug (in-flight promise dedup).
	const streetLookupsRef = useRef<Map<string, Promise<StreetLookups>>>(new Map())
	// The cache is state rather than a ref so a landed polygon rebuilds `resolveMapPlace`
	// through `useGeocode`'s mapPlace memo.
	// Value `undefined` = unfetched, `null` = fetched-absent (fall through to bbox), geometry = present.
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
					const { openRangeDatabase } = await import("@mailwoman/resolver-wof-wasm/httpvfs/database")

					const { HTTPVFSAddressPointLookup, HTTPVFSInterpolator } =
						await import("@mailwoman/resolver-wof-wasm/httpvfs/street")

					if (NATIONAL_STREET_SLUGS.has(slug)) {
						const situsDB = await openRangeDatabase(streetExtractURL(slug, "situs"), sqliteRuntimeBaseURL)

						return { situs: new HTTPVFSAddressPointLookup(situsDB, { streetLocale: slug as "fr" }), interp: null }
					}

					const [situsDB, interpDB] = await Promise.all([
						openRangeDatabase(streetExtractURL(slug, "situs"), sqliteRuntimeBaseURL),
						openRangeDatabase(streetExtractURL(slug, "interp"), sqliteRuntimeBaseURL),
					])

					return { situs: new HTTPVFSAddressPointLookup(situsDB), interp: new HTTPVFSInterpolator(interpDB) }
				})()

				p.catch(() => streetLookupsRef.current.delete(slug))
				streetLookupsRef.current.set(slug, p)
			}

			return p
		},
		[sqliteRuntimeBaseURL]
	)

	const runParseWithBias = useCallback(
		async (input: string, bias: MapBias | null, hooks: { onStage: (stage: number) => void }): Promise<ParseResult> => {
			const assets = rt.assets

			if (!assets) throw new Error("Classifier not ready")
			hooks.onStage(0)

			// The undersea index loads while the parse runs.
			// When the load fails, the search reads only the admin gazetteer.
			const underseaLoad = loadUnderseaIndex(config.underseaFeaturesURL).catch((error: unknown) => {
				console.warn("[mailwoman earth] undersea names unavailable", error)

				return null
			})

			const underseaPlaces = async (): Promise<ResolvedPlaceView[]> => {
				const places = ((await underseaLoad)?.match(input) ?? []).map(underseaPlaceView)

				for (const place of places) {
					extrasRef.current.set(place, { bbox: place.bbox, tier: null, uncertaintyM: null })
				}

				return places
			}

			// An input in a character family's script is read by that family's bundle, loaded on its first input.
			// A family whose load fails leaves the input with the base release for this parse.
			const reader = (await familyBundles.forInput(input).catch(() => null)) ?? assets

			// The classify front half: pipeline import, then query-shape/kind, then neural
			// runPipeline, then flatten, with `onStage(1)` firing between shape and classify.
			const { tree, nodes, kindResult, knownFormats, timing } = await runClassifyStage(
				input,
				{
					classifier: reader.classifier,
					fst: reader.fstMatcher,
					streetMorphology: reader.streetMorphologyMatcher,
					selectPairIndex: reader.selectPairIndex,
					anchorRegions: reader.anchorRegions,
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
			const stateSlug = regionToStateSlug((stateNode?.value as string | undefined) ?? null)

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
							postcodeNode?.value ? String(postcodeNode.value) : null,
							localityNode?.value ? String(localityNode.value) : null,
							street.situs,
							street.interp ?? null,
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
				const undersea = await underseaPlaces()

				return {
					input,
					tree,
					nodes: asView(nodes),
					resolved: undersea[0] ?? null,
					candidates: undersea,
					kindResult,
					fstActive: assets?.fstMatcher != null,
					fstProvenance: assets?.fstProvenance ?? null,
					timing: { ...timing, resolve: null },
				}
			}

			hooks.onStage(2)

			// Open the polygon DB now (no await) so its worker spawn overlaps the cascade below.
			const release = rt.selectedRelease
			const version = rt.selectedVersion

			if (release?.hasPolygons && version && !polygonDBRef.current) {
				const loading = loadPolygonDB(assetURL(DEFAULT_LOCALE, version, "wof-polygons.db"), sqliteRuntimeBaseURL)
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

			let matches: ComponentMatch[] = []

			const cascadeHits = await runCascade(wofLookup, tree, input, resolveBias, {
				landmarks: landmarkLayer(config.landmarkAPIURL, LandmarkSource.Wikidata),
				osmPlaces: landmarkLayer(config.landmarkAPIURL, LandmarkSource.OpenStreetMap),
				onResolved: (roots) => {
					matches = resolvedSpanResults(roots).map((match) =>
						STREET_COMPONENT_TAGS.has(match.tag)
							? {
									...match,
									value: streetValue,
									matched: streetResolution !== null,
									placetype: streetResolution?.tier ?? null,
									name: streetResolution ? streetValue : null,
									note: !streetSlug
										? "no street data for this region"
										: streetResolution
											? null
											: `searched the ${streetSlug} street data`,
								}
							: match
					)
				},
			}).catch(async (error: unknown) => {
				// Offline, the gazetteer answers only from the range chunks the service worker cached while online.
				// A read past them fails inside SQLite as `SQLITE_IOERR_READ`,
				// a disk I/O error that hides the cause.
				const { isSQLiteReadFailure } = await import("@mailwoman/resolver-wof-wasm/httpvfs/database")

				if (isSQLiteReadFailure(error)) {
					throw new Error(
						"The gazetteer could not read the pages this address needs: they are not cached on this device, and the network did not answer.",
						{ cause: error }
					)
				}

				throw error
			})

			const tResolve = performance.now()

			// Postcode-only dead end: answer the postcode's centroid from the release's postcode binaries.
			// The keys come from the parse's postcode node and from the postcode formats the query
			// shape read in the input, so a postcode the classifier labeled at low confidence,
			// or under a `vague` kind, still reaches the map.
			if (!cascadeHits.length && assets?.anchorLookup) {
				const keys = postcodeFallbackKeys(postcodeNode?.value ? String(postcodeNode.value) : null, input, knownFormats)
				const centroid = postcodeCentroidFor(assets.anchorLookup, keys)

				if (centroid) {
					cascadeHits.push({
						id: 0,
						name: `${centroid.key} (anchor centroid)`,
						placetype: "postcode",
						lat: centroid.lat,
						lon: centroid.lon,
						score: 0,
					} as (typeof cascadeHits)[number])
				}
			}

			const candidates: ResolvedPlaceView[] = projectCascadeHits(cascadeHits)

			cascadeHits.forEach((c, i) => {
				extrasRef.current.set(candidates[i]!, { bbox: c.bbox ?? null, tier: null, uncertaintyM: null })
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
					bbox: null,
					tier: streetResolution.tier,
					uncertaintyM: streetResolution.uncertaintyM,
				}

				extrasRef.current.set(streetCandidate, {
					bbox: null,
					tier: streetResolution.tier,
					uncertaintyM: streetResolution.uncertaintyM,
				})

				candidates.unshift(streetCandidate)
			}

			// An input that equals an undersea feature's whole name answers that feature
			// ahead of the admin matches, after a street-level coordinate.
			candidates.splice(streetResolution ? 1 : 0, 0, ...(await underseaPlaces()))

			return {
				input,
				tree,
				nodes: asView(nodes),
				matches,
				resolved: candidates[0] ?? null,
				candidates,
				kindResult,
				fstActive: assets?.fstMatcher != null,
				fstProvenance: assets?.fstProvenance ?? null,
				timing: { ...timing, resolve: tResolve - tBeforeResolve },
			}
		},
		[
			config.landmarkAPIURL,
			config.underseaFeaturesURL,
			ensureStreetLookups,
			familyBundles,
			geoBias.locationRef,
			sqliteRuntimeBaseURL,
			rt.assets,
			rt.selectedRelease,
			rt.selectedVersion,
		]
	)

	const runParse = useCallback(
		(input: string, hooks: { onStage: (stage: number) => void }) => runParseWithBias(input, null, hooks),
		[runParseWithBias]
	)

	const autocomplete = useCallback(
		async (query: string): Promise<Suggestion[]> => {
			const fst = rt.assets?.fstMatcher
			const undersea = loadUnderseaIndex(config.underseaFeaturesURL).catch(() => null)
			let places: Suggestion[] = []

			if (fst) {
				try {
					const { autocomplete: fstAutocomplete } = await import("@mailwoman/resolver-wof-sqlite/fst/autocomplete")

					const res = fstAutocomplete(fst as Parameters<typeof fstAutocomplete>[0], query, {
						maxSuggestions: AUTOCOMPLETE_LIMIT,
						dedupeByName: true,
					})

					places = res.suggestions.map((s) => ({ value: s.name, placetype: s.placetype }))
				} catch {
					places = []
				}
			}

			// Undersea names fill the places the admin suggestions leave, so an admin place keeps its rank.
			const names = new Set(places.map((place) => place.value))

			const features = ((await undersea)?.suggest(query, AUTOCOMPLETE_LIMIT) ?? [])
				.filter((feature) => !names.has(feature.displayName))
				.map((feature) => ({ value: feature.displayName, placetype: feature.genericTerm.toLowerCase() }))

			return [...places, ...features].slice(0, AUTOCOMPLETE_LIMIT)
		},
		[rt.assets, config.underseaFeaturesURL]
	)

	const resolveMapPlace = useCallback(
		(candidate: ResolvedPlaceView): ResolvedMapPlace | null => {
			const extras = extrasRef.current.get(candidate) ?? null

			const place: ResolvedMapPlace = {
				...candidate,
				bbox: extras?.bbox ?? null,
				tier: extras?.tier ?? null,
				uncertaintyM: extras?.uncertaintyM ?? null,
			}

			// Crisp admin polygon only for a real WOF place with no street tier, because
			// `computeMapPlaceRenderSpec` prefers `geometry` and the cache update re-runs this enricher.
			const release = rt.selectedRelease
			const version = rt.selectedVersion

			if (!place.tier && candidate.id && release?.hasPolygons && version) {
				const cached = polygonCache.get(candidate.id)

				if (cached != null) {
					place.geometry = cached
				} else if (!polygonCache.has(candidate.id) && !polygonInflightRef.current.has(candidate.id)) {
					polygonInflightRef.current.add(candidate.id)
					const placeID = candidate.id

					void (async () => {
						try {
							if (!polygonDBRef.current) {
								polygonDBRef.current = loadPolygonDB(
									assetURL(DEFAULT_LOCALE, version, "wof-polygons.db"),
									sqliteRuntimeBaseURL
								)
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
		[sqliteRuntimeBaseURL, polygonCache, rt.selectedRelease, rt.selectedVersion]
	)

	const traceParse = useCallback(
		async (input: string): Promise<ParseTraceLike | null> => {
			// The trace reads the same bundle the geocode would: the input's family when it has one, else the base.
			const reader = (await familyBundles.forInput(input).catch(() => null)) ?? rt.assets
			const classifier = reader?.classifier

			if (!classifier?.traceParse) return null

			try {
				return await classifier.traceParse(input, { addressSystemConventions: "auto" })
			} catch {
				return null
			}
		},
		[rt.assets, familyBundles]
	)

	const overlays = useEarthOverlays(config)

	const availableVersions = useMemo(
		() => (rt.manifest?.releases ?? []).map((r) => ({ version: r.version, label: r.label })),
		[rt.manifest]
	)

	const parseStageLabels = useMemo(
		() => parseStageLabelsFor(rt.selectedRelease?.hasWOFDB ?? false),
		[rt.selectedRelease]
	)

	const calibrator = useMemo<((raw: number) => number) | null>(() => {
		const c = rt.assets?.calibrator

		return c ? (raw: number) => c(raw) : null
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
			initialZoom,
			runParseWithBias,
			autocomplete,
			calibrator,
			resolveMapPlace,
			availableVersions,
			selectedVersion: rt.selectedVersion ?? undefined,
			selectVersion: rt.selectVersion,
			activeBackend: rt.activeBackend,
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
		rt.selectVersion,
		initialCenter,
		initialZoom,
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
		geoBias: { active: geoBias.active, error: geoBias.error, toggle: geoBias.toggle },
		calibrator,
		traceParse,
		supportsTrace: rt.assets?.classifier?.traceParse != null,
	}
}
