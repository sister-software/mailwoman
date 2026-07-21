/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `/demo` — the mailwoman geocoder demo, fully client-side. It renders the published
 *   `@mailwoman/react/map` `<GeocoderDemo>` driven by the REAL docs runtime ({@link useDemoMapRuntime}):
 *
 *   - `@mailwoman/neural-web` (onnxruntime-web, WASM SIMD with WebGPU fallback) for the BIO classifier,
 *   - sql.js-httpvfs (`../../shared/httpvfs-resolver`) range-loading the same-origin WOF + polygon DBs,
 *   - `@mailwoman/cartographer` `StyleSpecificationComposer` over the v4 protomaps basemap.
 *
 *   The docs-only chrome (about box, permalink, result panel, geo-bias row, calibration + dev-mode
 *   toggles, model-visualizer drawer, version-compare) is injected through the package's `DemoPanels`
 *   seam — see the `_controls` / `_devDrawer` / `_mapControls` / `_compare` modules in this folder.
 *
 *   `/debug` (`../debug.tsx`) reuses this body via {@link DemoPageInner} with `debugDefault`, which opens
 *   the model-visualizer drawer by default.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import "@mailwoman/react/styles.css"
import BrowserOnly from "@docusaurus/BrowserOnly"
import Head from "@docusaurus/Head"
import { GeocoderDemo } from "@mailwoman/react/map"
import type { DemoPanels } from "@mailwoman/react/map"
import type { Coordinates2D } from "@mailwoman/spatial"
import Layout from "@theme/Layout"
import type React from "react"
import { useMemo, useState } from "react"

import { AboutDemo } from "../../components/AboutDemo/AboutDemo.tsx"
import { PermalinkButton } from "../../components/PermalinkButton/PermalinkButton.tsx"
import { ResultPanel as DocsResultPanel } from "../../components/ResultPanel/ResultPanel.tsx"
import { useSiteConfig } from "../../hooks/site.ts"
import { DEFAULT_ADDRESS, EXAMPLE_ADDRESSES } from "../../shared/demo-helpers.ts"
import type { DemoResult } from "../../shared/resources.tsx"
import { DemoCompare } from "./_compare.tsx"
import { CalibrationToggle, DevModeToggle, GeoBiasRow } from "./_controls.tsx"
import { DemoDebugDrawer } from "./_devDrawer.tsx"
import { useBrowserGeolocation } from "./_hooks.tsx"
import { TILE_WORKER_URL } from "./_map-helpers.ts"
import { DemoMapControls } from "./_mapControls.tsx"
import { useDemoMapRuntime } from "./_runtime.ts"

import geocoderStyles from "./geocoder.module.css"
import demoStyles from "./styles.module.css"

const PRESETS = EXAMPLE_ADDRESSES.map((ex) => ({ label: ex.label, value: ex.address }))

const LoadingFallback: React.FC = () => <p style={{ padding: "1rem" }}>Loading…</p>

function initialAddress(): string {
	if (typeof window === "undefined") return DEFAULT_ADDRESS

	return new URL(window.location.href).searchParams.get("q") ?? DEFAULT_ADDRESS
}

