/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<DemoControls>` — the geocoder demo's floating control panel, assembled from the demo-specific units
 *   (VersionPicker / CompareToggle / BackendControl / PlaceAutocomplete / ResultPanel) and the REUSED
 *   pipeline units (QueryForm / PresetChips / LoadingIndicator). It is the presentational composition the
 *   `_app.tsx` control `<section>` (`:1222-1514`) becomes — it reads the injected {@link DemoRuntime} for
 *   ready/version/backend/loading state and threads the {@link useDemoGeocode} + {@link usePlaceAutocomplete}
 *   + {@link useCompareState} hooks into the controls. Host-specific visualizers arrive via {@link DemoPanels}.
 *
 *   NODE-SAFE: pure React + the shared/demo units, no maplibre. It rides `@mailwoman/react/map` as a
 *   demo-specific control, not for WebGL.
 */

import type { ReactNode } from "react"

import { LoadingIndicator } from "../common/LoadingIndicator.tsx"
import { PresetChips, type Preset } from "../common/PresetChips.tsx"
import { QueryForm } from "../pipeline/QueryForm.tsx"
import { BackendControl } from "./BackendControl.tsx"
import { CompareToggle } from "./CompareToggle.tsx"
import { PlaceAutocomplete } from "./PlaceAutocomplete.tsx"
import { ResultPanel } from "./ResultPanel.tsx"
import type { DemoPanels, DemoRuntime } from "./types.ts"
import type { UseCompareState } from "./useCompareState.ts"
import type { UseDemoGeocode } from "./useDemoGeocode.ts"
import type { UsePlaceAutocomplete } from "./usePlaceAutocomplete.ts"
import { VersionPicker } from "./VersionPicker.tsx"

export interface DemoControlsProps {
	/** The injected demo runtime. */
	runtime: DemoRuntime
	/** The parse+resolve state machine. */
	geocode: UseDemoGeocode
	/** The place-autocomplete combobox state. */
	autocomplete: UsePlaceAutocomplete
	/** The compare-mode state. */
	compare: UseCompareState
	/** Host-injected panels (about, release blurb, compare, permalink, extras, failure). */
	panels: DemoPanels
	/** Example chips. */
	presets: ReadonlyArray<Preset>
	/** Input placeholder. */
	placeholder: string
	/** Select a model version (the composed demo also clears a now-colliding compare selection). */
	onSelectVersion: (version: string) => void
	/** Toggle the forced WASM backend. */
	onForceWASMChange: (forceWASM: boolean) => void
}

/** The floating control panel. */
export function DemoControls({
	runtime,
	geocode,
	autocomplete,
	compare,
	panels,
	presets,
	placeholder,
	onSelectVersion,
	onForceWASMChange,
}: DemoControlsProps): ReactNode {
	const versions = runtime.availableVersions ?? []
	const { busy, result, selectedCandidate } = geocode
	const loading = runtime.loading
	const errorMessage = geocode.parseError ?? runtime.errorMessage ?? null

	return (
		<section className="mw-demo-controls">
			{panels.header}
			{panels.releaseInfo}

			<VersionPicker
				versions={versions}
				selected={runtime.selectedVersion ?? null}
				onSelect={onSelectVersion}
				disabled={busy}
			/>

			<BackendControl
				activeBackend={runtime.activeBackend}
				forceWASM={runtime.forceWASM ?? false}
				onForceWASMChange={onForceWASMChange}
			/>

			<CompareToggle
				versions={versions}
				primaryVersion={runtime.selectedVersion ?? null}
				compareMode={compare.compareMode}
				onCompareModeChange={compare.setCompareMode}
				compareVersion={compare.compareVersion}
				onCompareVersionChange={compare.setCompareVersion}
				disabled={busy}
			/>

			<QueryForm
				value={geocode.text}
				onChange={geocode.setText}
				onSubmit={geocode.submit}
				disabled={!runtime.ready}
				busy={busy}
				placeholder={placeholder}
				onKeyDown={autocomplete.onInputKeyDown}
				inputProps={autocomplete.inputProps}
			/>

			{panels.bias}

			<PlaceAutocomplete
				suggestions={autocomplete.suggestions}
				activeIndex={autocomplete.activeIndex}
				onPick={autocomplete.pick}
				onHover={autocomplete.setActiveIndex}
				listboxId={autocomplete.listboxId}
				optionId={autocomplete.optionId}
			/>

			<PresetChips
				presets={presets}
				disabled={!runtime.ready || busy}
				onPick={(value) => {
					geocode.setText(value)
					geocode.reset()
				}}
				trailing={panels.permalink ? panels.permalink(geocode.text) : null}
			/>

			{loading && !runtime.ready ? (
				<LoadingIndicator
					mode="staged"
					steps={loading.stepLabels.length > 0 ? loading.stepLabels : undefined}
					activeStep={loading.stepIndex}
					label={loading.progress}
				/>
			) : null}
			{errorMessage ? <p className="mw-error">{errorMessage}</p> : null}

			{panels.aboveResult ? panels.aboveResult({ result }) : null}

			{busy ? (
				<div className="mw-result">
					<LoadingIndicator mode="staged" steps={runtime.parseStageLabels} activeStep={geocode.parseStage} />
				</div>
			) : result ? (
				panels.result ? (
					panels.result({
						result,
						selectedCandidate,
						selectedCandidateIndex: geocode.selectedCandidateIndex,
						onSelectCandidate: geocode.selectCandidate,
					})
				) : (
					<ResultPanel
						result={result}
						selectedCandidate={selectedCandidate}
						selectedCandidateIndex={geocode.selectedCandidateIndex}
						onSelectCandidate={geocode.selectCandidate}
						extras={panels.extras}
						failure={panels.failure}
					/>
				)
			) : null}

			{panels.compare
				? panels.compare({ result, compareMode: compare.compareMode, compareVersion: compare.compareVersion })
				: null}

			{panels.footer}
		</section>
	)
}
