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

import BrowserOnly from "@docusaurus/BrowserOnly"
import { MailwomanBaseTileSetID, StyleSpecificationComposer } from "@mailwoman/cartographer/base"
import Layout from "@theme/Layout"
import type { Map as MapLibreMap, StyleSpecification, VectorSourceSpecification } from "maplibre-gl"
// MapLibre's marker / control / popup positioning depends on the bundled stylesheet. Without it,
// .maplibregl-marker collapses to a zero-sized inline element and the SVG never paints.
import "maplibre-gl/dist/maplibre-gl.css"
import React, { useCallback, useEffect, useRef, useState } from "react"

import styles from "./styles.module.css"

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

export default function DemoPage(): React.ReactElement {
	return (
		<Layout title="Demo" description="Client-side address geocoder demo for mailwoman.">
			<main className={styles.demoRoot}>
				<header className={styles.header}>
					<h1>Mailwoman geocoder demo</h1>
					<p>
						Type a US address. The neural classifier (~25 MB ONNX) and WOF locality DB (~35 MB SQLite) run entirely in
						your browser — no server round-trips after the initial asset load.
					</p>
				</header>
				<BrowserOnly fallback={<p>Loading…</p>}>{() => <DemoApp />}</BrowserOnly>
			</main>
		</Layout>
	)
}

// All heavy logic lives below the BrowserOnly boundary — only loaded after Docusaurus hydrates.

function initialAddress(): string {
	if (typeof window === "undefined") return DEFAULT_ADDRESS
	const url = new URL(window.location.href)
	return url.searchParams.get("q") ?? DEFAULT_ADDRESS
}

function DemoApp(): React.ReactElement {
	const [loadingProgress, setLoadingProgress] = useState<string>("Loading neural model…")
	const [classifier, setClassifier] = useState<MailwomanClassifierLike | null>(null)
	const [lookupLoader, setLookupLoader] = useState<(() => Promise<MailwomanLookupLike>) | null>(null)
	const [lookup, setLookup] = useState<MailwomanLookupLike | null>(null)
	const [text, setText] = useState(initialAddress)
	const [busy, setBusy] = useState(false)
	const [result, setResult] = useState<DemoResult | null>(null)
	const [error, setError] = useState<string | null>(null)
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

	// Mount: load the neural model + map up-front. The 35 MB WOF DB is deferred until first
	// submit — most visitors poke at parse output without ever hitting "resolve".
	useEffect(() => {
		let cancelled = false
		void (async () => {
			try {
				const [neuralWeb, maplibre, basemapSource] = await Promise.all([
					import("@mailwoman/neural-web"),
					import("maplibre-gl"),
					fetchBasemapSource(),
				])

				if (cancelled) return
				setLoadingProgress("Loading neural model (~25 MB)…")
				const cls = await neuralWeb.loadNeuralClassifierFromUrls({
					modelUrl: "/mailwoman/model.onnx",
					tokenizerUrl: "/mailwoman/tokenizer.model",
				})

				if (cancelled) return
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
					mapRef.current = map
					// Expose for the playwright e2e harness; the suite reads styleLoaded /
					// layers / source-layers off this.
					Object.assign(window as unknown as Record<string, unknown>, { __mailwomanDemoMap: map })

					// setTerrain throws "Style is not done loading" if invoked before the style's
					// sources/sprites are hydrated. `load` fires when the initial viewport renders, but
					// that's earlier than isStyleLoaded(). Poll via styledata until it's truly ready.
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
							// fall through to flat rendering
						}
					}
					map.on("load", wireTerrain)
				}

				if (cancelled) return
				setClassifier(cls)
				// One-shot factory; captured in closure to avoid re-importing the wasm wrapper.
				setLookupLoader(() => async () => {
					const resolverWasm = await import("@mailwoman/resolver-wof-wasm")
					const { db } = await resolverWasm.loadSlimWofDatabase({
						source: "/mailwoman/wof-hot.db",
					})
					return new resolverWasm.WofWasmPlaceLookup({ db })
				})
				setLoadingProgress("")
			} catch (e) {
				if (cancelled) return
				setError((e as Error).message ?? String(e))
				setLoadingProgress("")
			}
		})()
		return () => {
			cancelled = true
		}
	}, [])

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

	const ensureLookup = useCallback(async (): Promise<MailwomanLookupLike | null> => {
		if (lookup) return lookup
		if (!lookupLoader) return null
		setLoadingProgress("Loading WOF locality DB (~35 MB)…")
		try {
			const l = await lookupLoader()
			setLookup(l)
			setLoadingProgress("")
			return l
		} catch (e) {
			setLoadingProgress("")
			setError((e as Error).message ?? String(e))
			return null
		}
	}, [lookup, lookupLoader])

	const onSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault()
			if (!classifier) return
			setBusy(true)
			setError(null)
			try {
				const tree = await classifier.parse(text)
				const nodes = flattenTree(tree)
				const localityNode = nodes.find((n) => n.tag === "locality" || n.tag === "city")
				const stateNode = nodes.find((n) => n.tag === "region" || n.tag === "state")
				const postcodeNode = nodes.find((n) => n.tag === "postcode" || n.tag === "postal_code")

				const wofLookup = await ensureLookup()
				if (!wofLookup) {
					setResult({ tree, nodes, resolved: null, stateHint: stateNode?.value as string | undefined })
					return
				}

				// Cascade: postcode first (most precise), fall back to locality, then raw text.
				// Drop (lat=0, lon=0) hits — WOF ships placeholder zeros on ~22% of US postcodes.
				const candidates = await runCascade(wofLookup, postcodeNode, localityNode, text)

				// Clear any stale marker + bbox before deciding whether to draw a new one — otherwise
				// an unresolvable address after a successful resolve leaves the previous marker on screen.
				if (markerRef.current) {
					markerRef.current.remove()
					markerRef.current = null
				}
				if (mapRef.current) clearBbox(mapRef.current)

				let resolved: ResolvedHit | null = null
				if (candidates.length > 0) {
					const best = candidates[0]!
					resolved = {
						id: best.id,
						name: best.name,
						placetype: best.placetype,
						lat: best.lat,
						lon: best.lon,
						score: best.score,
						bbox: best.bbox,
					}
					const maplibre = await import("maplibre-gl")
					const map = mapRef.current
					if (map && resolved) {
						const marker = new maplibre.Marker({ color: "#e0367c" }).setLngLat([resolved.lon, resolved.lat]).addTo(map)
						markerRef.current = marker
						const b = resolved.bbox
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
							map.flyTo({ center: [resolved.lon, resolved.lat], zoom: 12 })
						}
					}
				}

				setResult({
					tree,
					nodes,
					resolved,
					stateHint: stateNode?.value as string | undefined,
				})
			} catch (e2) {
				setError((e2 as Error).message ?? String(e2))
			} finally {
				setBusy(false)
			}
		},
		[classifier, ensureLookup, text]
	)

	const ready = classifier !== null && lookupLoader !== null

	return (
		<div className={styles.layout}>
			<section className={styles.controls}>
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
							onClick={() => setText(ex.address)}
							title={ex.address}
						>
							{ex.label}
						</button>
					))}
				</div>
				{loadingProgress ? <p className={styles.status}>{loadingProgress}</p> : null}
				{error ? <p className={styles.error}>{error}</p> : null}
				{result ? <ResultPanel result={result} /> : null}
			</section>
			<section className={styles.mapWrap}>
				<div ref={mapContainerRef} className={styles.map} />
			</section>
		</div>
	)
}

