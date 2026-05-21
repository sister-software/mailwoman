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
import React from "react"

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

function DemoApp(): React.ReactElement {
	const [loadingProgress, setLoadingProgress] = React.useState<string>("Loading neural model…")
	const [classifier, setClassifier] = React.useState<MailwomanClassifierLike | null>(null)
	const [lookupLoader, setLookupLoader] = React.useState<(() => Promise<MailwomanLookupLike>) | null>(null)
	const [lookup, setLookup] = React.useState<MailwomanLookupLike | null>(null)
	const [text, setText] = React.useState("1600 Pennsylvania Ave NW, Washington, DC 20500")
	const [busy, setBusy] = React.useState(false)
	const [result, setResult] = React.useState<DemoResult | null>(null)
	const [error, setError] = React.useState<string | null>(null)
	const mapContainerRef = React.useRef<HTMLDivElement>(null)
	const mapRef = React.useRef<unknown>(null)
	const markerRef = React.useRef<unknown>(null)

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
					const map = new maplibre.Map({
						container: mapContainerRef.current,
						style: buildMapStyle(),
						center: [-95.7129, 37.0902],
						zoom: 3,
						attributionControl: false,
					})
					map.addControl(new maplibre.AttributionControl({ compact: true }))
					mapRef.current = map
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
				const queryString =
					(postcodeNode?.value as string | undefined) ?? (localityNode?.value as string | undefined) ?? text
				const placetype: "locality" | "postalcode" | undefined = postcodeNode
					? "postalcode"
					: localityNode
						? "locality"
						: undefined
				const candidates = await wofLookup.findPlace({
					text: queryString,
					placetype,
					country: "US",
					limit: 5,
				})
				if (candidates.length > 0) {
					const best = candidates[0]!
					resolved = {
						id: best.id,
						name: best.name,
						placetype: best.placetype,
						lat: best.lat,
						lon: best.lon,
						score: best.score,
					}
					// Drop / move the marker.
					const maplibre = await import("maplibre-gl")
					if (mapRef.current && resolved) {
						type MapLike = {
							flyTo: (opts: { center: [number, number]; zoom: number }) => void
							getCenter: () => unknown
						}
						const map = mapRef.current as MapLike
						if (markerRef.current) {
							;(markerRef.current as { remove: () => void }).remove()
						}
						const marker = new maplibre.Marker({ color: "#e0367c" })
							.setLngLat([resolved.lon, resolved.lat])
							.addTo(map as unknown as maplibre.Map)
						markerRef.current = marker
						map.flyTo({ center: [resolved.lon, resolved.lat], zoom: 10 })
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
	return (
		<div className={styles.resultPanel}>
			<h2>Parsed components</h2>
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
}

/**
 * Build a minimal MapLibre style document pointing at the Protomaps basemap vector tiles served by
 * `tiles.sister.software`. The host endpoint exposes only TileJSON (data-source metadata), not a
 * full MapLibre style — so we synthesize one here with the layers we care about for an address
 * demo. Visual styling stays deliberately plain so the marker pops.
 */
function buildMapStyle(): unknown {
	const tileUrl = "https://tiles.sister.software/basemap/{z}/{x}/{y}.mvt"
	const attribution =
		'<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>'
	return {
		version: 8,
		glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
		sources: {
			protomaps: {
				type: "vector",
				tiles: [tileUrl],
				maxzoom: 15,
				attribution,
			},
		},
		layers: [
			{ id: "background", type: "background", paint: { "background-color": "#f7f5f0" } },
			{
				id: "earth",
				type: "fill",
				source: "protomaps",
				"source-layer": "earth",
				paint: { "fill-color": "#fafaf7" },
			},
			{
				id: "water",
				type: "fill",
				source: "protomaps",
				"source-layer": "water",
				paint: { "fill-color": "#cfdfec" },
			},
			{
				id: "landuse",
				type: "fill",
				source: "protomaps",
				"source-layer": "landuse",
				minzoom: 4,
				paint: { "fill-color": "#eef0e3", "fill-opacity": 0.5 },
			},
			{
				id: "roads-major",
				type: "line",
				source: "protomaps",
				"source-layer": "roads",
				minzoom: 5,
				filter: ["in", "pmap:kind", "highway", "major_road"],
				paint: { "line-color": "#d0c8b8", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 14, 3] },
			},
			{
				id: "roads-minor",
				type: "line",
				source: "protomaps",
				"source-layer": "roads",
				minzoom: 11,
				paint: { "line-color": "#e0d8c8", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.3, 16, 1.5] },
			},
			{
				id: "boundaries",
				type: "line",
				source: "protomaps",
				"source-layer": "boundaries",
				paint: {
					"line-color": "#9aa0a6",
					"line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.4, 6, 0.8],
					"line-dasharray": [2, 2],
				},
			},
		],
	}
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
