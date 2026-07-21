/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useDemoMapRuntime` — the DOCS-EDGE runtime injection for the `/demo` page. It builds the REAL
 *   {@link DemoRuntime} that `@mailwoman/react/map`'s `<GeocoderDemo>` consumes, wiring the docs-side
 *   async fetchers/factories that drive the fully-client-side geocoder.
 *
 *   The shared load orchestration (version-selection state machine, per-version sequencing, ready/error
 *   state) is owned by `@mailwoman/react`'s `useDemoRuntime`; this module injects the docs-side async
 *   fetchers into it (the onnx-web classifier factory, the httpvfs WOF opener, the FST fetch, the
 *   releases.json manifest, the calibration table, the postcode-anchor lookup). Around that loader it
 *   assembles the map surface: the composed cartographer basemap style, the parse+resolve+street+anchor
 *   cascade as a bias-aware `runParseWithBias`, the FST autocomplete, and a `resolveMapPlace` enricher
 *   (bbox / street tier / lazily-fetched crisp polygon) that feeds the declarative overlays.
 *
 *   Node-safety is not a concern here — this is docs-only code (webpack/browser), never imported by the
 *   published `@mailwoman/react` package. It reuses the SAME shared helpers the live demo uses
 *   (`../../shared/demo-helpers`, `../../shared/resources`, `./_map-helpers`) so the two paths can't
 *   drift on the parse/resolve/geometry math.
 */

import { StyleSpecificationComposer, MailwomanBaseTileSetID } from "@mailwoman/cartographer/base"
import { CoverageLayers, CoverageTileSetID, createCoverageSource } from "@mailwoman/cartographer/coverage"
import type {
	DemoAssetsLoadContext,
	DemoManifest,
	ParseResult,
	ParsedComponent,
	ResolvedPlaceView,
} from "@mailwoman/react"
import { useDemoRuntime } from "@mailwoman/react"
import type {
	DemoMapStyle,
	DemoRuntime,
	MapBias,
	OverlaySpec,
	ResolvedMapPlace,
	Suggestion,
} from "@mailwoman/react/map"
import type { Coordinates2D } from "@mailwoman/spatial"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { Calibrator, ReleaseInfo, ResolveBias, StreetResolution } from "../../shared/demo-helpers.ts"
import {
	DEFAULT_LOCALE,
	flattenTree,
	normalizeReleasesManifest,
	resolveStreet,
	runCascade,
} from "../../shared/demo-helpers.ts"
import { createCalibrator } from "../../shared/demo-helpers.ts"
import type { HTTPVFSAddressPointLookup, HTTPVFSInterpolator } from "../../shared/httpvfs-street.ts"
import { pruneDBRangeCache, registerRangeCacheServiceWorker } from "../../shared/register-range-sw.ts"
import type {
	DualRole,
	FSTMatcherLike,
	FSTProvenanceLike,
	MailwomanClassifierLike,
	MailwomanLookupLike,
	ParseTraceLike,
	ResolvedHit,
} from "../../shared/resources.tsx"
import {
	adminGazetteerURL,
	assetURL,
	HOSTED_STREET_SLUGS,
	loadFSTGazetteer,
	NATIONAL_STREET_FALLBACK_SLUG,
	NATIONAL_STREET_SLUGS,
	neuralClassifierLoadURLs,
	regionToStateSlug,
	streetShardURL,
} from "../../shared/resources.tsx"
import {
	fetchBasemapSource,
	loadPolygonDB,
	type PlaceGeometry,
	type PolygonDB,
	TILE_WORKER_URL,
} from "./_map-helpers.ts"

/** Per-region interp-radius conformal factor (#374); default for unmeasured regions. Mirrors `_app.tsx`. */
const INTERP_RADIUS_BY_REGION: Record<string, number> = { dc: 1.44, ny: 1.53, ca: 1.87, mi: 1.93 }
const INTERP_RADIUS_DEFAULT = 1.95

/** Spans that together make up the street name — assembled in source order for the situs/interp query. */
const STREET_COMPONENT_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/** The per-state street lookups, loaded together (lazy by region). National (country) shards carry no interp. */
interface StreetLookups {
	situs: HTTPVFSAddressPointLookup
	interp: HTTPVFSInterpolator | undefined
}

/** The docs-side asset bundle `useDemoRuntime` loads + holds for the selected version (opaque to the package). */
interface DocsDemoAssets {
	classifier: MailwomanClassifierLike
	/** Postcode-anchor centroid lookup (US ZIP → real centroid), for the postcode-only dead-end fallback. */
	anchorLookup: Map<string, { lat: number; lon: number }> | null
	fstMatcher: FSTMatcherLike | null
	fstProvenance: FSTProvenanceLike | null
	lookup: MailwomanLookupLike | null
	calibrator: Calibrator | null
}

/** Per-candidate map-render extras stashed during a parse (bbox / street tier), read back by `resolveMapPlace`. */
interface CandidateExtras {
	bbox?: ResolvedHit["bbox"]
	tier?: "address_point" | "interpolated"
	uncertaintyM?: number
}

/** Device-location proximity-bias control (the "📍 Use my location" button state + toggle). */
export interface GeoBiasControl {
	/** Whether a device location is currently applied as a soft bias. */
	active: boolean
	/** Toggle the device-location bias on/off (prompts for geolocation when turning on). */
	toggle: () => void
}

export interface UseDemoMapRuntime {
	/** The composed runtime `<GeocoderDemo>` consumes, or `null` until the basemap style has loaded. */
	runtime: DemoRuntime | null
	/** The selectable releases (for the host compare panel that loads its own second classifier). */
	releases: ReleaseInfo[]
	/** Whether the CPU/WASM backend is forced (threaded into the host compare classifier load). */
	forceWASM: boolean
	/** The device-location proximity-bias control (the demo's "Use my location" row). */
	geoBias: GeoBiasControl
	/** The version's isotonic calibrator (raw softmax → calibrated probability), or `null` if none loaded. */
	calibrator: ((raw: number) => number | null) | undefined
	/**
	 * Trace the current input through the decode path (for the dev-mode ModelVisualizer drawer). Resolves `null` when the
	 * classifier bundle predates the `traceParse` seam or the trace fails. Feature-detect via {@link supportsTrace}.
	 */
	traceParse: (input: string) => Promise<ParseTraceLike | null>
	/** Whether the loaded classifier exposes the `traceParse` decode-path seam (gates the dev-mode toggle). */
	supportsTrace: boolean
}

export interface UseDemoMapRuntimeOptions {
	/** Same-origin base for the sql.js-httpvfs worker + wasm (e.g. `/mailwoman/sqljs`). */
	sqljsBaseURL: string
	/** Site base URL (for the range-cache service worker registration). */
	baseURL: string
	/** Initial map center as `[lon, lat]` (the host's browser-geolocation result). */
	initialCenter: Coordinates2D
}

/**
 * Build the real {@link DemoRuntime} for `/demo`. Injects the docs fetchers into the shared `useDemoRuntime` loader,
 * then wraps the loaded assets with the map surface (style / overlays / bias-aware parse / autocomplete / calibrator /
 * map-place enricher). The returned `runtime` is `null` until the basemap style resolves.
 */
export function useDemoMapRuntime({
	sqljsBaseURL,
	baseURL,
	initialCenter,
}: UseDemoMapRuntimeOptions): UseDemoMapRuntime {
	// ── Injected loaders ──────────────────────────────────────────────────────
	const loadManifest = useCallback(async (): Promise<DemoManifest<ReleaseInfo> | null> => {
		// `cache: "reload"` bypasses the (immutable-Cache-Control) HTTP cache for the version pointer so a
		// returning visitor sees a defaultVersion bump — the same guard `_app.tsx` uses.
		const res = await fetch(assetURL(DEFAULT_LOCALE, "", "releases.json").replace(/\/\/releases/, "/releases"), {
			cache: "reload",
		})

		return res.ok ? normalizeReleasesManifest(await res.json()) : null
	}, [])

	const loadAssets = useCallback(
		async (release: ReleaseInfo, ctx: DemoAssetsLoadContext): Promise<DocsDemoAssets> => {
			ctx.setProgress(`Loading ${release.version} model (~${release.modelSize ?? "?"})…`)

			const steps: string[] = ["Loading classifier"]

			if (release.hasFST) {
				steps.push("Loading FST gazetteer")
			}

			if (release.hasWOFDb) {
				steps.push("Loading WOF database")
			}
			ctx.setStepLabels(steps)

			const neuralWeb = await import("@mailwoman/neural-web")
			const {
				classifier: cls,
				diagnostics,
				postcodeAnchorLookup,
				// The runtime API is wider than the TS types; cast through unknown (the runtime bundle ships a wider surface than its types).
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} = (await neuralWeb.loadNeuralClassifierFromURLs(
				neuralClassifierLoadURLs(DEFAULT_LOCALE, release.version, {
					hasAnchor: release.hasAnchor,
					forceWASM: ctx.forceWASM,
				})
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			)) as unknown as any as {
				classifier: MailwomanClassifierLike
				diagnostics?: { backend: string; modelBytes: number } | null
				postcodeAnchorLookup?: Map<string, { lat: number; lon: number }> | null
			}

			ctx.setBackend(
				diagnostics
					? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)`
					: "unknown"
			)
			ctx.setStepIndex(0)

			// Isotonic confidence calibration (#59) — tolerate a 404 (pre-v4.0.0 bundles ship no table).
			let calibrator: Calibrator | null = null

			try {
				const calRes = await fetch(assetURL(DEFAULT_LOCALE, release.version, "calibration.json"))

				if (calRes.ok) {
					calibrator = createCalibrator(await calRes.json())
				}
			} catch {
				// No calibration table for this version — raw scores it is.
			}

			let fstMatcher: FSTMatcherLike | null = null
			let fstProvenance: FSTProvenanceLike | null = null

			if (release.hasFST) {
				try {
					const fstResult = await loadFSTGazetteer(DEFAULT_LOCALE, release.version)
					fstMatcher = fstResult.matcher
					fstProvenance = fstResult.provenance ?? null
				} catch {
					// FST not available for this version.
				}
			}
			ctx.setStepIndex(1)

			let lookup: MailwomanLookupLike | null = null

			if (release.hasWOFDb) {
				try {
					const { loadHTTPVFSDatabase, WOFCandidateTableLookup } = await import("../../shared/httpvfs-resolver")
					const worker = await loadHTTPVFSDatabase(adminGazetteerURL(), sqljsBaseURL)

					if (!ctx.signal.aborted) {
						const wofLookup = new WOFCandidateTableLookup(worker)
						// Fire-and-forget warm-up so the first interactive query starts warm.
						void wofLookup.warmUp().catch(() => {})
						lookup = wofLookup as unknown as MailwomanLookupLike
					}
				} catch {
					// WOF DB not available for this version.
				}
			}
			ctx.setStepIndex(2)

			return {
				classifier: cls,
				anchorLookup: postcodeAnchorLookup ?? null,
				fstMatcher,
				fstProvenance,
				lookup,
				calibrator,
			}
		},
		[sqljsBaseURL]
	)

	const rt = useDemoRuntime<DocsDemoAssets, ReleaseInfo>({ loadManifest, loadAssets })

	// ── Range-cache service worker (docs-only; persists validated DB range chunks across visits) ───────────
	useEffect(() => {
		registerRangeCacheServiceWorker(baseURL)
	}, [baseURL])

	useEffect(() => {
		if (rt.selectedVersion) {
			pruneDBRangeCache(rt.selectedVersion)
		}
	}, [rt.selectedVersion])

	// ── Composed basemap style (async: tilejson fetch + cartographer composer) ─────────────────────────────
	const [mapStyle, setMapStyle] = useState<DemoMapStyle | null>(null)

	useEffect(() => {
		let cancelled = false

		void fetchBasemapSource()
			.then((basemapSource) => {
				if (cancelled) return
				const composer = new StyleSpecificationComposer({ sources: { [MailwomanBaseTileSetID]: basemapSource } })

				setMapStyle(composer.toJSON() as unknown as DemoMapStyle)
			})
			.catch((error) => {
				console.error("Failed to compose basemap style", error)
			})

		return () => {
			cancelled = true
		}
	}, [])

	// ── Mutable refs the stable parse/enrich callbacks read (avoids stale closures without churning identity) ──
	const assetsRef = useRef<DocsDemoAssets | null>(rt.assets)
	assetsRef.current = rt.assets
	const releaseRef = useRef<ReleaseInfo | null>(rt.selectedRelease)
	releaseRef.current = rt.selectedRelease
	const versionRef = useRef<string | null>(rt.selectedVersion)
	versionRef.current = rt.selectedVersion

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
			{ maximumAge: 600_000, timeout: 8_000 }
		)
	}, [])

	// Per-candidate map-render extras, keyed by the candidate object `useParsePipeline` hands back verbatim.
	const extrasRef = useRef<WeakMap<ResolvedPlaceView, CandidateExtras>>(new WeakMap())
	// Lazy street-tier situs/interp lookups, cached by parsed state/country slug (in-flight promise dedup).
	const streetLookupsRef = useRef<Map<string, Promise<StreetLookups>>>(new Map())
	// Lazy crisp-polygon DB + per-id cache. The cache is STATE (not a ref) so a landed polygon rebuilds
	// `resolveMapPlace` → the runtime → `useDemoGeocode`'s mapPlace memo, drawing the geometry. Cache value:
	// `undefined` = unfetched, `null` = fetched-absent (fall through to bbox), geometry = present.
	const polygonDBRef = useRef<Promise<PolygonDB> | null>(null)
	const polygonInflightRef = useRef<Set<number>>(new Set())
	const [polygonCache, setPolygonCache] = useState<Map<number, PlaceGeometry | null>>(() => new Map())

	// Reset polygon state on version change (URLs are version-scoped).
	useEffect(() => {
		polygonDBRef.current = null
		polygonInflightRef.current = new Set()
		setPolygonCache(new Map())
	}, [rt.selectedVersion])

	// Lazy-load (and cache) the situs + interp httpvfs lookups for a parsed region's state shard. Ported from `_app.tsx`.
	const ensureStreetLookups = useCallback(
		async (slug: string): Promise<StreetLookups | null> => {
			let p = streetLookupsRef.current.get(slug)

			if (!p) {
				p = (async () => {
					const { loadHTTPVFSDatabase } = await import("../../shared/httpvfs-resolver")
					const { HTTPVFSAddressPointLookup, HTTPVFSInterpolator } = await import("../../shared/httpvfs-street")

					if (NATIONAL_STREET_SLUGS.has(slug)) {
						const situsW = await loadHTTPVFSDatabase(streetShardURL(slug, "situs"), sqljsBaseURL)

						return { situs: new HTTPVFSAddressPointLookup(situsW, { streetLocale: slug as "fr" }), interp: undefined }
					}
					const [situsW, interpW] = await Promise.all([
						loadHTTPVFSDatabase(streetShardURL(slug, "situs"), sqljsBaseURL),
						loadHTTPVFSDatabase(streetShardURL(slug, "interp"), sqljsBaseURL),
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

			const [{ computeQueryShape }, { classifyKindSync }, { runPipeline }, { groupPhrases }] = await Promise.all([
				import("@mailwoman/query-shape"),
				import("@mailwoman/kind-classifier"),
				import("@mailwoman/core/pipeline"),
				import("@mailwoman/phrase-grouper"),
			])

			const tStart = performance.now()
			const queryShape = computeQueryShape(input)
			const kindResult = classifyKindSync({ raw: input, normalized: input }, queryShape)
			const tShape = performance.now()

			hooks.onStage(1)

			const { tree } = await runPipeline(input, {
				computeQueryShape,
				groupPhrases,
				classifier: classifier as unknown as Parameters<typeof runPipeline>[1]["classifier"],
				fst: (assets?.fstMatcher ?? undefined) as Parameters<typeof runPipeline>[1]["fst"],
			})
			const tClassify = performance.now()

			const nodes = flattenTree(tree)
			const localityNodes = nodes.filter((n) => n.tag === "locality" || n.tag === "city")
			const stateNode = nodes
				.filter((n) => n.tag === "region" || n.tag === "state")
				.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
			const postcodeNode = nodes.find((n) => n.tag === "postcode" || n.tag === "postal_code")

			// ── Street tier (#377): exact situs point / TIGER interpolation, ahead of the admin cascade. ──
			let streetResolution: StreetResolution | null = null
			const streetParts = nodes
				.filter((n) => STREET_COMPONENT_TAGS.has(n.tag) && String(n.value ?? "").trim())
				.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
			const streetValue = streetParts.map((n) => String(n.value).trim()).join(" ")
			const houseNumberNode = nodes.find((n) => n.tag === "house_number" || n.tag === "house_number_prefix")
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
							localityNodes[0]?.value ? String(localityNodes[0].value) : undefined,
							street.situs,
							street.interp,
							INTERP_RADIUS_BY_REGION[streetSlug] ?? INTERP_RADIUS_DEFAULT
						)
					}
				} catch (streetErr) {
					console.warn("[mailwoman demo] street tier unavailable; falling back to admin cascade", streetErr)
				}
			}

			const asView = (nds: typeof nodes): ParsedComponent[] =>
				nds.map((n) => ({ tag: n.tag, value: n.value, confidence: n.confidence, start: n.start, end: n.end }))

			const wofLookup = assets?.lookup ?? null

			// No WOF DB for this release — return the classify-only result (no candidates).
			if (!wofLookup) {
				return {
					input,
					tree,
					nodes: asView(nodes),
					resolved: null,
					candidates: [],
					kindResult: kindResult as ParseResult["kindResult"],
					fstActive: assets?.fstMatcher != null,
					fstProvenance: assets?.fstProvenance ?? null,
					timing: { shape: tShape - tStart, classify: tClassify - tShape },
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
			const cascadeHits = await runCascade(wofLookup, tree as { roots: unknown[] }, input, resolveBias)
			const tResolve = performance.now()

			// Anchor-centroid fallback (postcode-only dead ends): synthesize an approximate hit from postcode-*.bin.
			if (cascadeHits.length === 0 && postcodeNode?.value && assets?.anchorLookup) {
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

			const candidates: ResolvedPlaceView[] = cascadeHits.map((c) => ({
				id: c.id,
				name: c.name,
				placetype: c.placetype,
				lat: c.lat,
				lon: c.lon,
				score: c.score,
			}))
			// Stash the map-render extras (bbox) keyed by the candidate object.
			cascadeHits.forEach((c, i) => {
				extrasRef.current.set(candidates[i]!, { bbox: c.bbox })
			})

			// Street-level coordinate wins the pin (more precise than any admin centroid). id=0 → not a WOF place. The
			// `tier` + `uncertaintyM` ride on the candidate itself (a structural superset of `ResolvedPlaceView`, exactly
			// like the live demo's `ResolvedHit`) so the docs `<ResultPanel>` renders the "precision ≈ interpolated · ±N m"
			// row instead of a "WOF id 0" — the map render still reads them back through `extrasRef` below.
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

			// Dual-role (#402): whether the resolved place doubles as another admin tier. Best-effort + optional.
			let dualRoles: DualRole[] | undefined
			const primaryHit = candidates[0]

			if (primaryHit && primaryHit.id && wofLookup.coincidentRolesFor) {
				try {
					const roles = await wofLookup.coincidentRolesFor(primaryHit.id)

					if (roles.length > 0) {
						dualRoles = roles
					}
				} catch {
					/* relation absent / query failed → no dual-role badge */
				}
			}

			return {
				input,
				tree,
				nodes: asView(nodes),
				resolved: candidates[0] ?? null,
				candidates,
				kindResult: kindResult as ParseResult["kindResult"],
				fstActive: assets?.fstMatcher != null,
				fstProvenance: assets?.fstProvenance ?? null,
				timing: { shape: tShape - tStart, classify: tClassify - tShape, resolve: tResolve - tBeforeResolve },
				dualRoles: dualRoles as ParseResult["dualRoles"],
			}
		},
		[ensureStreetLookups, sqljsBaseURL]
	)

	const runParse = useCallback(
		(input: string, hooks: { onStage: (stage: number) => void }) => runParseWithBias(input, null, hooks),
		[runParseWithBias]
	)

	// ── FST autocomplete (the combobox's injected fetcher) ─────────────────────────────────────────────────
	const autocomplete = useCallback(async (query: string): Promise<Suggestion[]> => {
		const fst = assetsRef.current?.fstMatcher

		if (!fst) return []

		try {
			const { autocomplete: fstAutocomplete } = await import("@mailwoman/resolver-wof-sqlite/fst-autocomplete")
			const res = fstAutocomplete(fst as unknown as Parameters<typeof fstAutocomplete>[0], query, {
				maxSuggestions: 6,
				dedupeByName: true,
			})

			return res.suggestions.map((s) => ({ value: s.name, placetype: s.placetype }))
		} catch {
			return []
		}
	}, [])

	// ── Map-place enricher: candidate → ResolvedMapPlace (bbox / tier / lazily-fetched crisp polygon). ───────
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
						} catch (err) {
							console.error("Crisp polygon unavailable; falling back to bbox", err)
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

	// ── Coverage "fog of war" overlay: the same XYZ vector source + default-off fill layers the live demo wires,
	// handed to the package's declarative `<OverlayLayers>`. Default-off (`visible: false`); the LayerToggleControl
	// (injected via `panels.mapControls`) flips each fog reading on. The tile-worker `race-dots` overlay stays off. ──
	const overlays = useMemo<OverlaySpec[]>(
		() => [
			{
				id: CoverageTileSetID,
				source: createCoverageSource(`${TILE_WORKER_URL}/${CoverageTileSetID}.json`),
				layers: CoverageLayers,
				visible: false,
				label: "Coverage",
			},
		],
		[]
	)

	// ── Version + backend surface (mirror the loader state; the picker/backend controls drive these) ─────────
	const availableVersions = useMemo(
		() => (rt.manifest?.releases ?? []).map((r) => ({ version: r.version, label: r.label })),
		[rt.manifest]
	)

	const parseStageLabels = useMemo(
		() =>
			rt.selectedRelease?.hasWOFDb
				? ["Analyzing input shape…", "Running neural classifier…", "Resolving in gazetteer…"]
				: ["Analyzing input shape…", "Running neural classifier…"],
		[rt.selectedRelease]
	)

	const calibrator = useMemo<((raw: number) => number | null) | undefined>(() => {
		const c = rt.assets?.calibrator

		return c ? (raw: number) => c(raw) : undefined
	}, [rt.assets])

	const runtime = useMemo<DemoRuntime | null>(() => {
		if (!mapStyle) return null

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
