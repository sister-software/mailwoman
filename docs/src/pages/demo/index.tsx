/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Mailwoman geocoder demo — fully client-side. Combines:
 *
 *   - `@mailwoman/neural-web` (onnxruntime-web, WASM SIMD with WebGPU fallback) for the BIO classifier.
 *   - `@mailwoman/resolver-wof-wasm` (sqlite-wasm) for the WOF locality / postcode lookup.
 *   - MapLibre GL JS pointed at `https://tiles.sister.software/basemap.json` for the map.
 *
 *   The static-asset bundle includes:
 *
 *   - `/mailwoman/model.onnx` — the v0.2.0 quantized BIO classifier (~25 MB).
 *   - `/mailwoman/tokenizer.model` — SentencePiece tokenizer (~470 KB).
 *   - `/mailwoman/wof-hot.db` — slim WOF distribution (top-1k US localities + all US postcodes, ~35
 *       MB).
 *
 *   Total cold-start asset budget: ~60 MB. After first load the browser caches everything; subsequent
 *   visits are instant.
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import Layout from "@theme/Layout"
// MapLibre's marker / control / popup positioning depends on the bundled stylesheet. Without it,
// .maplibregl-marker collapses to a zero-sized inline element and the SVG never paints.
import "maplibre-gl/dist/maplibre-gl.css"
import React from "react"

import { buildMapStyle, currentMapTheme } from "./_cartography"
import styles from "./styles.module.css"

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

// All heavy logic lives below this boundary — only loaded after Docusaurus hydrates on the client.

/**
 * Read the initial address from the URL `?q=` parameter so links like
 * https://mailwoman.sister.software/demo/?q=1600+Pennsylvania+Ave land directly on a populated
 * input. Decoded once at mount; further edits go through React state and update the URL via
 * history.replaceState (no scroll / reload).
 */
const DEFAULT_ADDRESS = "1600 Pennsylvania Ave NW, Washington, DC 20500"
function initialAddress(): string {
	if (typeof window === "undefined") return DEFAULT_ADDRESS
	const url = new URL(window.location.href)
	return url.searchParams.get("q") ?? DEFAULT_ADDRESS
}

