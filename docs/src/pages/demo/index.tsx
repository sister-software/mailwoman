/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Mailwoman geocoder demo — fully client-side. Combines:
 *
 *   - `@mailwoman/neural-web` (onnxruntime-web, WASM SIMD with WebGPU fallback) for the BIO classifier.
 *   - `@mailwoman/resolver-wof-wasm` (sqlite-wasm) for the WOF locality / postcode lookup.
 *   - `@mailwoman/cartographer` `StyleSpecificationComposer` over the v4 protomaps basemap.
 *
 *   Static-asset bundle (~60 MB cold): `/mailwoman/model.onnx`, `/mailwoman/tokenizer.model`,
 *   `/mailwoman/wof-hot.db`. After first load the browser caches everything.
 */

import "maplibre-gl/dist/maplibre-gl.css"

import BrowserOnly from "@docusaurus/BrowserOnly"
import useDocusaurusContext from "@docusaurus/useDocusaurusContext"
import { MailwomanBaseTileSetID, StyleSpecificationComposer } from "@mailwoman/cartographer/base"
import Layout from "@theme/Layout"
import type { Map as MapLibreMap, StyleSpecification, VectorSourceSpecification } from "maplibre-gl"
import React, { useCallback, useEffect, useRef, useState } from "react"

import { LayerToggleControl } from "../../components/LayerToggleControl/LayerToggleControl.tsx"
import { PermalinkButton } from "../../components/PermalinkButton/PermalinkButton.tsx"
import { ResultPanel } from "../../components/ResultPanel/ResultPanel.tsx"
import {
	assetUrl,
	DemoResult,
	FstMatcherLike,
	FstProvenanceLike,
	loadFstGazetteer,
	MailwomanClassifierLike,
	MailwomanLookupLike,
	ResolvedHit,
} from "../../shared/resources.tsx"

import styles from "./styles.module.css"

const DEFAULT_LOCALE = "en-us"

const DEFAULT_ADDRESS = "1600 Pennsylvania Ave NW, Washington, DC 20500"

const EXAMPLE_ADDRESSES: Array<{ label: string; address: string }> = [
	{ label: "White House", address: "1600 Pennsylvania Ave NW, Washington, DC 20500" },
	{ label: "Empire State", address: "350 5th Ave, New York, NY 10118" },
	{ label: "Pier 39 SF", address: "Pier 39, San Francisco, CA 94133" },
	{ label: "Wrigley Field", address: "1060 W Addison St, Chicago, IL 60613" },
	{ label: "Space Needle", address: "400 Broad St, Seattle, WA 98109" },
	{ label: "ZIP only", address: "90210" },
]

const BASEMAP_TILEJSON_URL = "https://tiles.sister.software/basemap-v4.json"

interface ReleaseInfo {
	version: string
	label: string
	description: string
	modelSize: string
	tokenizerVocab: number
	steps: number
	hasFst: boolean
	hasWofDb: boolean
}

interface ReleasesManifest {
	locale: string
	defaultVersion: string
	releases: ReleaseInfo[]
}

const DemoPage: React.FC = () => {
	const { siteConfig } = useDocusaurusContext()
	const buildCommit = (siteConfig.customFields?.buildCommit as string) ?? "?"
	const buildTimeDisplay = (siteConfig.customFields?.buildTimeDisplay as string) ?? "?"

	return (
		<Layout title="Demo" description="Client-side address geocoder demo for mailwoman.">
			<main className={styles.demoRoot}>
				<header className={styles.header}>
					<h1>Mailwoman geocoder demo</h1>
					<p>
						Type a US address. The neural classifier and supporting data run entirely in your browser — no server
						round-trips after the initial asset load.
					</p>
				</header>
				<BrowserOnly fallback={<p>Loading…</p>}>{() => <DemoApp />}</BrowserOnly>
				<footer
					style={{ marginTop: "2rem", padding: "1rem 0", opacity: 0.4, fontSize: "0.75rem", textAlign: "center" }}
				>
					Build {buildCommit} · {buildTimeDisplay}
				</footer>
			</main>
		</Layout>
	)
}

export default DemoPage

