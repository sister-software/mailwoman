/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `/demo-next` — the PARALLEL STAGING route for the geocoder-demo port. It renders the package's
 *   `@mailwoman/react/map` `<GeocoderDemo>` driven by the REAL runtime (`useDemoNextRuntime`), over the same R2
 *   assets the live `/demo` page uses — so the two can be screenshot-compared before the default `/demo` route
 *   is ever flipped. Phase 5b closes the parity gaps: the dark cartographer basemap, the coverage/layers panel,
 *   the geo-bias row, the calibration + dev-mode toggles + model-visualizer drawer, and the docs result panel
 *   (span highlight / timing / hierarchy / precision) — all injected through the package's `DemoPanels` seam,
 *   reusing the exact docs components the live demo renders.
 *
 *   This route is deliberately UNLISTED: it is not in the navbar and is excluded from the sitemap
 *   (`docusaurus.config.ts` sitemap `ignorePatterns`) + carries a `noindex` robots hint. The live `/demo` page
 *   (`../demo/index.tsx`, `../demo/_app.tsx`) is NOT touched by this file.
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
import { useBrowserGeolocation } from "../demo/_hooks.tsx"
import { TILE_WORKER_URL } from "../demo/_map-helpers.ts"
import { DemoNextCompare } from "./_compare.tsx"
import { CalibrationToggle, DevModeToggle, GeoBiasRow } from "./_controls.tsx"
import { DemoNextDebugDrawer } from "./_devDrawer.tsx"
import { DemoNextMapControls } from "./_mapControls.tsx"
import { useDemoNextRuntime } from "./_runtime.ts"

import demoStyles from "../demo/styles.module.css"
import styles from "./styles.module.css"

const PRESETS = EXAMPLE_ADDRESSES.map((ex) => ({ label: ex.label, value: ex.address }))

const LoadingFallback: React.FC = () => <p style={{ padding: "1rem" }}>Loading…</p>

function initialAddress(): string {
	if (typeof window === "undefined") return DEFAULT_ADDRESS

	return new URL(window.location.href).searchParams.get("q") ?? DEFAULT_ADDRESS
}

/** The client-only demo body: build the real runtime, then render `<GeocoderDemo>` with docs panels. */
const DemoNextInner: React.FC<{ initialCenter: Coordinates2D }> = ({ initialCenter }) => {
	const { baseURL } = useSiteConfig()
	const sqljsBaseURL = `${baseURL}mailwoman/sqljs`
	const { runtime, releases, forceWASM, geoBias, calibrator, traceParse, supportsTrace } = useDemoNextRuntime({
		sqljsBaseURL,
		baseURL,
		initialCenter,
	})

	// Opt-in display state (host-owned, exactly as `_app.tsx` owns it): the calibrated-confidence view + the
	// dev-mode decode-path drawer. Default off so the demo's default presentation is unchanged.
	const [calibrateConfidence, setCalibrateConfidence] = useState(false)
	const [devMode, setDevMode] = useState(false)

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
				<DemoNextDebugDrawer
					result={result}
					devMode={devMode}
					traceParse={traceParse}
					onClose={() => setDevMode(false)}
				/>
			),
			mapControls: <DemoNextMapControls />,
			compare: (ctx) => (
				<DemoNextCompare
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

const DemoNextPage: React.FC = () => {
	const { baseURL } = useSiteConfig()
	const initialCenter = useBrowserGeolocation()

	return (
		<Layout
			title="Demo (next)"
			description="Staging build of the mailwoman geocoder demo on @mailwoman/react."
			noFooter
		>
			<Head>
				{/* Unlisted staging route — keep it out of search indexes (also excluded from the sitemap). */}
				<meta name="robots" content="noindex" />
				<link rel="preconnect" href="https://public.sister.software" crossOrigin="anonymous" />
				<link rel="dns-prefetch" href="https://public.sister.software" />
				<link rel="preconnect" href={TILE_WORKER_URL} crossOrigin="anonymous" />
				<link rel="prefetch" href={`${baseURL}mailwoman/sqljs/index.js`} />
				<link rel="prefetch" href={`${baseURL}mailwoman/sqljs/sqlite.worker.js`} />
				<link rel="prefetch" href={`${baseURL}mailwoman/sqljs/sql-wasm.wasm`} />
			</Head>

			<main className={`${demoStyles.demoRoot} ${styles.demoNextRoot}`}>
				<BrowserOnly fallback={<LoadingFallback />}>
					{() => {
						if (!initialCenter) return <LoadingFallback />

						return <DemoNextInner initialCenter={initialCenter} />
					}}
				</BrowserOnly>
			</main>
		</Layout>
	)
}

export default DemoNextPage