function ResultPanel({ result }: { result: DemoResult }): React.ReactElement {
	const [showXml, setShowXml] = useState(false)
	const [xml, setXml] = useState<string | null>(null)

	const onToggle = useCallback(async () => {
		if (xml) {
			setShowXml((v) => !v)
			return
		}
		const { decodeAsXml } = await import("@mailwoman/core/decoder")
		setXml(decodeAsXml(result.tree as Parameters<typeof decodeAsXml>[0]))
		setShowXml(true)
	}, [xml, result.tree])

	return (
		<div className={styles.resultPanel}>
			<div className={styles.resultHeader}>
				<h2>Parsed components</h2>
				<button type="button" className={styles.debugBtn} onClick={onToggle}>
					{showXml ? "Hide XML" : "Show XML"}
				</button>
			</div>
			{showXml && xml ? <pre className={styles.xml}>{xml}</pre> : null}
			<table className={styles.componentTable}>
				<thead>
					<tr>
						<th>tag</th>
						<th>value</th>
						<th>confidence</th>
					</tr>
				</thead>
				<tbody>
					{result.nodes.map((n, i) => (
						<tr key={i}>
							<td>{n.tag}</td>
							<td>{String(n.value ?? "")}</td>
							<td>{n.confidence?.toFixed(2) ?? "—"}</td>
						</tr>
					))}
				</tbody>
			</table>
			{result.resolved ? (
				<div className={styles.resolved}>
					<h2>Resolved place</h2>
					<dl>
						<dt>name</dt>
						<dd>{result.resolved.name}</dd>
						<dt>placetype</dt>
						<dd>{result.resolved.placetype}</dd>
						<dt>WOF id</dt>
						<dd>{result.resolved.id}</dd>
						<dt>coords</dt>
						<dd>
							{result.resolved.lat.toFixed(4)}, {result.resolved.lon.toFixed(4)}
						</dd>
						<dt>score</dt>
						<dd>{result.resolved.score.toFixed(3)}</dd>
					</dl>
				</div>
			) : (
				<p>
					<em>No WOF hit. Try a US locality name or ZIP code that&apos;s in the top-1k slim subset.</em>
				</p>
			)}
		</div>
	)
}

interface MailwomanClassifierLike {
	parse: (text: string) => Promise<unknown>
}

interface MailwomanLookupLike {
	findPlace: (q: {
		text: string
		placetype?: "locality" | "postalcode" | undefined
		country?: string
		limit?: number
	}) => Promise<
		Array<{
			id: number
			name: string
			placetype: string
			lat: number
			lon: number
			score: number
			bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		}>
	>
}

interface DemoResult {
	tree: unknown
	nodes: Array<{ tag: string; value?: unknown; confidence?: number }>
	resolved: ResolvedHit | null
	stateHint?: string
}

interface ResolvedHit {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
	score: number
	bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
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

function flattenTree(tree: unknown): Array<{ tag: string; value?: unknown; confidence?: number }> {
	const out: Array<{ tag: string; value?: unknown; confidence?: number }> = []
	const roots = (tree as { roots?: unknown[] } | null | undefined)?.roots ?? []
	const stack = [...(roots as Array<{ tag?: string; value?: unknown; confidence?: number; children?: unknown[] }>)]
	while (stack.length) {
		const n = stack.pop()!
		if (typeof n.tag === "string") {
			out.push({ tag: n.tag, value: n.value, confidence: n.confidence })
		}
		if (Array.isArray(n.children)) {
			for (const c of n.children) {
				stack.push(c as { tag?: string; value?: unknown; confidence?: number; children?: unknown[] })
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
