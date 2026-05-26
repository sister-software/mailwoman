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
import type { IControl, Map as MapLibreMap, StyleSpecification, VectorSourceSpecification } from "maplibre-gl"
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
						Type a US address. The neural classifier (~17 MB ONNX, int8 quantized) and WOF locality DB (~35 MB SQLite)
						run entirely in your browser — no server round-trips after the initial asset load.
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
	const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(0)
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
					map.addControl(new LayerToggleControl(), "top-right")
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
				// Stage 2.4 + 2.5: compute QueryShape + kind classification. Pure functions, ~µs.
				// Surfaced in the UI so users see the staged pipeline working.
				const [{ computeQueryShape }, { classifyKindSync }] = await Promise.all([
					import("@mailwoman/query-shape"),
					import("@mailwoman/kind-classifier"),
				])
				const queryShape = computeQueryShape(text)
				const kindResult = classifyKindSync({ raw: text, normalized: text }, queryShape)

				const tree = await classifier.parse(text, { queryShape })
				const nodes = flattenTree(tree)
				const localityNode = nodes.find((n) => n.tag === "locality" || n.tag === "city")
				const stateNode = nodes.find((n) => n.tag === "region" || n.tag === "state")
				const postcodeNode = nodes.find((n) => n.tag === "postcode" || n.tag === "postal_code")

				const wofLookup = await ensureLookup()
				if (!wofLookup) {
					setResult({
						tree,
						nodes,
						resolved: null,
						candidates: [],
						stateHint: stateNode?.value as string | undefined,
						kindResult,
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
					tree,
					nodes,
					resolved: candidates[0] ?? null,
					candidates,
					stateHint: stateNode?.value as string | undefined,
					kindResult,
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
					<PermalinkButton text={text} />
				</div>
				{loadingProgress ? <p className={styles.status}>{loadingProgress}</p> : null}
				{error ? <p className={styles.error}>{error}</p> : null}
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
	)
}

function ResultPanel({
	result,
	selectedCandidateIndex,
	onSelectCandidate,
}: {
	result: DemoResult
	selectedCandidateIndex: number
	onSelectCandidate: (index: number) => void
}): React.ReactElement {
	const [showXml, setShowXml] = useState(false)
	const [xml, setXml] = useState<string | null>(null)
	const selected = result.candidates[selectedCandidateIndex] ?? result.candidates[0] ?? null

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
			{result.kindResult ? <KindBadge kindResult={result.kindResult} /> : null}
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
							<td>
								<ConfidenceCell confidence={n.confidence} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{selected ? (
				<>
					<div className={styles.resolved}>
						<h2>Resolved place</h2>
						<dl>
							<dt>name</dt>
							<dd>{selected.name}</dd>
							<dt>placetype</dt>
							<dd>{selected.placetype}</dd>
							<dt>WOF id</dt>
							<dd>{selected.id}</dd>
							<dt>coords</dt>
							<dd>
								{selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}
							</dd>
							<dt>score</dt>
							<dd>{selected.score.toFixed(3)}</dd>
						</dl>
					</div>
					{result.candidates.length > 1 ? (
						<CandidatePicker
							candidates={result.candidates}
							selectedIndex={selectedCandidateIndex}
							onSelect={onSelectCandidate}
						/>
					) : null}
				</>
			) : (
				<FailureDiagnostic nodes={result.nodes} />
			)}
		</div>
	)
}

/**
 * Lets the operator see WOF's runner-up hits and switch the rendered marker to any of them. Helpful
 * when the parser found e.g. "Portland" and WOF returned both Portland-OR and Portland-ME with
 * similar scores — picker disambiguates without re-typing the query.
 */
function CandidatePicker({
	candidates,
	selectedIndex,
	onSelect,
}: {
	candidates: ResolvedHit[]
	selectedIndex: number
	onSelect: (index: number) => void
}): React.ReactElement {
	return (
		<div className={styles.candidatePicker}>
			<h2>Other candidates ({candidates.length - 1})</h2>
			<ol className={styles.candidateList}>
				{candidates.map((c, i) => (
					<li key={`${c.id}-${i}`}>
						<button
							type="button"
							className={`${styles.candidateBtn} ${i === selectedIndex ? styles.candidateBtnActive : ""}`}
							onClick={() => onSelect(i)}
							title={`${c.placetype} • WOF ${c.id} • score ${c.score.toFixed(3)}`}
						>
							<span className={styles.candidateRank}>#{i + 1}</span>
							<span className={styles.candidateName}>{c.name}</span>
							<span className={styles.candidateMeta}>
								{c.placetype} · {c.score.toFixed(2)}
							</span>
						</button>
					</li>
				))}
			</ol>
		</div>
	)
}