function DemoApp(): React.ReactElement {
	const [loadingProgress, setLoadingProgress] = React.useState<string>("Loading neural model…")
	const [classifier, setClassifier] = React.useState<MailwomanClassifierLike | null>(null)
	const [lookupLoader, setLookupLoader] = React.useState<(() => Promise<MailwomanLookupLike>) | null>(null)
	const [lookup, setLookup] = React.useState<MailwomanLookupLike | null>(null)
	const [text, setText] = React.useState(initialAddress)
	const [busy, setBusy] = React.useState(false)
	const [result, setResult] = React.useState<DemoResult | null>(null)
	const [error, setError] = React.useState<string | null>(null)
	const mapContainerRef = React.useRef<HTMLDivElement>(null)
	const mapRef = React.useRef<unknown>(null)
	const markerRef = React.useRef<unknown>(null)

	// Sync ?q= when the operator edits the address. replaceState avoids polluting back-button
	// history with every keystroke; only the latest state lands in the URL.
	React.useEffect(() => {
		if (typeof window === "undefined") return
		const url = new URL(window.location.href)
		if (text === DEFAULT_ADDRESS) {
			url.searchParams.delete("q")
		} else {
			url.searchParams.set("q", text)
		}
		window.history.replaceState(null, "", url.toString())
	}, [text])

	// Mount: load just the neural model + map up-front. The 35 MB WOF DB is deferred until first
	// resolve — most visitors poke at the parse output without ever hitting "submit", and shipping
	// 35 MB of zip-code geometries to a window-shopper is wasteful.
	React.useEffect(() => {
		let cancelled = false
		void (async () => {
			try {
				const [neuralWeb, maplibre] = await Promise.all([import("@mailwoman/neural-web"), import("maplibre-gl")])

				if (cancelled) return
				setLoadingProgress("Loading neural model (~25 MB)…")
				const cls = await neuralWeb.loadNeuralClassifierFromUrls({
					modelUrl: "/mailwoman/model.onnx",
					tokenizerUrl: "/mailwoman/tokenizer.model",
				})

				if (cancelled) return
				if (mapContainerRef.current) {
					const style = buildMapStyle(currentMapTheme())
					const map = new maplibre.Map({
						container: mapContainerRef.current,
						style: style as maplibre.StyleSpecification,
						center: [-95.7129, 37.0902],
						zoom: 3,
						attributionControl: false,
					})
					map.addControl(new maplibre.AttributionControl({ compact: true }))
					mapRef.current = map
					// Wire 3D terrain once the style + DEM source are loaded.
					map.on("load", () => {
						try {
							map.setTerrain({ source: "terrain", exaggeration: 1 })
						} catch {
							// Some browsers / WebGL contexts reject terrain (no GL_OES_element_index_uint, etc.);
							// fall through to flat rendering rather than breaking the page.
						}
					})
				}

				if (cancelled) return
				setClassifier(cls)
				// Stash a one-shot factory that loads the WOF DB on demand. Captured in closure
				// to avoid re-importing the wasm wrapper.
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
	// to react without dragging in useColorMode (which would couple this file to a theme-internals
	// hook that occasionally moves between Docusaurus versions).
	React.useEffect(() => {
		if (typeof document === "undefined") return
		const observer = new MutationObserver(() => {
			const map = mapRef.current as MaplibreMapLike | null
			if (!map?.setStyle) return
			map.setStyle(buildMapStyle(currentMapTheme()))
		})
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
		return () => observer.disconnect()
	}, [])

	// Resolve the WOF lookup on first submit (or any time we don't have it yet).
	const ensureLookup = React.useCallback(async (): Promise<MailwomanLookupLike | null> => {
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

	const onSubmit = React.useCallback(
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

				// First submit: fetch the WOF DB. Subsequent submits reuse it.
				const wofLookup = await ensureLookup()
				if (!wofLookup) {
					setResult({ tree, nodes, resolved: null, stateHint: stateNode?.value as string | undefined })
					return
				}

				let resolved: ResolvedHit | null = null
				// Cascade: postcode first (most precise), fall back to locality if the postcode hit lacks
				// usable coords (WOF ships ~22% of US postcodes with placeholder lat=0/lon=0 — postcode
				// 20500 is one of them, ironically the White House). Final fallback: the raw input string,
				// which lets the FTS5 index pick up whatever placename it can.
				const candidates = await runCascade(wofLookup, postcodeNode, localityNode, text)
				// Clear any stale marker + bbox from a prior submit before deciding whether to draw a new
				// one — otherwise a "Pier 39" lookup followed by an unresolvable address would leave the
				// SF marker hovering over a mismatched input.
				if (markerRef.current) {
					;(markerRef.current as { remove: () => void }).remove()
					markerRef.current = null
				}
				if (mapRef.current) clearBbox(mapRef.current as MaplibreMapLike)

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
					// Drop a fresh marker + fly to the resolved coords.
					const maplibre = await import("maplibre-gl")
					if (mapRef.current && resolved) {
						const map = mapRef.current as MaplibreMapLike & maplibre.Map
						const marker = new maplibre.Marker({ color: "#e0367c" }).setLngLat([resolved.lon, resolved.lat]).addTo(map)
						markerRef.current = marker
						// If the lookup returned a bbox AND it's non-trivial (postcodes can be tiny —
						// fit-bounds zooms way too far in), use fitBounds so the operator sees the whole
						// place extent. Otherwise just flyTo the centroid with a reasonable city-level zoom.
						const b = resolved.bbox
						if (b && Math.max(b.maxLat - b.minLat, b.maxLon - b.minLon) > 0.001) {
							drawBbox(map, b)
							map.fitBounds?.(
								[
									[b.minLon, b.minLat],
									[b.maxLon, b.maxLat],
								],
								{ padding: 40 }
							)
						} else {
							map.flyTo?.({ center: [resolved.lon, resolved.lat], zoom: 12 })
						}
					}
				}

				setResult({
					tree,
					nodes,
					resolved,
					stateHint: stateNode?.value as string | undefined,
				})
			} catch (e) {
				setError((e as Error).message ?? String(e))
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
						placeholder="1600 Pennsylvania Ave NW, Washington, DC 20500"
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

/** Hand-picked examples that all hit the top-1k slim subset. */
const EXAMPLE_ADDRESSES: Array<{ label: string; address: string }> = [
	{ label: "White House", address: "1600 Pennsylvania Ave NW, Washington, DC 20500" },
	{ label: "Empire State", address: "350 5th Ave, New York, NY 10118" },
	{ label: "Pier 39 SF", address: "Pier 39, San Francisco, CA 94133" },
	{ label: "Wrigley Field", address: "1060 W Addison St, Chicago, IL 60613" },
	{ label: "Space Needle", address: "400 Broad St, Seattle, WA 98109" },
	{ label: "ZIP only", address: "90210" },
]

function ResultPanel({ result }: { result: DemoResult }): React.ReactElement {
	const [showXml, setShowXml] = React.useState(false)
	const [xml, setXml] = React.useState<string | null>(null)

	// Lazy-load the XML serializer the first time the operator asks for debug output. Stripping it
	// from the main bundle keeps the demo's cold-path payload down; tree-shaking can't drop it
	// because the rest of the module re-exports from @mailwoman/core/decoder.
	const onToggle = React.useCallback(async () => {
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
 * Draw / update a rectangle showing the resolved place's bounding box on the map. The slim WOF
 * distribution ships bbox columns on `spr` but not the full polygon geometry — bbox is the best
 * outline we can render without re-shipping the 1.5 GB geojson table.
 */
function drawBbox(
	map: MaplibreMapLike,
	bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number }
): void {
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
	const existing = map.getSource?.(BBOX_SOURCE)
	if (existing && typeof (existing as { setData?: unknown }).setData === "function") {
		;(existing as { setData: (g: unknown) => void }).setData(geojson)
		return
	}
	map.addSource?.(BBOX_SOURCE, { type: "geojson", data: geojson })
	map.addLayer?.({
		id: BBOX_FILL_LAYER,
		type: "fill",
		source: BBOX_SOURCE,
		paint: { "fill-color": "#e0367c", "fill-opacity": 0.12 },
	})
	map.addLayer?.({
		id: BBOX_LINE_LAYER,
		type: "line",
		source: BBOX_SOURCE,
		paint: { "line-color": "#e0367c", "line-width": 2 },
	})
}

function clearBbox(map: MaplibreMapLike): void {
	if (map.getLayer?.(BBOX_FILL_LAYER)) map.removeLayer?.(BBOX_FILL_LAYER)
	if (map.getLayer?.(BBOX_LINE_LAYER)) map.removeLayer?.(BBOX_LINE_LAYER)
	if (map.getSource?.(BBOX_SOURCE)) map.removeSource?.(BBOX_SOURCE)
}

interface MaplibreMapLike {
	flyTo?: (opts: { center: [number, number]; zoom: number }) => void
	fitBounds?: (bounds: [[number, number], [number, number]], opts?: { padding?: number }) => void
	getSource?: (id: string) => unknown
	addSource?: (id: string, source: unknown) => void
	addLayer?: (layer: unknown) => void
	removeLayer?: (id: string) => void
	removeSource?: (id: string) => void
	getLayer?: (id: string) => unknown
	setStyle?: (style: unknown) => void
	on?: (event: string, cb: () => void) => void
}

type ParsedNode = { tag: string; value?: unknown; confidence?: number }

/**
 * Try increasingly broad WOF queries until something with usable coords surfaces. Drops (lat=0,
 * lon=0) hits — WOF carries placeholder zeros on ~22% of US postcodes (including 20500), so the raw
 * "best BM25 hit" is sometimes geographically meaningless.
 */
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

/** Walk the AddressTree, returning a flat list of leaf component nodes. */
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