// All heavy logic lives below the BrowserOnly boundary — only loaded after Docusaurus hydrates.

function initialAddress(): string {
	if (typeof window === "undefined") return DEFAULT_ADDRESS
	const url = new URL(window.location.href)
	return url.searchParams.get("q") ?? DEFAULT_ADDRESS
}

const DemoApp: React.FC = () => {
	const [manifest, setManifest] = useState<ReleasesManifest | null>(null)
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
	const [loadingProgress, setLoadingProgress] = useState<string>("Loading releases…")
	const [classifier, setClassifier] = useState<MailwomanClassifierLike | null>(null)
	const [fstMatcher, setFstMatcher] = useState<FstMatcherLike | null>(null)
	const [fstProvenance, setFstProvenance] = useState<FstProvenanceLike | null>(null)
	const [forceWasm, setForceWasm] = useState(false)
	const [activeBackend, setActiveBackend] = useState<string>("")
	const [lookupLoader, setLookupLoader] = useState<(() => Promise<MailwomanLookupLike>) | null>(null)
	const [lookup, setLookup] = useState<MailwomanLookupLike | null>(null)
	const [text, setText] = useState(initialAddress)
	const [busy, setBusy] = useState(false)
	const [result, setResult] = useState<DemoResult | null>(null)
	const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(0)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const mapContainerRef = useRef<HTMLDivElement>(null)
	const mapRef = useRef<MapLibreMap | null>(null)
	const markerRef = useRef<{ remove: () => void } | null>(null)

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

	// Mount: fetch the releases manifest + set up the map.
	useEffect(() => {
		let cancelled = false
		void (async () => {
			try {
				const [manifestRes, maplibre, basemapSource] = await Promise.all([
					fetch(assetUrl(DEFAULT_LOCALE, "", "releases.json").replace(/\/\/releases/, "/releases")).then((r) =>
						r.ok ? (r.json() as Promise<ReleasesManifest>) : null
					),
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
					const style = composer.toJSON() as StyleSpecification
					const map = new maplibre.Map({
						container: mapContainerRef.current,
						style,
						center: [-95.7129, 37.0902],
						zoom: 3,
						attributionControl: false,
					})
					map.addControl(new maplibre.AttributionControl({ compact: true }))
					map.addControl(new LayerToggleControl(), "top-right")
					mapRef.current = map
					Object.assign(window as unknown as Record<string, unknown>, { __mailwomanDemoMap: map })
					const wireTerrain = (): void => {
						if (!map.isStyleLoaded()) {
							map.once("styledata", wireTerrain)
							return
						}

						try {
							if (map.getSource("terrain")) {
								map.setTerrain({ source: "terrain", exaggeration: 1 })
							}
						} catch {
							// fall through
						}
					}
					map.on("load", wireTerrain)
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
	}, [])

	// Load the model + FST + WOF DB when the selected version changes.
	useEffect(() => {
		if (!selectedVersion) return
		let cancelled = false
		const release = manifest?.releases.find((r) => r.version === selectedVersion)

		void (async () => {
			try {
				setClassifier(null)
				setFstMatcher(null)
				setFstProvenance(null)
				setLookup(null)
				setLookupLoader(null)
				setResult(null)
				setLoadingProgress(`Loading ${selectedVersion} model (~${release?.modelSize ?? "?"})…`)

				const neuralWeb = await import("@mailwoman/neural-web")
				const { classifier: cls, diagnostics } = await neuralWeb.loadNeuralClassifierFromUrls({
					modelUrl: assetUrl(DEFAULT_LOCALE, selectedVersion, "model.onnx"),
					tokenizerUrl: assetUrl(DEFAULT_LOCALE, selectedVersion, "tokenizer.model"),
					modelCardUrl: assetUrl(DEFAULT_LOCALE, selectedVersion, "model-card.json"),
					runner: { useWebGpu: !forceWasm },
				})
				setActiveBackend(
					diagnostics
						? `${diagnostics.backend} (${(diagnostics.modelBytes / 1024 / 1024).toFixed(0)} MB int8)`
						: "unknown"
				)

				if (cancelled) return

				if (release?.hasFst) {
					try {
						const fstResult = await loadFstGazetteer(DEFAULT_LOCALE, selectedVersion)
						setFstMatcher(fstResult.matcher)
						if (fstResult.provenance) setFstProvenance(fstResult.provenance)
					} catch {
						// FST not available for this version
					}
				}

				if (release?.hasWofDb) {
					setLookupLoader(() => async () => {
						const resolverWasm = await import("@mailwoman/resolver-wof-wasm")
						const { db } = await resolverWasm.loadSlimWofDatabase({
							source: assetUrl(DEFAULT_LOCALE, selectedVersion, "wof-hot.db"),
						})
						return new resolverWasm.WofWasmPlaceLookup({ db })
					})
				}

				setClassifier(cls as unknown as MailwomanClassifierLike)
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
	}, [selectedVersion, manifest, forceWasm])

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
			const map = mapRef.current
			if (!map) return
			void fetchBasemapSource().then((source) => {
				const composer = new StyleSpecificationComposer({
					sources: { [MailwomanBaseTileSetID]: source },
				})
				map.setStyle(composer.toJSON() as StyleSpecification)
				map.once("styledata", () => {
					try {
						if (map.getSource("terrain")) {
							map.setTerrain({ source: "terrain", exaggeration: 1 })
						}
					} catch {
						// fall through
					}
				})
			})
		})
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
		return () => observer.disconnect()
	}, [])

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
			if (mapRef.current) clearBbox(mapRef.current)
			return
		}
		const candidate = result.candidates[selectedCandidateIndex] ?? result.candidates[0]
		if (!candidate) return
		void (async () => {
			if (markerRef.current) {
				markerRef.current.remove()
				markerRef.current = null
			}
			const map = mapRef.current
			if (!map) return
			clearBbox(map)
			const maplibre = await import("maplibre-gl")
			const marker = new maplibre.Marker({ color: "#e0367c" }).setLngLat([candidate.lon, candidate.lat]).addTo(map)
			markerRef.current = marker
			const b = candidate.bbox
			if (b && Math.max(b.maxLat - b.minLat, b.maxLon - b.minLon) > 0.001) {
				drawBbox(map, b)
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
	}, [result, selectedCandidateIndex])

	const ensureLookup = useCallback(async (): Promise<MailwomanLookupLike | null> => {
		if (lookup) return lookup
		if (!lookupLoader) return null
		setLoadingProgress("Loading WOF locality DB (~35 MB)…")

		try {
			const l = await lookupLoader()
			setLookup(l)
			setLoadingProgress("")
			return l
		} catch (error) {
			setLoadingProgress("")
			console.error("Error loading WOF locality DB", error)
			setErrorMessage(error instanceof Error ? error.message : String(error))
			return null
		}
	}, [lookup, lookupLoader])

	const onSubmit = useCallback(
		async (e: React.SubmitEvent<HTMLFormElement>) => {
			e.preventDefault()
			if (!classifier) return
			setBusy(true)
			setErrorMessage(null)

			try {
				// Stage 2.4 + 2.5: compute QueryShape + kind classification. Pure functions, ~µs.
				// Surfaced in the UI so users see the staged pipeline working.
				const [{ computeQueryShape }, { classifyKindSync }] = await Promise.all([
					import("@mailwoman/query-shape"),
					import("@mailwoman/kind-classifier"),
				])
				const queryShape = computeQueryShape(text)
				const kindResult = classifyKindSync({ raw: text, normalized: text }, queryShape)

				const tree = await classifier.parse(text, { queryShape, fst: fstMatcher ?? undefined })
				const nodes = flattenTree(tree)
				const localityNode = nodes.find((n) => n.tag === "locality" || n.tag === "city")
				const stateNode = nodes.find((n) => n.tag === "region" || n.tag === "state")
				const postcodeNode = nodes.find((n) => n.tag === "postcode" || n.tag === "postal_code")

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
					})
					return
				}

				// Cascade: postcode first (most precise), fall back to locality, then raw text.
				// Drop (lat=0, lon=0) hits — WOF ships placeholder zeros on ~22% of US postcodes.
				const cascadeHits = await runCascade(wofLookup, postcodeNode, localityNode, text)
				const candidates: ResolvedHit[] = cascadeHits.map((c) => ({
					id: c.id,
					name: c.name,
					placetype: c.placetype,
					lat: c.lat,
					lon: c.lon,
					score: c.score,
					bbox: c.bbox,
				}))

				// Marker draw is centralised in the useEffect below — it reacts to result +
				// selectedCandidateIndex changes. Just stash the candidates; the effect handles
				// clearing stale marker/bbox AND rendering the new selection.
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
				})
			} catch (parsingError) {
				console.error("Error parsing input", parsingError)
				setErrorMessage(parsingError instanceof Error ? parsingError.message : String(parsingError))
			} finally {
				setBusy(false)
			}
		},
		[classifier, text, fstMatcher, ensureLookup, fstProvenance]
	)

	const ready = classifier !== null
	const currentRelease = manifest?.releases.find((r) => r.version === selectedVersion)

	return (
		<>
			{currentRelease ? (
				<p style={{ fontSize: "0.9rem", opacity: 0.8, margin: "0 0 1rem" }}>
					<strong>{currentRelease.version}</strong> — {currentRelease.description} ({currentRelease.modelSize},{" "}
					{currentRelease.tokenizerVocab.toLocaleString()} vocab, {currentRelease.steps.toLocaleString()} steps)
				</p>
			) : null}
			<div className={styles.layout}>
				<section className={styles.controls}>
					{manifest && manifest.releases.length > 1 ? (
						<div style={{ marginBottom: "0.75rem" }}>
							<label htmlFor="version-select" style={{ display: "block", marginBottom: "0.25rem", fontWeight: 600 }}>
								Model version
							</label>
							<select
								id="version-select"
								value={selectedVersion ?? ""}
								onChange={(e) => setSelectedVersion(e.target.value)}
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
						<label style={{ display: "flex", alignItems: "center", gap: "0.25rem", cursor: "pointer", opacity: 0.7 }}>
							<input type="checkbox" checked={forceWasm} onChange={(e) => setForceWasm(e.target.checked)} />
							Force WASM
						</label>
					</div>
					<form onSubmit={onSubmit}>
						<label htmlFor="addr-input">Address</label>
						<input
							id="addr-input"
							type="text"
							value={text}
							onChange={(e) => setText(e.target.value)}
							disabled={!ready || busy}
							placeholder={DEFAULT_ADDRESS}
						/>
						<button type="submit" disabled={!ready || busy}>
							{busy ? "Parsing…" : "Parse + resolve"}
						</button>
					</form>
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
					{loadingProgress ? <p className={styles.status}>{loadingProgress}</p> : null}
					{errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}
					{result ? (
						<ResultPanel
							result={result}
							selectedCandidateIndex={selectedCandidateIndex}
							onSelectCandidate={setSelectedCandidateIndex}
						/>
					) : null}
				</section>
				<section className={styles.mapWrap}>
					<div ref={mapContainerRef} className={styles.map} />
				</section>
			</div>
		</>
	)
}

const BBOX_SOURCE = "mailwoman-bbox"
const BBOX_FILL_LAYER = "mailwoman-bbox-fill"
const BBOX_LINE_LAYER = "mailwoman-bbox-line"

/**
 * AddSource / addLayer / removeLayer / removeSource all throw "Style is not done loading" if called
 * too early. Every state-mutating call funnels through here so the initial-load and post-setStyle
 * paths never race.
 */
function whenStyleReady(map: MapLibreMap, fn: () => void): void {
	if (map.isStyleLoaded()) {
		fn()

		return
	}
	map.once("styledata", () => whenStyleReady(map, fn))
}

function drawBbox(map: MapLibreMap, bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number }): void {
	const ring: Array<[number, number]> = [
		[bbox.minLon, bbox.minLat],
		[bbox.maxLon, bbox.minLat],
		[bbox.maxLon, bbox.maxLat],
		[bbox.minLon, bbox.maxLat],
		[bbox.minLon, bbox.minLat],
	]
	const geojson = {
		type: "FeatureCollection" as const,
		features: [
			{
				type: "Feature" as const,
				geometry: { type: "Polygon" as const, coordinates: [ring] },
				properties: {},
			},
		],
	}
	whenStyleReady(map, () => {
		const existing = map.getSource(BBOX_SOURCE) as { setData?: (g: unknown) => void } | undefined
		if (existing && typeof existing.setData === "function") {
			existing.setData(geojson)
			return
		}
		map.addSource(BBOX_SOURCE, { type: "geojson", data: geojson })
		map.addLayer({
			id: BBOX_FILL_LAYER,
			type: "fill",
			source: BBOX_SOURCE,
			paint: { "fill-color": "#e0367c", "fill-opacity": 0.12 },
		})
		map.addLayer({
			id: BBOX_LINE_LAYER,
			type: "line",
			source: BBOX_SOURCE,
			paint: { "line-color": "#e0367c", "line-width": 2 },
		})
	})
}

