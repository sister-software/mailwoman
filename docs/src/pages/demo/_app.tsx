/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Mailwoman geocoder demo — fully client-side. Combines:
 *
 *   - `@mailwoman/neural-web` (onnxruntime-web, WASM SIMD with WebGPU fallback) for the BIO classifier.
 *   - Sql.js-httpvfs (../../shared/httpvfs-resolver) range-loading the same-origin WOF + polygon DBs.
 *   - `@mailwoman/cartographer` `StyleSpecificationComposer` over the v4 protomaps basemap.
 *
 *   The model/tokenizer/fst come from HF (one-shot full-fetch); the resolver DBs are served
 *   same-origin from `/mailwoman/` and range-loaded, so a session fetches a few MB of them, not
 *   70+.
 *
 *   Layout: full-viewport map (Google Maps-style) with a floating semi-transparent control panel on
 *   the left. On mobile the panel slides to the bottom.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import useDocusaurusContext from "@docusaurus/useDocusaurusContext"
import { MailwomanBaseTileSetID, StyleSpecificationComposer } from "@mailwoman/cartographer/base"
import { CoverageLayers, CoverageTileSetID, createCoverageSource } from "@mailwoman/cartographer/coverage"
import { createRaceDotsSource, RaceDotsLayers, RaceDotsTileSetID } from "@mailwoman/cartographer/race-dots"
import type { Map as MapLibreMap } from "maplibre-gl"
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { AboutDemo } from "../../components/AboutDemo/AboutDemo.tsx"
import { LayerToggleControl } from "../../components/LayerToggleControl/LayerToggleControl.tsx"
import { LoadingIndicator } from "../../components/LoadingIndicator/LoadingIndicator.tsx"
import { ModelVisualizer } from "../../components/ModelVisualizer/ModelVisualizer.tsx"
import { PermalinkButton } from "../../components/PermalinkButton/PermalinkButton.tsx"
import { ResultPanel } from "../../components/ResultPanel/ResultPanel.tsx"
import { VersionCompare } from "../../components/VersionCompare/VersionCompare.tsx"
import type { Calibrator, ReleasesManifest, StreetResolution } from "../../shared/demo-helpers.ts"
import {
	createCalibrator,
	DEFAULT_ADDRESS,
	DEFAULT_LOCALE,
	EXAMPLE_ADDRESSES,
	flattenTree,
	normalizeReleasesManifest,
	resolveStreet,
	runCascade,
} from "../../shared/demo-helpers.ts"
import type { ResolveBias } from "../../shared/demo-helpers.ts"
import type { HTTPVFSAddressPointLookup, HTTPVFSInterpolator } from "../../shared/httpvfs-street.ts"
import { pruneDBRangeCache, registerRangeCacheServiceWorker } from "../../shared/register-range-sw.ts"
import {
	adminGazetteerURL,
	assetURL,
	type DemoResult,
	type ParseTraceLike,
	type DualRole,
	type FSTMatcherLike,
	type FSTProvenanceLike,
	HOSTED_STREET_SLUGS,
	loadFSTGazetteer,
	type MailwomanClassifierLike,
	type MailwomanLookupLike,
	neuralClassifierLoadURLs,
	regionToStateSlug,
	type ResolvedHit,
	streetShardURL,
} from "../../shared/resources.tsx"

import styles from "./styles.module.css"

/** Per-region interp-radius conformal factor (#374); default for unmeasured regions. */
const INTERP_RADIUS_BY_REGION: Record<string, number> = { dc: 1.44, ny: 1.53, ca: 1.87, mi: 1.93 }
const INTERP_RADIUS_DEFAULT = 1.95

/**
 * Spans that together make up the street name — assembled in source order for the situs/interp query.
 */
const STREET_COMPONENT_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/** The per-state street lookups, loaded together (lazy by region). */
interface StreetLookups {
	situs: HTTPVFSAddressPointLookup
	interp: HTTPVFSInterpolator
}

import { useSiteConfig } from "../../hooks/site.ts"
import { DebugControl } from "./_debug.tsx"
import {
	clearBbox,
	currentDocusaurusTheme,
	drawApproxCircle,
	drawPlaceGeometry,
	drawRadiusCircle,
	fetchBasemapSource,
	geomBounds,
	loadPolygonDB,
	type PolygonDB,
	TILE_WORKER_URL,
} from "./_map-helpers.ts"

function initialAddress(): string {
	if (typeof window === "undefined") return DEFAULT_ADDRESS
	const url = new URL(window.location.href)

	return url.searchParams.get("q") ?? DEFAULT_ADDRESS
}

export interface DemoAppProps {
	initialCenter: [number, number]
	/** Open the model-visualizer debug drawer by default (the /debug route). */
	debugDefault?: boolean
}

