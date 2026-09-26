/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Everything here is presentation over the runtime handle; no code here loads or resolves.
 */

import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
import { About } from "@mailwoman/react/common/About"
import type { GeocoderPanels } from "@mailwoman/react/map"
import { ResultPanel } from "@mailwoman/react/map/ResultPanel"
import { FailureDiagnostic } from "@mailwoman/react/pipeline/FailureDiagnostic"
import type { ReleaseInfo } from "mailwoman/browser-runtime/manifest"
import { useMemo, useState } from "react"

import type { GeocoderRuntimeHandle } from "#runtime/use/geocoder-runtime"

import { Compare } from "./Compare.tsx"
import { CalibrationToggle, DevModeToggle, GeoBiasRow } from "./Controls.tsx"
import { DebugDrawer } from "./DebugDrawer.tsx"
import { EarthFooter } from "./EarthFooter.tsx"
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
 * An absent step and an absent progress line are different readings, so each part
 * is tested on its own rather than filtered out of a list.
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

	const [calibrateConfidence, setCalibrateConfidence] = useState(false)
	const [devMode, setDevMode] = useState(debugDefault)

	const selectedVersion = runtime.selectedVersion ?? null
	const selectedRelease: ReleaseInfo | undefined = releases.find((r) => r.version === selectedVersion)

	// Null once the runtime is ready, which removes the status from the footer rather than leaving a stale label.
	const loading = runtime.loading
	const loadStatus = runtime.ready || !loading ? null : describeLoad(loading)

	/* oxlint-disable react/no-unstable-nested-components -- render props rather than components: the controls call each member (`panels.result({…})`) rather than mounting it */
	return useMemo<GeocoderPanels>(
		() => ({
			// The sheet's own title and capsule button are the disclosure, so a second one inside would repeat them.
			header: <About collapsible={false} />,
			releaseInfo: selectedRelease ? (
				<p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", opacity: 0.75 }}>
					<strong>{selectedRelease.version}</strong> — {selectedRelease.description} ({selectedRelease.modelSize},{" "}
					{selectedRelease.tokenizerVocab.toLocaleString()} vocab, {selectedRelease.steps.toLocaleString()} steps)
				</p>
			) : undefined,
			bias: <GeoBiasRow active={geoBias.active} error={geoBias.error} onToggle={geoBias.toggle} />,
			permalink: (text) => <PermalinkButton text={text} />,
			// The two display toggles read on the model rather than an address, so they live
			// behind the Developer capsule rather than above every result.
			developerExtras: (
				<>
					{calibrator ? <CalibrationToggle checked={calibrateConfidence} onChange={setCalibrateConfidence} /> : null}
					{supportsTrace ? <DevModeToggle checked={devMode} onChange={setDevMode} /> : null}
				</>
			),
			result: ({ result, selectedCandidateIndex, onSelectCandidate }) => {
				// A fresh copy, never a mutation of the runtime's result, because the resolver
				// and the compare read the raw nodes.
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
			// The feature inspector is developer tooling, shown under the same condition as the decode-path drawer.
			mapControls: devMode ? <MapControls /> : null,
			layers: ({ map }) => <LayerToggleControl map={map} />,
			// The identity and credits live in `EarthFooter` so this footer and the canned
			// runtime's cannot differ; `status` is the one thing only this path has.
			footer: <EarthFooter status={loadStatus} />,
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