function clearBbox(map: MapLibreMap): void {
	whenStyleReady(map, () => {
		if (map.getLayer(BBOX_FILL_LAYER)) map.removeLayer(BBOX_FILL_LAYER)
		if (map.getLayer(BBOX_LINE_LAYER)) map.removeLayer(BBOX_LINE_LAYER)
		if (map.getSource(BBOX_SOURCE)) map.removeSource(BBOX_SOURCE)
	})
}

type ParsedNode = { tag: string; value?: unknown; confidence?: number }

async function runCascade(
	lookup: MailwomanLookupLike,
	postcodeNode: ParsedNode | undefined,
	localityNode: ParsedNode | undefined,
	rawText: string
): Promise<Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>> {
	const usable = (
		cs: Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>
	): Awaited<ReturnType<MailwomanLookupLike["findPlace"]>> => cs.filter((c) => !(c.lat === 0 && c.lon === 0))

	if (postcodeNode?.value) {
		const cs = usable(
			await lookup.findPlace({
				text: String(postcodeNode.value),
				placetype: "postalcode",
				country: "US",
				limit: 5,
			})
		)
		if (cs.length > 0) return cs
	}
	if (localityNode?.value) {
		const cs = usable(
			await lookup.findPlace({
				text: String(localityNode.value),
				placetype: "locality",
				country: "US",
				limit: 5,
			})
		)
		if (cs.length > 0) return cs
	}

	return usable(await lookup.findPlace({ text: rawText, country: "US", limit: 5 }))
}