/** The client-only demo body: build the real runtime, then render `<GeocoderDemo>` with docs panels. */
const DemoInner: React.FC<{ initialCenter: Coordinates2D; debugDefault?: boolean }> = ({
	initialCenter,
	debugDefault = false,
}) => {
	const { baseURL } = useSiteConfig()
	const sqljsBaseURL = `${baseURL}mailwoman/sqljs`
	const { runtime, releases, forceWASM, geoBias, calibrator, traceParse, supportsTrace } = useDemoMapRuntime({
		sqljsBaseURL,
		baseURL,
		initialCenter,
	})

	// Opt-in display state (host-owned): the calibrated-confidence view + the dev-mode decode-path drawer.
	// `/debug` opens the drawer by default (`debugDefault`); `/demo` starts with both off.
	const [calibrateConfidence, setCalibrateConfidence] = useState(false)
	const [devMode, setDevMode] = useState(debugDefault)

	const selectedVersion = runtime?.selectedVersion ?? null
	const selectedRelease = releases.find((r) => r.version === selectedVersion)

	const panels = useMemo<DemoPanels>(
		() => ({
			header: <AboutDemo />,
			releaseInfo: selectedRelease ? (
				<p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", opacity: 0.75 }}>
					<strong>{selectedRelease.version}</strong> — {selectedRelease.description} ({selectedRelease.modelSize},{" "}
					{selectedRelease.tokenizerVocab.toLocaleString()} vocab, {selectedRelease.steps.toLocaleString()} steps)
				</p>
			) : undefined,
			bias: <GeoBiasRow active={geoBias.active} onToggle={geoBias.toggle} />,
			permalink: (text) => <PermalinkButton text={text} />,
			aboveResult: ({ result }) => (
				<>
					{result && calibrator ? (
						<CalibrationToggle checked={calibrateConfidence} onChange={setCalibrateConfidence} />
					) : null}
					{supportsTrace ? <DevModeToggle checked={devMode} onChange={setDevMode} /> : null}
				</>
			),
			result: ({ result, selectedCandidateIndex, onSelectCandidate }) => {
				// Display-only calibrated view: map each span's raw confidence through the calibrator when the toggle is on.
				// A fresh copy — never mutates the runtime's result (the resolver + compare read the raw nodes).
				const displayResult =
					calibrateConfidence && calibrator
						? {
								...result,
								nodes: result.nodes.map((n) => ({
									...n,
									confidence: n.confidence != null ? (calibrator(n.confidence) ?? n.confidence) : n.confidence,
								})),
							}
						: result

				return (
					<DocsResultPanel
						result={displayResult as unknown as DemoResult}
						selectedCandidateIndex={selectedCandidateIndex}
						onSelectCandidate={onSelectCandidate}
					/>
				)
			},
			debugDrawer: ({ result }) => (
				<DemoDebugDrawer result={result} devMode={devMode} traceParse={traceParse} onClose={() => setDevMode(false)} />
			),
			mapControls: <DemoMapControls />,
			compare: (ctx) => (
				<DemoCompare
					primary={ctx.result}
					compareMode={ctx.compareMode}
					compareVersion={ctx.compareVersion}
					primaryVersion={selectedVersion ?? "?"}
					releases={releases}
					forceWASM={forceWASM}
				/>
			),
		}),
		[
			selectedRelease,
			selectedVersion,
			releases,
			forceWASM,
			geoBias,
			calibrator,
			calibrateConfidence,
			devMode,
			supportsTrace,
			traceParse,
		]
	)

	if (!runtime) return <LoadingFallback />

	return <GeocoderDemo runtime={runtime} panels={panels} defaultAddress={initialAddress()} presets={PRESETS} />
}

/**
 * The demo page body — shared by `/demo` and `/debug` (the latter opens with the model-visualizer drawer on by
 * default). Exported so the thin `debug.tsx` route can mount it with `debugDefault`.
 */
export const DemoPageInner: React.FC<{ debugDefault?: boolean }> = ({ debugDefault = false }) => {
	const { baseURL } = useSiteConfig()
	const initialCenter = useBrowserGeolocation()

	return (
		<Layout
			title={debugDefault ? "Debug" : "Demo"}
			description="Client-side address geocoder demo for mailwoman."
			noFooter
		>
			{/* Resource hints: the DBs/model range-load from R2 and the basemap tiles from tiles.* the moment the
			    app boots — preconnecting here overlaps DNS+TLS with hydration. The sqljs worker assets are
			    same-origin and fetched on (or before) first lookup; prefetch warms the HTTP cache at low priority. */}
			<Head>
				<link rel="preconnect" href="https://public.sister.software" crossOrigin="anonymous" />
				<link rel="dns-prefetch" href="https://public.sister.software" />
				<link rel="preconnect" href={TILE_WORKER_URL} crossOrigin="anonymous" />
				<link rel="prefetch" href={`${baseURL}mailwoman/sqljs/index.js`} />
				<link rel="prefetch" href={`${baseURL}mailwoman/sqljs/sqlite.worker.js`} />
				<link rel="prefetch" href={`${baseURL}mailwoman/sqljs/sql-wasm.wasm`} />
			</Head>

			<main className={`${demoStyles.demoRoot} ${geocoderStyles.geocoderRoot}`}>
				<BrowserOnly fallback={<LoadingFallback />}>
					{() => {
						if (!initialCenter) return <LoadingFallback />

						return <DemoInner initialCenter={initialCenter} debugDefault={debugDefault} />
					}}
				</BrowserOnly>
			</main>
		</Layout>
	)
}

const DemoPage: React.FC = () => <DemoPageInner />

export default DemoPage
