/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The host-only chrome around the geocoder, composed for `@mailwoman/react/map`'s `panels` injection point: the
 *   about box, the release line, the geo-bias row, the permalink, the calibration and dev-mode toggles, the result
 *   panel with its visualizers, the decode-path drawer, the map controls and the version compare. Everything here is
 *   presentation over the runtime handle; nothing here loads or resolves.
 */

import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
import { About } from "@mailwoman/react/common/About"
import type { GeocoderPanels } from "@mailwoman/react/map"
import { MapFooter } from "@mailwoman/react/map/MapFooter"
import { ResultPanel } from "@mailwoman/react/map/ResultPanel"
import { FailureDiagnostic } from "@mailwoman/react/pipeline/FailureDiagnostic"
import type { ReleaseInfo } from "mailwoman/browser-runtime/manifest"
import { useMemo, useState } from "react"

import type { GeocoderRuntimeHandle } from "#runtime/use-geocoder-runtime"

import { Compare } from "./Compare.tsx"
import { CalibrationToggle, DevModeToggle, GeoBiasRow } from "./Controls.tsx"
import { DebugDrawer } from "./DebugDrawer.tsx"
import { LayerToggleControl } from "./LayerToggleControl/LayerToggleControl.tsx"
import { MapControls } from "./MapControls.tsx"
import { PermalinkButton } from "./PermalinkButton/PermalinkButton.tsx"
import { ResultExtras } from "./ResultExtras.tsx"

export interface GeocoderPanelsOptions {
	/**
	 * The runtime handle the panels read: releases, the calibrator, the trace hook.
	 */
	handle: GeocoderRuntimeHandle
	/**
	 * Open the decode-path drawer on mount, which is what the `/debug` route does.
	 */
	debugDefault: boolean
}

/**
 * What the loader is fetching, as one line for the footer: the named step, then the loader's own progress text.
 *
 * Each part is tested for on its own rather than filtered out of a list — an absent step and an absent progress line
 * are different readings, and a filter would report the same string for both.
 */
function describeLoad(loading: NonNullable<GeocoderRuntimeHandle["runtime"]["loading"]>): string {
	const step = loading.stepLabels[loading.stepIndex]

	if (step && loading.progress) return `${step} · ${loading.progress}`

	if (step) return step

	if (loading.progress) return loading.progress

	return "Loading…"
}

export function useGeocoderPanels({ handle, debugDefault }: GeocoderPanelsOptions): GeocoderPanels {
	const { runtime, releases, forceWASM, geoBias, calibrator, traceParse, supportsTrace } = handle

	// Opt-in display state: the calibrated-confidence view and the dev-mode decode-path drawer.
	const [calibrateConfidence, setCalibrateConfidence] = useState(false)
	const [devMode, setDevMode] = useState(debugDefault)

	const selectedVersion = runtime.selectedVersion ?? null
	const selectedRelease: ReleaseInfo | undefined = releases.find((r) => r.version === selectedVersion)

	// The named step first, then the loader's own line — "Gazetteer · 12.4 MB". Null once the runtime is ready, which
	// is what removes the status from the footer rather than leaving a stale label there.
	const loading = runtime.loading
	const loadStatus = runtime.ready || !loading ? null : describeLoad(loading)

	/* oxlint-disable react/no-unstable-nested-components -- render props, not components: the controls call each member (`panels.result({…})`) rather than mounting it */
	return useMemo<GeocoderPanels>(
		() => ({
			// The sheet's own title and its capsule button are the disclosure; a second one inside would repeat them.
			header: <About collapsible={false} />,
			releaseInfo: selectedRelease ? (
				<p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", opacity: 0.75 }}>
					<strong>{selectedRelease.version}</strong> — {selectedRelease.description} ({selectedRelease.modelSize},{" "}
					{selectedRelease.tokenizerVocab.toLocaleString()} vocab, {selectedRelease.steps.toLocaleString()} steps)
				</p>
			) : undefined,
			bias: <GeoBiasRow active={geoBias.active} onToggle={geoBias.toggle} />,
			permalink: (text) => <PermalinkButton text={text} />,
			// The two display toggles read on the MODEL, not on an address, so they live behind the Developer capsule
			// rather than above every result — at the top of the result sheet they were the first thing a visitor met,
			// and on a phone they pushed the answer below the fold.
			developerExtras: (
				<>
					{calibrator ? <CalibrationToggle checked={calibrateConfidence} onChange={setCalibrateConfidence} /> : null}
					{supportsTrace ? <DevModeToggle checked={devMode} onChange={setDevMode} /> : null}
				</>
			),
			result: ({ result, selectedCandidateIndex, onSelectCandidate }) => {
				// Display-only calibrated view: map each span's raw confidence through the calibrator when the toggle is on.
				// A fresh copy, never a mutation of the runtime's result (the resolver and the compare read the raw nodes).
				const displayResult: ParseResult =
					calibrateConfidence && calibrator
						? {
								...result,
								nodes: result.nodes.map((n) => ({
									...n,
									confidence: n.confidence != null ? (calibrator(n.confidence) ?? n.confidence) : n.confidence,
								})),
							}
						: result

				const selectedCandidate =
					displayResult.candidates[selectedCandidateIndex] ?? displayResult.candidates[0] ?? null

				return (
					<ResultPanel
						result={displayResult}
						selectedCandidate={selectedCandidate}
						selectedCandidateIndex={selectedCandidateIndex}
						onSelectCandidate={onSelectCandidate}
						extras={(r) => <ResultExtras result={r} />}
						failure={(r) => <FailureDiagnostic nodes={r.nodes} />}
					/>
				)
			},
			debugDrawer: ({ result }) => (
				<DebugDrawer result={result} devMode={devMode} traceParse={traceParse} onClose={() => setDevMode(false)} />
			),
			mapControls: <MapControls />,
			layers: ({ map }) => <LayerToggleControl map={map} />,
			footer: (
				<MapFooter
					identity={<strong>Mailwoman Earth</strong>}
					// What is loading, beside the identity. The bar across the top of the viewport says how far along it
					// is; this says which artifact it is fetching, which is the part a number cannot carry.
					status={loadStatus}
					attribution={["© OpenStreetMap", "Protomaps", "MapLibre"]}
				/>
			),
			compare: (ctx) => (
				<Compare
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
			loadStatus,
		]
	)
	/* oxlint-enable react/no-unstable-nested-components */
}