type TreeNode = {
	tag?: string
	value?: unknown
	confidence?: number
	start?: number
	end?: number
	children?: unknown[]
}

function flattenTree(
	tree: unknown
): Array<{ tag: string; value?: unknown; confidence?: number; start?: number; end?: number }> {
	const out: Array<{ tag: string; value?: unknown; confidence?: number; start?: number; end?: number }> = []
	const roots = (tree as { roots?: unknown[] } | null | undefined)?.roots ?? []
	const stack = [...(roots as TreeNode[])]
	while (stack.length) {
		const n = stack.pop()!
		if (typeof n.tag === "string") {
			out.push({ tag: n.tag, value: n.value, confidence: n.confidence, start: n.start, end: n.end })
		}
		if (Array.isArray(n.children)) {
			for (const c of n.children) {
				stack.push(c as TreeNode)
			}
		}
	}

	return out.reverse() // depth-first appended in reverse; flip for source order
}

function currentDocusaurusTheme(): "light" | "dark" {
	if (typeof document === "undefined") return "light"
	return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"
}

async function fetchBasemapSource(): Promise<VectorSourceSpecification> {
	const response = await fetch(BASEMAP_TILEJSON_URL)
	if (!response.ok) {
		throw new Error(`Failed to load basemap tilejson (${response.status})`)
	}
	const meta = (await response.json()) as {
		scheme?: string
		tiles: string[]
		minzoom?: number
		maxzoom?: number
		attribution?: string
		bounds?: [number, number, number, number]
	}

	return {
		type: "vector",
		scheme: meta.scheme as VectorSourceSpecification["scheme"],
		tiles: meta.tiles,
		minzoom: meta.minzoom,
		maxzoom: meta.maxzoom,
		attribution: meta.attribution,
		bounds: meta.bounds,
	}
}