/**
 * Render confidence as a horizontal bar (0–1 → 0–100% width) + numeric value. Color shifts from
 * red→amber→green at .5 / .8 thresholds so eyeballing the table surfaces low-confidence predictions
 * without reading every number.
 */
function ConfidenceCell({ confidence }: { confidence: number | undefined }): React.ReactElement {
	if (confidence == null) return <span className={styles.confDash}>—</span>
	const pct = Math.max(0, Math.min(1, confidence)) * 100
	const tier = confidence >= 0.8 ? "high" : confidence >= 0.5 ? "mid" : "low"
	return (
		<div className={styles.confCell}>
			<div className={`${styles.confBar} ${styles[`conf_${tier}`]}`} style={{ width: `${pct}%` }} />
			<span className={styles.confValue}>{confidence.toFixed(2)}</span>
		</div>
	)
}

/**
 * Copy a `https://mailwoman.sister.software/demo/?q=<encoded>` link to clipboard. Falls back to a
 * transient textarea hack on older browsers (Safari < 13.4 still misbehaves with the async
 * Clipboard API in non-secure contexts). Visible feedback is a 1.5s checkmark swap so the operator
 * knows the click landed.
 */
function PermalinkButton({ text }: { text: string }): React.ReactElement {
	const [copied, setCopied] = useState(false)
	const onClick = useCallback(async () => {
		if (typeof window === "undefined") return
		const url = new URL(window.location.href)
		if (text) url.searchParams.set("q", text)
		else url.searchParams.delete("q")
		const href = url.toString()
		try {
			await navigator.clipboard.writeText(href)
		} catch {
			const ta = document.createElement("textarea")
			ta.value = href
			ta.style.position = "fixed"
			ta.style.opacity = "0"
			document.body.appendChild(ta)
			ta.select()
			try {
				document.execCommand("copy")
			} catch {
				/* nothing more we can do; user can copy from address bar */
			}
			document.body.removeChild(ta)
		}
		setCopied(true)
		window.setTimeout(() => setCopied(false), 1500)
	}, [text])
	return (
		<button
			type="button"
			className={styles.permalinkBtn}
			onClick={onClick}
			title="Copy a shareable link to this address"
		>
			{copied ? "✓ Link copied" : "Copy link"}
		</button>
	)
}

/**
 * Surfacing why the WOF cascade returned no hit — saves the operator from guessing whether the
 * problem is the parser (didn't extract a locality / postcode), the WOF slim subset (entry not
 * indexed), or a known data quirk (postcode in WOF's 22%-placeholder bucket). The hints are
 * inferred from the parser output alone — no extra resolver round-trips.
 */