export const DemoApp: React.FC<DemoAppProps> = ({ initialCenter, debugDefault = false }) => {
	// Asset hosting split: the DBs + model + everything else come from R2 (assetURL → the
	// public.sister.software bucket — raw ranges, CORS, free egress). The sql.js-httpvfs WORKER must
	// stay SAME-ORIGIN though — browsers block cross-origin `new Worker()` — so the worker + wasm are
	// staged into the Pages deploy at `/mailwoman/sqljs/` by the demo-assets plugin and loaded from
	// there, while the DB the worker range-reads lives on R2 (cross-origin, CORS-allowed).
	const { baseURL } = useSiteConfig()
	const sqljsBaseURL = `${baseURL}mailwoman/sqljs`
	const [manifest, setManifest] = useState<ReleasesManifest | null>(null)
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
	const [loadingProgress, setLoadingProgress] = useState<string>("Loading releases…")
	const [classifier, setClassifier] = useState<MailwomanClassifierLike | null>(null)
	// Confidence calibration (#59): an OPT-IN view toggle. The raw softmax `conf=` is what the model
	// emits; the calibrator (the version's isotonic table) maps it to an honest probability-of-correct.
	// Default OFF so the demo's default presentation is unchanged; flipping it on lets a visitor watch
	// the under-confident spans correct upward. Display-only — never touches the resolver's inputs.
	const [calibrator, setCalibrator] = useState<Calibrator | null>(null)
	const [calibrateConfidence, setCalibrateConfidence] = useState(false)

	// ── Compare mode ──────────────────────────────────────────────────────
	const [compareMode, setCompareMode] = useState(false)
	const [compareVersion, setCompareVersion] = useState<string | null>(null)
	const [compareClassifier, setCompareClassifier] = useState<MailwomanClassifierLike | null>(null)
	const [compareLoading, setCompareLoading] = useState(false)
	const [compareBackend, setCompareBackend] = useState<string>("")
	const [compareResult, setCompareResult] = useState<DemoResult | null>(null)

	const [fstMatcher, setFSTMatcher] = useState<FSTMatcherLike | null>(null)
	const [fstProvenance, setFSTProvenance] = useState<FSTProvenanceLike | null>(null)
	const [forceWASM, setForceWASM] = useState(false)
	const [activeBackend, setActiveBackend] = useState<string>("")
	const [lookupLoader, setLookupLoader] = useState<
		((onProgress?: (bytesRead: number) => void) => Promise<MailwomanLookupLike>) | null
	>(null)
	const [lookup, setLookup] = useState<MailwomanLookupLike | null>(null)
	// In-flight lookup load. ensureLookup is reachable from BOTH the idle warm-up and a user submit;
	// without this guard a submit racing the warm-up would spawn a second worker + duplicate range
	// fetches. Cleared on version change and on load failure (so the next attempt can retry).
	const lookupPromiseRef = useRef<Promise<MailwomanLookupLike> | null>(null)
	const [text, setText] = useState(initialAddress)
	const [busy, setBusy] = useState(false)
	// Place-autocomplete (#190/#587): suggestions for the locality the user is typing (the segment after
	// the last comma), from the already-loaded FST gazetteer. Place-level; the address-level variant is
	// a follow-up (demo spec). Empty when nothing matches, so the chip row only shows when useful.
	const [suggestions, setSuggestions] = useState<Array<{ name: string; placetype: string }>>([])
	// Keyboard-highlighted suggestion (combobox active descendant). -1 = none highlighted; ↑/↓ move it,
	// Enter picks it, Esc dismisses. Reset to -1 whenever the suggestion list changes.
	const [activeSuggestion, setActiveSuggestion] = useState(-1)
	// One-shot guard: picking a suggestion rewrites `text` to the chosen name, which would otherwise
	// re-trigger the autocomplete effect and immediately re-suggest the place just chosen. Set on pick,
	// consumed by the next effect run so the list stays closed until the user types again.
	const suppressAutocompleteRef = useRef(false)
	const [parseStage, setParseStage] = useState(-1)
	const [result, setResult] = useState<DemoResult | null>(null)
	// Model-visualizer debug drawer (#941 component, in-demo per operator): a dev-mode toggle that
	// traces the SAME address being geocoded on the map. `debugTrace` is the decode-path trace for the
	// current input; recomputed on each submit while debug mode is on. Gated on the classifier exposing
	// `traceParse` (older bundles lack the seam).
	const [debug, setDebug] = useState(debugDefault)
	const [debugTrace, setDebugTrace] = useState<ParseTraceLike | null>(null)
	const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(0)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [compareErrorMessage, setCompareErrorMessage] = useState<string | null>(null)

	// Display-only calibrated view of the result: map each span's `conf=` through the calibrator when
	// the toggle is on. A fresh copy — never mutates `result` (the resolver + compare read the raw nodes).
	const displayResult = useMemo(() => {
		if (!result || !calibrateConfidence || !calibrator) return result

		return {
			...result,
			nodes: result.nodes.map((n) => ({
				...n,
				confidence: n.confidence != null ? calibrator(n.confidence) : n.confidence,
			})),
		}
	}, [result, calibrateConfidence, calibrator])

	// Parse stage labels depend on whether WOF lookup is available for the selected release.
	const parseStageLabels = useMemo(
		() =>
			lookupLoader
				? ["Analyzing input shape…", "Running neural classifier…", "Resolving in gazetteer…"]
				: ["Analyzing input shape…", "Running neural classifier…"],
		[lookupLoader]
	)
	const mapContainerRef = useRef<HTMLDivElement>(null)
	const [map, setMap] = useState<MapLibreMap | null>(null)
	const markerRef = useRef<{ remove: () => void } | null>(null)
	// Lazily-loaded crisp-polygon DB (id → simplified admin geometry). Loaded once per version on the
	// first resolve, reset when the selected version changes. Held as the in-flight promise so concurrent
	// resolves share one fetch.
	const anchorLookupRef = useRef<Map<string, { lat: number; lon: number }> | null>(null)
	// Optional geolocation bias (#938): populated by the "Use my location" control, read at submit.
	// A ref (not state) so granting it mid-session doesn't re-render or re-create the submit callback.
	const geoBiasRef = useRef<{ lat: number; lon: number } | null>(null)
	const [geoBiasOn, setGeoBiasOn] = useState(false)
	const polygonDBRef = useRef<Promise<PolygonDB> | null>(null)
	// Street tier (#377): per-state situs/interp httpvfs lookups, lazy-loaded by parsed region and
	// cached. Held as the in-flight promise so a fast second submit on the same state shares one load.
	const streetLookupsRef = useRef<Map<string, Promise<StreetLookups>>>(new Map())

	// Sync ?q= when the operator edits the address. replaceState avoids polluting back-button
	// history with every keystroke; only the latest state lands in the URL.
	useEffect(() => {
		if (typeof window === "undefined") return
		const url = new URL(window.location.href)

		if (text === DEFAULT_ADDRESS) {
			url.searchParams.delete("q")
		} else {
			url.searchParams.set("q", text)
		}
		window.history.replaceState(null, "", url.toString())
	}, [text])

	// Mount: register the range-chunk service worker (persists validated DB range chunks in Cache
	// Storage — warm repeat visits, and the root fix for mobile Safari's torn-chunk HTTP cache).
	useEffect(() => {
		registerRangeCacheServiceWorker(baseURL)
	}, [baseURL])

	// Drop cached range chunks belonging to other versions once a version is selected — the URLs are
	// immutable, so old versions' chunks never expire on their own.
	useEffect(() => {
		if (!selectedVersion) return

		pruneDBRangeCache(selectedVersion)
	}, [selectedVersion])

	// Mount: fetch the releases manifest + set up the map.
	useEffect(() => {
		let cancelled = false

		void (async () => {
			try {
				const [manifestRes, maplibre, basemapSource] = await Promise.all([
					// `cache: "reload"` bypasses the HTTP cache for the version pointer. releases.json was
					// historically served with an immutable Cache-Control (the publish script applied it to
					// every file), so a returning visitor's browser keeps a stale copy for up to a week and
					// never sees a defaultVersion bump — the symptom being "the new version only shows in a
					// private tab". Always refetch the pointer (it's ~4 KB); the versioned assets it points
					// to stay immutably cached.
					fetch(assetURL(DEFAULT_LOCALE, "", "releases.json").replace(/\/\/releases/, "/releases"), {
						cache: "reload",
					}).then(async (r) => (r.ok ? normalizeReleasesManifest(await r.json()) : null)),
					import("maplibre-gl"),
					fetchBasemapSource(),
				])

				if (cancelled) return

				if (manifestRes) {
					setManifest(manifestRes)
					setSelectedVersion(manifestRes.defaultVersion)
				}

				if (mapContainerRef.current) {
					const composer = new StyleSpecificationComposer({
						sources: { [MailwomanBaseTileSetID]: basemapSource },
					})
					const style = composer.toJSON()
					style.projection = {
						type: "globe",
					}

					const map = new maplibre.Map({
						container: mapContainerRef.current,
						style,
						center: initialCenter,
						zoom: 3,
						attributionControl: false,
					})

					map.addControl(new maplibre.AttributionControl({ compact: true }))
					map.addControl(new LayerToggleControl(), "top-right")

					setMap(map)

					Object.assign(window as unknown as Record<string, unknown>, { __mailwomanDemoMap: map })

					// const wireTerrain = (): void => {
					// 	if (!map.isStyleLoaded()) {
					// 		map.once("styledata", wireTerrain)
					// 		return
					// 	}

					// 	// try {
					// 	// 	if (map.getSource("terrain")) {
					// 	// 		map.setTerrain({ source: "terrain" })
					// 	// 	}
					// 	// } catch {
					// 	// 	// fall through
					// 	// }
					// }

					// map.on("load", wireTerrain)

					// Add the coverage "fog of war" source + default-off fill layers once the basemap style is
					// ready. Served as XYZ vector tiles by the tile worker; the fills sit beneath the first
					// symbol layer so place labels stay legible.
					const coverageSourceURL = `${TILE_WORKER_URL}/${CoverageTileSetID}.json`
					const wireCoverage = (): void => {
						if (!map.isStyleLoaded()) {
							map.once("styledata", wireCoverage)

							return
						}

						try {
							if (!map.getSource(CoverageTileSetID)) {
								map.addSource(CoverageTileSetID, createCoverageSource(coverageSourceURL))
							}
							const firstSymbolID = map.getStyle().layers?.find((l) => l.type === "symbol")?.id

							for (const layer of CoverageLayers) {
								if (!map.getLayer(layer.id)) map.addLayer(layer, firstSymbolID)
							}
						} catch (error) {
							console.warn("coverage overlay wiring failed", error)
						}
					}
					map.on("load", wireCoverage)

					// Race-by-dot-density overlay (default-off per-category circle layers), wired like coverage
					// above — but deliberately WITHOUT the `isStyleLoaded()` defer. This handler runs on
					// `load`, when the style *document* is ready, which is all `addSource`/`addLayer` needs.
					// `isStyleLoaded()` ALSO returns false whenever any source's tiles are still streaming, and
					// wireCoverage (which runs first) calls addSource — so on the globe basemap, where tiles
					// stream continuously, gating here would defer on `styledata` forever and the dots would
					// never wire. Coverage gets away with the guard only because it's the first overlay added.
					const raceDotsSourceURL = `${TILE_WORKER_URL}/${RaceDotsTileSetID}.json`
					const wireRaceDots = (): void => {
						try {
							if (!map.getSource(RaceDotsTileSetID)) {
								map.addSource(RaceDotsTileSetID, createRaceDotsSource(raceDotsSourceURL))
							}
							const firstSymbolID = map.getStyle().layers?.find((l) => l.type === "symbol")?.id

							for (const layer of RaceDotsLayers) {
								if (!map.getLayer(layer.id)) map.addLayer(layer, firstSymbolID)
							}
						} catch (error) {
							console.warn("race-dots overlay wiring failed", error)
						}
					}

					map.on("load", wireRaceDots)
				}
			} catch (error) {
				if (cancelled) return

				console.error("Initialization error", error)

				setErrorMessage(error instanceof Error ? error.message : String(error))
				setLoadingProgress("")
			}
		})()

		return () => {
			cancelled = true
		}
	}, [initialCenter])

	// Load the model + FST + WOF DB when the selected version changes. Clearing a now-colliding
	// compare selection is handled in the version <select>'s onChange (not here) so this effect stays
	// a pure load-on-change with no setState in its body.
	useEffect(() => {
		if (!selectedVersion) return
		let cancelled = false
		const release = manifest?.releases.find((r) => r.version === selectedVersion)

		void (async () => {
			try {
				setClassifier(null)
				setFSTMatcher(null)
				setFSTProvenance(null)
				setLookup(null)
				setLookupLoader(null)
				lookupPromiseRef.current = null
				polygonDBRef.current = null
				setResult(null)
				setCalibrator(null)
				setLoadingProgress(`Loading ${selectedVersion} model (~${release?.modelSize ?? "?"})…`)

				const neuralWeb = await import("@mailwoman/neural-web")
				const {
					classifier: cls,
					diagnostics,
					postcodeAnchorLookup,
				} = await neuralWeb.loadNeuralClassifierFromUrls(
					neuralClassifierLoadURLs(DEFAULT_LOCALE, selectedVersion, { hasAnchor: release?.hasAnchor, forceWASM })
				)
				setActiveBackend(
					diagnostics
						? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)`
						: "unknown"
				)

				if (cancelled) return

				if (release?.hasFST) {
					try {
						const fstResult = await loadFSTGazetteer(DEFAULT_LOCALE, selectedVersion)
						setFSTMatcher(fstResult.matcher)

						if (fstResult.provenance) setFSTProvenance(fstResult.provenance)
					} catch {
						// FST not available for this version
					}
				}

				if (release?.hasWOFDb) {
					setLookupLoader(() => async (onProgress?: (bytesRead: number) => void) => {
						// Range-load the DB via sql.js-httpvfs — ~5 MB/session vs the whole 53 MB.
						const { loadHTTPVFSDatabase, WOFCandidateTableLookup } = await import("../../shared/httpvfs-resolver")
						const worker = await loadHTTPVFSDatabase(adminGazetteerURL(), sqljsBaseURL)
						const wofLookup = new WOFCandidateTableLookup(worker)
						// Warm the schema/FTS/abbr/dual-role pages now (idle or first submit) so the first
						// real query starts from a warm page cache; report live transfer while it runs.
						const poll = onProgress
							? window.setInterval(() => void worker.bytesRead().then(onProgress), 300)
							: undefined

						try {
							await wofLookup.warmUp()
						} finally {
							if (poll !== undefined) window.clearInterval(poll)
						}

						return wofLookup
					})
				}

				setClassifier(cls as unknown as MailwomanClassifierLike)
				anchorLookupRef.current = postcodeAnchorLookup ?? null

				// Load the version's calibration table (opt-in display toggle). Tolerate a 404 — older
				// bundles ship none, in which case the toggle stays hidden and the demo shows raw scores.
				try {
					const calRes = await fetch(assetURL(DEFAULT_LOCALE, selectedVersion, "calibration.json"))

					if (calRes.ok) {
						const calTable = await calRes.json()

						// Functional updater: setState would otherwise CALL a bare function arg as an updater.
						if (!cancelled) setCalibrator(() => createCalibrator(calTable))
					}
				} catch {
					// No calibration table for this version.
				}

				setLoadingProgress("")
			} catch (error) {
				if (cancelled) return

				console.error("Error loading resources", error)

				setErrorMessage(error instanceof Error ? error.message : String(error))
				setLoadingProgress("")
			}
		})()

		return () => {
			cancelled = true
		}
	}, [selectedVersion, manifest, forceWASM, sqljsBaseURL])

	// ── Compare classifier loading ─────────────────────────────────────────
	// When compare mode is active and the user selects a compare version, load
	// a second classifier instance independently (via neural-web directly).
	useEffect(() => {
		if (!compareMode || !compareVersion) {
			// Clear the async-loaded compare resources when their inputs go invalid (compare turned off
			// or its version cleared). Centralising the reset here keeps it correct across every entry
			// point that can invalidate compare mode; the set-state-in-effect lint is a false positive
			// for this resource-teardown pattern.
			/* eslint-disable react-hooks/set-state-in-effect -- teardown of external resources on invalid inputs */
			setCompareClassifier(null)
			setCompareResult(null)
			setCompareErrorMessage(null)
			setCompareBackend("")

			/* eslint-enable react-hooks/set-state-in-effect */
			return
		}
		let cancelled = false
		const release = manifest?.releases.find((r) => r.version === compareVersion)

		void (async () => {
			try {
				setCompareClassifier(null)
				setCompareErrorMessage(null)
				setCompareLoading(true)
				setCompareBackend("")

				const neuralWeb = await import("@mailwoman/neural-web")
				const { classifier: cls, diagnostics } = await neuralWeb.loadNeuralClassifierFromUrls(
					neuralClassifierLoadURLs(DEFAULT_LOCALE, compareVersion, { hasAnchor: release?.hasAnchor, forceWASM })
				)

				if (cancelled) return

				setCompareBackend(
					diagnostics
						? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)`
						: "unknown"
				)
				setCompareClassifier(cls as unknown as MailwomanClassifierLike)
			} catch (error) {
				if (cancelled) return
				console.error("Error loading compare classifier", error)
				setCompareErrorMessage(error instanceof Error ? error.message : String(error))
			} finally {
				if (!cancelled) setCompareLoading(false)
			}
		})()

		return () => {
			cancelled = true
		}
	}, [compareMode, compareVersion, manifest, forceWASM])

	// Hot-swap the map style when the operator toggles Docusaurus's color mode. The page sets
	// data-theme="dark" / "light" on <html>; a MutationObserver is the lightest dependency-free way
	// to react without coupling to useColorMode (which occasionally moves between Docusaurus versions).
	useEffect(() => {
		if (typeof document === "undefined") return
		let lastTheme = currentDocusaurusTheme()
		const observer = new MutationObserver(() => {
			const next = currentDocusaurusTheme()

			if (next === lastTheme) return
			lastTheme = next

			// The cartographer theme is currently dark-only; both light + dark land on the same
			// MailwomanBaseFlavor. Re-running setStyle still rebinds the canvas correctly when the
			// operator toggles, and re-wires terrain after the style swap.
			if (!map) return

			void fetchBasemapSource().then((source) => {
				const composer = new StyleSpecificationComposer({
					sources: { [MailwomanBaseTileSetID]: source },
				})
				map.setStyle(composer.toJSON())
				// map.once("styledata", () => {
				// 	try {
				// 		if (map.getSource("terrain")) {
				// 			map.setTerrain({ source: "terrain", exaggeration: 1 })
				// 		}
				// 	} catch {
				// 		// fall through
				// 	}
				// })
			})
		})
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })

		return () => observer.disconnect()
	}, [map])

	// Marker + bbox + camera redraw effect — fires when the resolved candidate changes,
	// either because a new submit landed (resolved[0] picked) or because the operator clicked
	// a candidate in the picker. Centralised here so onSubmit doesn't carry maplibre lifecycle
	// concerns AND the picker doesn't need a map ref.
	useEffect(() => {
		if (!result || result.candidates.length === 0) {
			// Clear any stale marker/bbox from the previous resolve.
			if (markerRef.current) {
				markerRef.current.remove()
				markerRef.current = null
			}

			if (map) {
				clearBbox(map)
			}

			return
		}

		const candidate = result.candidates[selectedCandidateIndex] ?? result.candidates[0]

		if (!candidate) return

		void (async () => {
			if (markerRef.current) {
				markerRef.current.remove()
				markerRef.current = null
			}

			if (!map) return
			clearBbox(map)
			const maplibre = await import("maplibre-gl")
			const marker = new maplibre.Marker({ color: "#e0367c" }).setLngLat([candidate.lon, candidate.lat]).addTo(map)
			markerRef.current = marker

			// Street-level tier (#377): draw the honest uncertainty circle (10 m exact building / calibrated
			// interp radius) and zoom in — no admin polygon for a precise point. Takes precedence over the
			// admin polygon/bbox path below.
			if (candidate.tier && candidate.uncertaintyM != null) {
				drawRadiusCircle(map, candidate.lat, candidate.lon, candidate.uncertaintyM)
				map.flyTo({ center: [candidate.lon, candidate.lat], zoom: candidate.tier === "address_point" ? 17 : 15 })

				return
			}

			// Prefer the crisp admin polygon (lazily-loaded sibling DB) over the bbox rectangle. The points
			// DB only carries min/max lat-lon, so without this the map draws a box around the place; the
			// polygon DB ships the real, simplified boundary keyed by the same WOF id.
			const release = manifest?.releases.find((r) => r.version === selectedVersion)

			if (release?.hasPolygons && selectedVersion && candidate.id) {
				try {
					if (!polygonDBRef.current) {
						polygonDBRef.current = loadPolygonDB(
							assetURL(DEFAULT_LOCALE, selectedVersion, "wof-polygons.db"),
							sqljsBaseURL
						)
					}
					const geom = await (await polygonDBRef.current).get(candidate.id)

					if (geom) {
						drawPlaceGeometry(map, geom)
						const gb = geomBounds(geom)
						map.fitBounds(
							[
								[gb.minLon, gb.minLat],
								[gb.maxLon, gb.maxLat],
							],
							{ padding: 40 }
						)

						return
					}
				} catch (err) {
					// Postcodes (point geometry) and any id absent from the polygon DB land here — fall
					// through to the bbox. Null the ref so a transient fetch failure can retry next resolve.
					console.error("Crisp polygon unavailable; falling back to bbox", err)
					polygonDBRef.current = null
				}
			}

			const b = candidate.bbox

			if (!b && candidate.placetype === "postcode") {
				// Anchor-centroid postcode: no bbox, no polygon — a default ~3 km circle says
				// "approximately here" without inventing a boundary.
				drawApproxCircle(map, candidate.lat, candidate.lon)
				map.flyTo({ center: [candidate.lon, candidate.lat], zoom: 11 })

				return
			}

			if (b && Math.max(b.maxLat - b.minLat, b.maxLon - b.minLon) > 0.001) {
				// No crisp polygon for this place — draw an approximate CIRCLE sized from the bbox
				// rather than the bbox rectangle itself: a rectangle reads as a (wrong) real boundary,
				// a circle reads as the honest "around here" it actually is.
				drawApproxCircle(map, candidate.lat, candidate.lon, b)
				map.fitBounds(
					[
						[b.minLon, b.minLat],
						[b.maxLon, b.maxLat],
					],
					{ padding: 40 }
				)
			} else {
				map.flyTo({ center: [candidate.lon, candidate.lat], zoom: 12 })
			}
		})()
	}, [result, selectedCandidateIndex, selectedVersion, manifest, sqljsBaseURL, map])

	const ensureLookup = useCallback(async (): Promise<MailwomanLookupLike | null> => {
		if (lookup) return lookup

		if (!lookupLoader) return null

		if (!lookupPromiseRef.current) {
			// Honest copy: the DB is range-loaded, so a session transfers a few MB of it — not the
			// whole file. The bytesRead poll below shows the real number as it grows.
			setLoadingProgress("Connecting to place index…")
			lookupPromiseRef.current = lookupLoader((bytesRead) => {
				if (bytesRead > 0) setLoadingProgress(`Loading place index… ${(bytesRead / 1024 / 1024).toFixed(1)} MB fetched`)
			})
		}

		try {
			const l = await lookupPromiseRef.current
			setLookup(l)
			setLoadingProgress("")

			return l
		} catch (error) {
			lookupPromiseRef.current = null
			setLoadingProgress("")
			console.error("Error loading WOF place index", error)
			setErrorMessage(error instanceof Error ? error.message : String(error))

			return null
		}
	}, [lookup, lookupLoader])

	// Lazy-load (and cache) the situs + interp httpvfs lookups for a parsed region's state shard. Both
	// DBs range-load from R2 like wof-hot.db; a lookup touches ~KB. Returns null if the shards aren't
	// hosted for this state (the street tier then no-ops and the admin cascade answers).
	const ensureStreetLookups = useCallback(
		async (slug: string): Promise<StreetLookups | null> => {
			let p = streetLookupsRef.current.get(slug)

			if (!p) {
				p = (async () => {
					const { loadHTTPVFSDatabase } = await import("../../shared/httpvfs-resolver")
					const { HTTPVFSAddressPointLookup, HTTPVFSInterpolator } = await import("../../shared/httpvfs-street")
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

	// Warm the place index + polygon DB during browser idle time. The cold path (UMD script + worker
	// spawn + WASM compile + ~40 SERIAL 64 KB range round-trips — sql.js-httpvfs fetches via sync XHR)
	// costs seconds on a cold cache; paying it while the user reads the page / types means the first
	// submit starts warm. Skipped under Save-Data; ensureLookup's in-flight guard makes racing a real
	// submit safe.
	useEffect(() => {
		if (!lookupLoader || lookup) return
		const connection = (navigator as { connection?: { saveData?: boolean } }).connection

		if (connection?.saveData) return
		let cancelled = false
		const warm = (): void => {
			if (cancelled) return
			void ensureLookup().then(() => {
				if (cancelled) return
				const release = manifest?.releases.find((r) => r.version === selectedVersion)

				if (release?.hasPolygons && selectedVersion && !polygonDBRef.current) {
					const loading = loadPolygonDB(assetURL(DEFAULT_LOCALE, selectedVersion, "wof-polygons.db"), sqljsBaseURL)
					polygonDBRef.current = loading
					loading.catch(() => {
						// Transient failure — null the ref so the next resolve retries.
						if (polygonDBRef.current === loading) polygonDBRef.current = null
					})
				}
			})
		}
		const hasIdleCallback = typeof window.requestIdleCallback === "function" // Safari ships without it
		const idleID = hasIdleCallback ? window.requestIdleCallback(warm, { timeout: 4000 }) : window.setTimeout(warm, 1500)

		return () => {
			cancelled = true

			if (hasIdleCallback) window.cancelIdleCallback(idleID)
			else window.clearTimeout(idleID)
		}
	}, [lookupLoader, lookup, ensureLookup, manifest, selectedVersion, sqljsBaseURL])

	// Place-autocomplete: debounced FST prefix walk over the locality being typed (the segment after the
	// last comma). Runs against the in-memory gazetteer FST already loaded for the parser — no fetch,
	// microsecond walk. dedupeByName so the dropdown isn't four "New London"s. (#587)
	useEffect(() => {
		if (suppressAutocompleteRef.current) {
			suppressAutocompleteRef.current = false
			setSuggestions([])
			setActiveSuggestion(-1)

			return
		}
		const acQuery = (text.includes(",") ? text.slice(text.lastIndexOf(",") + 1) : text).trim()

		if (!fstMatcher || acQuery.length < 2 || /^\d/.test(acQuery)) {
			// eslint-disable-next-line react-hooks/set-state-in-effect
			setSuggestions([])
			setActiveSuggestion(-1)

			return
		}
		const handle = window.setTimeout(async () => {
			try {
				const { autocomplete } = await import("@mailwoman/resolver-wof-sqlite/fst-autocomplete")
				const res = autocomplete(fstMatcher as unknown as Parameters<typeof autocomplete>[0], acQuery, {
					maxSuggestions: 6,
					dedupeByName: true,
				})
				setSuggestions(res.suggestions.map((s) => ({ name: s.name, placetype: s.placetype })))
				setActiveSuggestion(-1)
			} catch {
				setSuggestions([])
				setActiveSuggestion(-1)
			}
		}, 150)

		return () => window.clearTimeout(handle)
	}, [text, fstMatcher])

	/**
	 * Fill a chosen place — replace the locality segment the user was typing (after the last comma).
	 */
	const onPickSuggestion = useCallback((name: string) => {
		suppressAutocompleteRef.current = true
		setText((cur) => (cur.includes(",") ? `${cur.slice(0, cur.lastIndexOf(",") + 1)} ${name}` : name))
		setSuggestions([])
		setActiveSuggestion(-1)
	}, [])

	/**
	 * Combobox keyboard nav over the "Did you mean" suggestions: ↓/↑ move the highlight (clamped), Enter accepts the
	 * highlighted one (and suppresses the form submit), Esc dismisses the list. With nothing highlighted, Enter falls
	 * through to the normal submit so typing an address + Enter still parses.
	 */
	const onInputKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (suggestions.length === 0) return

			switch (e.key) {
				case "ArrowDown":
					e.preventDefault()
					setActiveSuggestion((i) => Math.min(i + 1, suggestions.length - 1))
					break
				case "ArrowUp":
					e.preventDefault()
					setActiveSuggestion((i) => Math.max(i - 1, 0))
					break
				case "Enter":
					if (activeSuggestion >= 0 && activeSuggestion < suggestions.length) {
						e.preventDefault()
						onPickSuggestion(suggestions[activeSuggestion]!.name)
					}
					break
				case "Escape":
					e.preventDefault()
					setSuggestions([])
					setActiveSuggestion(-1)
					break
			}
		},
		[suggestions, activeSuggestion, onPickSuggestion]
	)

	const onSubmit = useCallback(
		async (e: React.SubmitEvent<HTMLFormElement>) => {
			e.preventDefault()

			if (!classifier) return
			setBusy(true)
			setParseStage(0)
			setErrorMessage(null)
			setCompareResult(null)

			try {
				// Stage 2.4 + 2.5: compute QueryShape + kind classification. Pure functions, ~µs.
				// Surfaced in the UI so users see the staged pipeline working.
				const [{ computeQueryShape }, { classifyKindSync }, { runPipeline }, { groupPhrases }] = await Promise.all([
					import("@mailwoman/query-shape"),
					import("@mailwoman/kind-classifier"),
					import("@mailwoman/core/pipeline"),
					import("@mailwoman/phrase-grouper"),
				])
				const tStart = performance.now()
				const queryShape = computeQueryShape(text)
				const kindResult = classifyKindSync({ raw: text, normalized: text }, queryShape)
				const tShape = performance.now()

				// Run the full runtime pipeline — phrase grouper (Stage 2.7) + the argmax decode
				// (joint-reconcile was retired as the default, #566) — instead of the raw
				// `classifier.parse`. This is what surfaces multi-word localities, Romance street
				// prefixes, and the correct house-number boundary in the browser, matching the library +
				// CLI. Normalize / locale / kind default inside runPipeline; the SHARED resolver runs
				setParseStage(1)

				// below over the demo's byte-range candidate lookup (#861).
				const { tree } = await runPipeline(text, {
					computeQueryShape,
					groupPhrases,
					classifier: classifier as unknown as Parameters<typeof runPipeline>[1]["classifier"],
					fst: (fstMatcher ?? undefined) as Parameters<typeof runPipeline>[1]["fst"],
				})
				const tClassify = performance.now()

				// Debug drawer (#941): trace the SAME input through the decode path when dev mode is on.
				// Best-effort + feature-detected — a trace failure or an older bundle never blocks the parse.
				if (debug && classifier.traceParse) {
					classifier
						.traceParse(text, { addressSystemConventions: "auto" })
						.then(setDebugTrace)
						.catch(() => setDebugTrace(null))
				} else if (!debug) {
					setDebugTrace(null)
				}
				const nodes = flattenTree(tree)
				const localityNodes = nodes.filter((n) => n.tag === "locality" || n.tag === "city")
				// Highest-confidence region, not the first in source order: a street name like
				// "Pennsylvania Ave" yields a spurious low-confidence region span that would otherwise
				// hijack the lookup ("Washington, DC" → Washington, PA).
				const stateNode = nodes
					.filter((n) => n.tag === "region" || n.tag === "state")
					.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
				const postcodeNode = nodes.find((n) => n.tag === "postcode" || n.tag === "postal_code")

				// ── Street tier (#377): exact situs point / TIGER interpolation ──
				// Ahead of the admin cascade: when the parse has a street + house number and we host a
				// street shard for the parsed state, resolve the precise coordinate (exact building, or an
				// interpolated estimate with an honest radius). Best-effort + lazy — a miss or an unhosted
				// state silently falls through to the admin centroid below.
				let streetResolution: StreetResolution | null = null
				// Assemble the full street from ALL its component spans in source order — the model often
				// splits it into street + street_suffix (+ prefix/particle), e.g. "Point Lobos" + "Ave". The
				// situs/interp normalizer needs the whole thing ("point lobos avenue") to match.
				const streetParts = nodes
					.filter((n) => STREET_COMPONENT_TAGS.has(n.tag) && String(n.value ?? "").trim())
					.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
				const streetValue = streetParts.map((n) => String(n.value).trim()).join(" ")
				const houseNumberNode = nodes.find((n) => n.tag === "house_number" || n.tag === "house_number_prefix")
				const stateSlug = regionToStateSlug(stateNode?.value as string | undefined)

				if (streetValue && houseNumberNode?.value && stateSlug && HOSTED_STREET_SLUGS.has(stateSlug)) {
					try {
						const street = await ensureStreetLookups(stateSlug)

						if (street) {
							streetResolution = await resolveStreet(
								streetValue,
								String(houseNumberNode.value),
								postcodeNode?.value ? String(postcodeNode.value) : undefined,
								localityNodes[0]?.value ? String(localityNodes[0].value) : undefined,
								street.situs,
								street.interp,
								INTERP_RADIUS_BY_REGION[stateSlug] ?? INTERP_RADIUS_DEFAULT
							)
						}
					} catch (streetErr) {
						console.warn("[mailwoman demo] street tier unavailable; falling back to admin cascade", streetErr)
					}
				}

				// ── Compare parse (classifier-only, no FST/WOF) ──────────────────
				// Runs before the WOF lookup so it executes even when the selected
				// version lacks a WOF database. Reuses the already-imported pipeline
				// functions from the primary path — no redundant dynamic imports.
				if (compareMode && compareClassifier) {
					try {
						const cStart = performance.now()
						const cQueryShape = computeQueryShape(text)
						const cKindResult = classifyKindSync({ raw: text, normalized: text }, cQueryShape)
						const cShapeTime = performance.now() - cStart

						const cPipelineResult = await runPipeline(text, {
							computeQueryShape,
							groupPhrases,
							classifier: compareClassifier as unknown as Parameters<typeof runPipeline>[1]["classifier"],
						})
						const cClassifyTime = performance.now() - cStart - cShapeTime
						const cNodes = flattenTree(cPipelineResult.tree)

						setCompareResult({
							input: text,
							tree: cPipelineResult.tree,
							nodes: cNodes,
							resolved: null,
							candidates: [],
							kindResult: cKindResult,
							fstActive: false,
							timing: { shape: cShapeTime, classify: cClassifyTime },
						})
					} catch (compareError) {
						console.error("Error in compare parse", compareError)
						setCompareErrorMessage(compareError instanceof Error ? compareError.message : String(compareError))
					}
				}
				const wofLookup = await ensureLookup()

				if (!wofLookup) {
					setResult({
						input: text,
						tree,
						nodes,
						resolved: null,
						candidates: [],
						stateHint: stateNode?.value as string | undefined,
						kindResult,
						fstActive: fstMatcher !== null,
						fstProvenance,
						timing: { shape: tShape - tStart, classify: tClassify - tShape },
					})

					return
				}

				setParseStage(2)

				// Open the polygon DB now (no await) so its worker spawn + header/schema range fetches
				// overlap the cascade below — by the time a candidate renders, the geometry query is the
				// only cold work left. The idle warm-up usually got here first; this covers a fast submit.
				const releaseForResolve = manifest?.releases.find((r) => r.version === selectedVersion)

				if (releaseForResolve?.hasPolygons && selectedVersion && !polygonDBRef.current) {
					const loading = loadPolygonDB(assetURL(DEFAULT_LOCALE, selectedVersion, "wof-polygons.db"), sqljsBaseURL)
					polygonDBRef.current = loading
					loading.catch(() => {
						if (polygonDBRef.current === loading) polygonDBRef.current = null
					})
				}

				// Admin resolution (#861): the SHARED `resolveTree` — greedy walk + admin/explicit-country
				// coherence (#263/#822) + span-rescore recovery (#370, internal, default-on) — over the
				// byte-range candidate lookup. Same passes as the server; the pin ordering (postcode most
				// precise, cross-country gate) lives in runCascade's hit extraction.
				// Viewport bias (#938): the map's current center is a SOFT proximity hint, so an in-view
				// namesake sorts ahead of a distant one at equal exact-tier (48026 → Fraser MI when you're
				// looking at Michigan, Russi IT near Ravenna). The library's decay is population-CEILINGED,
				// so a huge population gap still wins regardless of the view — "Paris" stays Paris, FR even
				// from a US-centered map. Only hint once the user has zoomed past the global view; a
				// whole-globe center is noise. Geolocation, when granted, joins as a second weaker hint.
				const bias: ResolveBias = []

				if (map && map.getZoom() >= 4) {
					const c = map.getCenter()
					bias.push({ lat: c.lat, lon: c.lng, weight: 1 })
				}

				if (geoBiasRef.current) bias.push({ ...geoBiasRef.current, weight: 0.6 })

				// Timed from here so the one-time DB load above doesn't skew the resolve number.
				const tBeforeResolve = performance.now()
				const cascadeHits = await runCascade(wofLookup, tree as { roots: unknown[] }, text, bias)
				const tResolve = performance.now()

				// Anchor-centroid fallback (postcode-only dead ends): WOF ships placeholder (0,0) for
				// ~22% of US postcodes and the cascade rightly drops those — but postcode-us.bin (the
				// model's anchor channel, already loaded) carries a real centroid for every US ZIP.
				// Same-artifact reuse: synthesize an approximate hit so the map shows the honest circle
				// instead of nothing. id=0 → the polygon path skips it; bbox omitted → default radius.
				if (cascadeHits.length === 0 && postcodeNode?.value && anchorLookupRef.current) {
					const anchorHit = anchorLookupRef.current.get(String(postcodeNode.value).toUpperCase())

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
				const candidates: ResolvedHit[] = cascadeHits.map((c) => ({
					id: c.id,
					name: c.name,
					placetype: c.placetype,
					lat: c.lat,
					lon: c.lon,
					score: c.score,
					bbox: c.bbox,
				}))

				// Street-level coordinate wins the pin (more precise than any admin centroid). The admin
				// candidates stay in the list for the resolved-hierarchy context. id=0 → not a WOF place, so
				// the marker effect skips the polygon path and draws the calibrated uncertainty circle.
				if (streetResolution) {
					candidates.unshift({
						id: 0,
						name: `${String(houseNumberNode!.value)} ${streetValue}`,
						placetype: streetResolution.tier,
						lat: streetResolution.lat,
						lon: streetResolution.lon,
						score: 1,
						tier: streetResolution.tier,
						uncertaintyM: streetResolution.uncertaintyM,
					})
				}

				// Marker draw is centralised in the useEffect below — it reacts to result +
				// selectedCandidateIndex changes. Just stash the candidates; the effect handles
				// clearing stale marker/bbox AND rendering the new selection.
				// Dual-role (#402): surface whether the resolved place doubles as another admin tier — a
				// city-state (Berlin = locality AND region) or a capital-seat. Best-effort + optional: the
				// lookup returns [] when the slim DB predates the coincident_roles relation.
				let dualRoles: DualRole[] | undefined
				const primaryHit = candidates[0]

				if (primaryHit && wofLookup.coincidentRolesFor) {
					try {
						const roles = await wofLookup.coincidentRolesFor(primaryHit.id)

						if (roles.length > 0) dualRoles = roles
					} catch {
						/* relation absent / query failed → no dual-role badge */
					}
				}

				setSelectedCandidateIndex(0)
				setResult({
					input: text,
					tree,
					nodes,
					resolved: candidates[0] ?? null,
					candidates,
					stateHint: stateNode?.value as string | undefined,
					kindResult,
					fstActive: fstMatcher !== null,
					fstProvenance,
					timing: { shape: tShape - tStart, classify: tClassify - tShape, resolve: tResolve - tBeforeResolve },
					dualRoles,
				})
			} catch (parsingError) {
				console.error("Error parsing input", parsingError)
				setErrorMessage(parsingError instanceof Error ? parsingError.message : String(parsingError))
			} finally {
				setBusy(false)
				setParseStage(-1)
			}
		},
		[
			classifier,
			text,
			fstMatcher,
			ensureLookup,
			ensureStreetLookups,
			fstProvenance,
			compareMode,
			compareClassifier,
			manifest,
			selectedVersion,
			sqljsBaseURL,
			map,
			debug,
		]
	)

	const ready = classifier !== null
	const currentRelease = manifest?.releases.find((r) => r.version === selectedVersion)

	return (
		<div className={styles.layout}>
			{/* Map fills entire viewport — rendered first so it's behind the floating panel */}
			<section className={styles.mapWrap}>
				<div ref={mapContainerRef} className={styles.map} />
				<DebugControl map={map} />
			</section>
			{/* Floating control panel */}
			<section className={styles.controls}>
				<AboutDemo />
				{currentRelease ? (
					<p className={styles.versionInfo}>
						<strong>{currentRelease.version}</strong> — {currentRelease.description} ({currentRelease.modelSize},{" "}
						{currentRelease.tokenizerVocab.toLocaleString()} vocab, {currentRelease.steps.toLocaleString()} steps)
					</p>
				) : null}
				{manifest && manifest.releases.length > 1 ? (
					<div style={{ marginBottom: "0.75rem" }}>
						<label htmlFor="version-select" style={{ display: "block", marginBottom: "0.25rem", fontWeight: 600 }}>
							Model version
						</label>
						<select
							id="version-select"
							value={selectedVersion ?? ""}
							onChange={(e) => {
								const version = e.target.value
								setSelectedVersion(version)
								// Keep the compare selection distinct from the primary one.
								setCompareVersion((prev) => (prev === version ? null : prev))
							}}
							disabled={busy}
							style={{ width: "100%", padding: "0.4rem" }}
						>
							{manifest.releases.map((r) => (
								<option key={r.version} value={r.version}>
									{r.label}
								</option>
							))}
						</select>
					</div>
				) : null}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: "0.75rem",
						marginBottom: "0.75rem",
						fontSize: "0.85rem",
					}}
				>
					{activeBackend ? (
						<span style={{ opacity: 0.7 }}>
							Backend: <code>{activeBackend}</code>
						</span>
					) : null}
					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: "0.25rem",
							cursor: "pointer",
							opacity: 0.7,
						}}
					>
						<input type="checkbox" checked={forceWASM} onChange={(e) => setForceWASM(e.target.checked)} />
						Force WASM
					</label>
					{manifest && manifest.releases.length > 1 ? (
						<label
							style={{
								display: "flex",
								alignItems: "center",
								gap: "0.25rem",
								cursor: "pointer",
								opacity: 0.7,
							}}
						>
							<input
								type="checkbox"
								checked={compareMode}
								onChange={(e) => {
									setCompareMode(e.target.checked)

									if (!e.target.checked) {
										setCompareResult(null)
										setCompareErrorMessage(null)
									}
								}}
							/>
							Compare
						</label>
					) : null}
				</div>
				{compareMode && manifest && manifest.releases.length > 1 ? (
					<div style={{ marginBottom: "0.75rem" }}>
						<label
							htmlFor="compare-version-select"
							style={{ display: "block", marginBottom: "0.25rem", fontWeight: 600 }}
						>
							Compare with
						</label>
						<select
							id="compare-version-select"
							value={compareVersion ?? ""}
							onChange={(e) => setCompareVersion(e.target.value || null)}
							disabled={busy || compareLoading}
							style={{ width: "100%", padding: "0.4rem" }}
						>
							<option value="">Select version…</option>
							{manifest.releases
								.filter((r) => r.version !== selectedVersion)
								.map((r) => (
									<option key={r.version} value={r.version}>
										{r.label}
									</option>
								))}
						</select>
						{compareLoading ? (
							<p className={styles.status}>Loading {compareVersion} model…</p>
						) : compareBackend ? (
							<span style={{ fontSize: "0.8rem", opacity: 0.7 }}>
								Backend: <code>{compareBackend}</code>
							</span>
						) : null}
					</div>
				) : null}
				<form onSubmit={onSubmit}>
					<label htmlFor="addr-input">Address</label>
					<input
						id="addr-input"
						type="text"
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={onInputKeyDown}
						disabled={!ready || busy}
						placeholder={DEFAULT_ADDRESS}
						role="combobox"
						aria-expanded={suggestions.length > 0}
						aria-controls="addr-suggest-list"
						aria-autocomplete="list"
						aria-activedescendant={activeSuggestion >= 0 ? `addr-suggest-${activeSuggestion}` : undefined}
						autoComplete="off"
					/>
					<button type="submit" disabled={!ready || busy}>
						{busy ? "Parsing…" : "Parse + resolve"}
					</button>
				</form>
				<div className={styles.examples}>
					<span className={styles.examplesLabel}>Bias:</span>
					<button
						type="button"
						className={styles.exampleBtn}
						aria-pressed={geoBiasOn}
						style={geoBiasOn ? { outline: "2px solid var(--ifm-color-primary)", outlineOffset: "1px" } : undefined}
						title="Add your device location as a soft proximity hint (in addition to the map view). Never a hard filter — a strong population signal still wins."
						onClick={() => {
							if (geoBiasOn) {
								geoBiasRef.current = null
								setGeoBiasOn(false)

								return
							}

							if (typeof navigator === "undefined" || !navigator.geolocation) return
							navigator.geolocation.getCurrentPosition(
								(pos) => {
									geoBiasRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude }
									setGeoBiasOn(true)
								},
								() => setGeoBiasOn(false),
								{ maximumAge: 600_000, timeout: 8_000 }
							)
						}}
					>
						{geoBiasOn ? "📍 Using your location" : "📍 Use my location"}
					</button>
					<span className={styles.examplesLabel} style={{ opacity: 0.7 }}>
						the map view already biases nearby namesakes
					</span>
				</div>
				{suggestions.length > 0 ? (
					<div className={styles.examples} id="addr-suggest-list" role="listbox" aria-label="Place suggestions">
						<span className={styles.examplesLabel}>Did you mean:</span>
						{suggestions.map((s, i) => (
							<button
								key={`${s.name}-${i}`}
								id={`addr-suggest-${i}`}
								type="button"
								role="option"
								aria-selected={i === activeSuggestion}
								className={styles.exampleBtn}
								style={
									i === activeSuggestion
										? { outline: "2px solid var(--ifm-color-primary)", outlineOffset: "1px" }
										: undefined
								}
								onMouseEnter={() => setActiveSuggestion(i)}
								onClick={() => onPickSuggestion(s.name)}
								title={s.placetype}
							>
								{s.name}
							</button>
						))}
					</div>
				) : null}
				<div className={styles.examples}>
					<span className={styles.examplesLabel}>Try:</span>
					{EXAMPLE_ADDRESSES.map((ex) => (
						<button
							key={ex.label}
							type="button"
							className={styles.exampleBtn}
							disabled={!ready || busy}
							onClick={() => {
								setText(ex.address)
								setResult(null)
							}}
							title={ex.address}
						>
							{ex.label}
						</button>
					))}
					<PermalinkButton text={text} />
				</div>
				{busy ? <LoadingIndicator mode="staged" steps={parseStageLabels} activeStep={parseStage} /> : null}
				{loadingProgress ? <p className={styles.status}>{loadingProgress}</p> : null}
				{errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}
				{compareErrorMessage ? <p className={styles.error}>{compareErrorMessage}</p> : null}
				{result && calibrator ? (
					<label
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 6,
							fontSize: 13,
							margin: "8px 0",
							cursor: "pointer",
							color: "var(--ifm-color-emphasis-800)",
						}}
						title="Map each span's raw softmax confidence to its calibrated probability of being correct (isotonic, held-out ECE 0.0055). The model is under-confident, so most spans shift upward."
					>
						<input
							type="checkbox"
							checked={calibrateConfidence}
							onChange={(e) => setCalibrateConfidence(e.target.checked)}
						/>
						Calibrated confidence
						<span style={{ color: "var(--ifm-color-emphasis-600)" }}>
							{calibrateConfidence ? "— honest probability of correct" : "— raw softmax scores"}
						</span>
					</label>
				) : null}
				{classifier?.traceParse ? (
					<label
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 6,
							fontSize: 13,
							margin: "8px 0",
							cursor: "pointer",
							color: "var(--ifm-color-emphasis-800)",
						}}
						title="Open the model-visualizer drawer: trace this address through the decode path — tokens, retrieval channels, emissions, priors, repairs — beside the map."
					>
						<input
							type="checkbox"
							checked={debug}
							onChange={(e) => {
								setDebug(e.target.checked)

								if (!e.target.checked) setDebugTrace(null)
								else if (result && classifier.traceParse) {
									classifier
										.traceParse(text, { addressSystemConventions: "auto" })
										.then(setDebugTrace)
										.catch(() => setDebugTrace(null))
								}
							}}
						/>
						🐛 Dev mode
						<span style={{ color: "var(--ifm-color-emphasis-600)" }}>— trace the decode path</span>
					</label>
				) : null}
				{result ? (
					<ResultPanel
						result={displayResult ?? result}
						selectedCandidateIndex={selectedCandidateIndex}
						onSelectCandidate={setSelectedCandidateIndex}
					/>
				) : null}
				{compareResult && result ? (
					<VersionCompare
						primary={result}
						compare={compareResult}
						primaryVersion={selectedVersion ?? "?"}
						compareVersion={compareVersion ?? "?"}
					/>
				) : null}
			</section>

			{/* Model-visualizer drawer — slides over the map's right edge so you inspect the SAME address
			    the map is geocoding without leaving the demo. Mounts only in dev mode with a trace ready. */}
			{debug && debugTrace ? (
				<aside className={styles.debugDrawer} aria-label="Model decode-path visualizer">
					<div className={styles.debugDrawerHeader}>
						<strong>🐛 Decode path</strong>
						<button
							type="button"
							className={styles.exampleBtn}
							onClick={() => setDebug(false)}
							aria-label="Close debug drawer"
						>
							✕
						</button>
					</div>
					<ModelVisualizer trace={debugTrace} />
				</aside>
			) : null}
		</div>
	)
}