function FailureDiagnostic({
	nodes,
}: {
	nodes: Array<{ tag: string; value?: unknown; confidence?: number }>
}): React.ReactElement {
	const hasLocality = nodes.some((n) => n.tag === "locality" || n.tag === "city")
	const hasPostcode = nodes.some((n) => n.tag === "postcode" || n.tag === "postal_code")
	const hasRegion = nodes.some((n) => n.tag === "region" || n.tag === "state")

	const hints: string[] = []
	if (!hasLocality && !hasPostcode) {
		hints.push(
			"Parser didn't find a city or ZIP code in this input. Try adding one — e.g. append ', Chicago, IL 60613'."
		)
	}
	if (hasPostcode && !hasLocality) {
		hints.push(
			"Only a ZIP was extracted. WOF ships placeholder lat/lon (0, 0) for ~22% of US postcodes — known issue, the cascade drops those silently."
		)
	}
	if (hasLocality && !hasRegion) {
		hints.push(
			"No state in the parse. Many US localities share names across states (Springfield, Portland, …) — add a state to disambiguate."
		)
	}
	if (hints.length === 0) {
		hints.push(
			"The parsed components look reasonable, but the WOF slim subset (~35 MB, top-1k US localities + all postcodes) doesn't index this entry. The full WOF gazetteer (~1.5 GB) would likely resolve it."
		)
	}
	return (
		<div className={styles.failureDiagnostic}>
			<h2>No WOF hit</h2>
			<ul>
				{hints.map((h, i) => (
					<li key={i}>{h}</li>
				))}
			</ul>
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

/**
 * Compact display of the Stage 2.5 kind classifier's verdict. Shows the top kind + confidence as a
 * pill; expands to show alternatives on hover/click. Helps users see the staged pipeline working —
 * bare postcodes appear as `postcode_only`, single-word inputs as `locality_only`, multi-segment
 * inputs as `structured_address`, etc.
 */
function KindBadge({
	kindResult,
}: {
	kindResult: { kind: string; confidence: number; alternatives: ReadonlyArray<{ kind: string; confidence: number }> }
}): React.ReactElement {
	const pct = (n: number) => `${Math.round(n * 100)}%`
	return (
		<details className={styles.kindBadge ?? ""} style={{ marginBottom: "0.5rem", fontSize: "0.9rem" }}>
			<summary style={{ cursor: "pointer", userSelect: "none" }}>
				<strong>Kind:</strong> <code>{kindResult.kind}</code>{" "}
				<span style={{ opacity: 0.7 }}>({pct(kindResult.confidence)})</span>
			</summary>
			{kindResult.alternatives.length > 0 ? (
				<ul style={{ margin: "0.25rem 0 0 1rem", padding: 0, listStyle: "disc" }}>
					{kindResult.alternatives.map((alt, i) => (
						<li key={i}>
							<code>{alt.kind}</code> <span style={{ opacity: 0.7 }}>({pct(alt.confidence)})</span>
						</li>
					))}
				</ul>
			) : null}
		</details>
	)
}

interface DemoResult {
	tree: unknown
	nodes: Array<{ tag: string; value?: unknown; confidence?: number }>
	/**
	 * Top candidate (alias of `candidates[0]` when non-empty). Kept for callers that don't care about
	 * the picker UI.
	 */
	resolved: ResolvedHit | null
	/**
	 * Full candidate list returned by the cascade. Length 0 when nothing matched. Picker UI appears
	 * when length > 1.
	 */
	candidates: ResolvedHit[]
	stateHint?: string
	/**
	 * Stage 2.5 result: the kind classifier's verdict on the input. Surfaced in the UI so users can
	 * see the staged pipeline in action — bare postcodes show up as `postcode_only`, single-word
	 * locality inputs as `locality_only`, etc.
	 */
	kindResult?: {
		kind: string
		confidence: number
		alternatives: ReadonlyArray<{ kind: string; confidence: number }>
	}
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

/**
 * MapLibre custom control: per-group checkboxes that toggle layer visibility. Useful while
 * debugging cartography iterations — the protomaps basemap stacks ~70 layers, many of which (POI
 * labels, hillshade, building outlines) get in the way of seeing what's underneath.
 *
 * Groups are derived heuristically from the layer-ID prefix the protomaps theme uses (`roads_*`,
 * `places_*`, `landuse_*`, `buildings_*`, `boundaries`, …) so the control adapts to whatever layers
 * the current style happens to carry. Layers not matched by any prefix pattern fall into a
 * catch-all "other" group rather than getting silently dropped.
 *
 * Future-proofing for the dashboard: if/when TIGER tracts/blocks land in the demo's style, their
 * `tiger-tracts/*` and `tiger-blocks/*` IDs get their own groups automatically.
 */
// Order matters: first match wins. Labels go first so road-label / earth-label / address-label
// don't get pulled into the Roads / Landuse buckets.
const LAYER_GROUP_PATTERNS: ReadonlyArray<{ name: string; match: RegExp }> = [
	{ name: "Labels", match: /(?:_label|^places_|^address_label|^country)/ },
	{ name: "Background", match: /^background/ },
	{ name: "Roads", match: /^(?:roads_|bridges_|tunnel_)/ },
	{ name: "Buildings", match: /^(?:buildings|basemap-buildings)/ },
	{ name: "Boundaries", match: /^boundaries/ },
	{ name: "Water", match: /^(?:water|.*water-outline)/ },
	{ name: "Landuse / parks", match: /^(?:landuse_|landcover_|earth|park)/ },
	{ name: "POI symbols", match: /^pois?_/ },
	{ name: "Hillshade", match: /^hillshade(?:\/|$|-)/ },
	{ name: "TIGER (tracts)", match: /^tiger-tracts/ },
	{ name: "TIGER (blocks)", match: /^tiger-blocks/ },
]

class LayerToggleControl implements IControl {
	private map: MapLibreMap | null = null
	private container: HTMLDivElement | null = null
	private styleListener: (() => void) | null = null

	onAdd(map: MapLibreMap): HTMLElement {
		this.map = map
		this.container = document.createElement("div")
		this.container.className = `maplibregl-ctrl maplibregl-ctrl-group ${styles.layerToggleCtrl}`
		// Render a placeholder so the panel is visible immediately; replace once layers land.
		this.renderPlaceholder()
		// Re-render whenever the style swaps (theme toggle, etc.) AND when sources finish
		// loading — styledata can fire before any layers are populated. Guard against the
		// empty-layers race by skipping renders that would produce 0 buckets.
		this.styleListener = () => {
			if (!this.map?.isStyleLoaded()) return
			const layers = this.map.getStyle()?.layers ?? []
			if (layers.length === 0) return
			this.render()
		}
		map.on("styledata", this.styleListener)
		map.on("idle", this.styleListener)
		return this.container
	}

	private renderPlaceholder(): void {
		if (!this.container) return
		this.container.replaceChildren()
		const heading = document.createElement("div")
		heading.className = styles.layerToggleHeading
		heading.textContent = "Layers"
		this.container.appendChild(heading)
		const spinner = document.createElement("div")
		spinner.className = styles.layerToggleLabel
		spinner.textContent = "loading…"
		this.container.appendChild(spinner)
	}

	onRemove(): void {
		if (this.map && this.styleListener) {
			this.map.off("styledata", this.styleListener)
			this.map.off("idle", this.styleListener)
		}
		this.container?.remove()
		this.container = null
		this.map = null
	}

	private render(): void {
		if (!this.map || !this.container) return
		const style = this.map.getStyle()
		if (!style?.layers) return

		// Bucket every layer into a group (catch-all → "Other"). Skip mailwoman-bbox + marker
		// layers — they're transient resolver output, not part of the basemap.
		type Bucket = { name: string; layerIds: string[]; visible: boolean }
		const buckets = new Map<string, Bucket>()
		for (const layer of style.layers) {
			const id = layer.id
			if (id.startsWith("mailwoman-")) continue
			const group = LAYER_GROUP_PATTERNS.find((g) => g.match.test(id))?.name ?? "Other"
			if (!buckets.has(group)) buckets.set(group, { name: group, layerIds: [], visible: true })
			const bucket = buckets.get(group)!
			bucket.layerIds.push(id)
			// Group is "visible" if at least one of its layers is visible (default vs explicit none).
			const vis = layer.layout && "visibility" in layer.layout ? layer.layout["visibility"] : "visible"
			if (vis === "none") {
				// keep bucket.visible if any other layer in the group is visible; flip later
			} else {
				bucket.visible = true
			}
		}
		// Re-compute bucket.visible — a group is visible iff ANY of its layers is currently
		// visible. (Above loop's logic was lossy on the no-layout-visibility case; redo cleanly.)
		for (const bucket of buckets.values()) {
			bucket.visible = bucket.layerIds.some((id) => {
				const lyr = style.layers.find((l) => l.id === id)
				const v = lyr?.layout && "visibility" in lyr.layout ? lyr.layout["visibility"] : "visible"
				return v !== "none"
			})
		}

		this.container.replaceChildren()
		const heading = document.createElement("div")
		heading.className = styles.layerToggleHeading
		heading.textContent = "Layers"
		this.container.appendChild(heading)

		// Stable display order: pattern order first, then "Other".
		const orderedNames = [...LAYER_GROUP_PATTERNS.map((g) => g.name), "Other"]
		for (const name of orderedNames) {
			const bucket = buckets.get(name)
			if (!bucket) continue
			const row = document.createElement("label")
			row.className = styles.layerToggleRow
			const cb = document.createElement("input")
			cb.type = "checkbox"
			cb.checked = bucket.visible
			cb.addEventListener("change", () => {
				const visibility = cb.checked ? "visible" : "none"
				for (const layerId of bucket.layerIds) {
					try {
						this.map?.setLayoutProperty(layerId, "visibility", visibility)
					} catch {
						// layer disappeared between render and toggle; ignore
					}
				}
			})
			row.appendChild(cb)
			const label = document.createElement("span")
			label.className = styles.layerToggleLabel
			label.textContent = `${name} (${bucket.layerIds.length})`
			row.appendChild(label)
			this.container.appendChild(row)
		}
	}
}
