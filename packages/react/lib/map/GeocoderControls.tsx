/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The geocoder's chrome over the map: a search pill on top, example chips on one line beneath it, a control column
 *   down the right edge, and a result sheet that rises from the bottom when there is something to show.
 *
 *   It replaces a 400px full-height panel that carried every control at once. The layout is the one the reference
 *   map apps use, and the reason is the map: chrome that floats over it leaves the map the page, where a slab makes
 *   the map the leftover third.
 *
 *   NODE-SAFE: pure React + the shared units, no maplibre.
 */

import { type ReactNode, useState } from "react"

import type { GeocoderPanels, GeocoderRuntime } from "#map/types"
import type { UseCompareState } from "#map/useCompareState"
import type { UseGeocode } from "#map/useGeocode"
import type { UsePlaceAutocomplete } from "#map/usePlaceAutocomplete"

import { LoadingIndicator } from "../common/LoadingIndicator.tsx"
import type { Preset } from "../common/PresetChips.tsx"
import { BackendControl } from "./BackendControl.tsx"
import { CompareToggle } from "./CompareToggle.tsx"
import { MapChipRow } from "./MapChipRow.tsx"
import { MapControlButton, MapControlGroup, MapControlStack } from "./MapControlStack.tsx"
import { MapSearchBar } from "./MapSearchBar.tsx"
import { PlaceAutocomplete } from "./PlaceAutocomplete.tsx"
import { ResultPanel } from "./ResultPanel.tsx"
import { VersionPicker } from "./VersionPicker.tsx"

export interface GeocoderControlsProps {
	/**
	 * The injected geocoder runtime.
	 */
	runtime: GeocoderRuntime
	/**
	 * The parse+resolve state machine.
	 */
	geocode: UseGeocode
	/**
	 * The place-autocomplete combobox state.
	 */
	autocomplete: UsePlaceAutocomplete
	/**
	 * The compare-mode state.
	 */
	compare: UseCompareState
	/**
	 * Host-injected panels (about, release blurb, compare, permalink, extras, failure).
	 */
	panels: GeocoderPanels
	/**
	 * Example chips.
	 */
	presets: ReadonlyArray<Preset>
	/**
	 * Input placeholder.
	 */
	placeholder: string
	/**
	 * Select a model version (the composed geocoder also clears a now-colliding compare selection).
	 */
	onSelectVersion: (version: string) => void
	/**
	 * Toggle the forced WASM backend.
	 */
	onForceWASMChange: (forceWASM: boolean) => void
	/**
	 * Open the developer panel on mount. The model version, the backend readout and compare live inside it: they read on
	 * the model rather than on an address, and above the query field they were the first thing every visitor met.
	 *
	 * @default false
	 */
	developer?: boolean
}

/**
 * The chrome. Everything positioned here floats over the map; nothing occupies a column of the page.
 */
export function GeocoderControls({
	runtime,
	geocode,
	autocomplete,
	compare,
	panels,
	presets,
	placeholder,
	onSelectVersion,
	onForceWASMChange,
	developer = false,
}: GeocoderControlsProps): ReactNode {
	const versions = runtime.availableVersions ?? []
	const { busy, result, selectedCandidate } = geocode
	const loading = runtime.loading
	const errorMessage = geocode.parseError ?? runtime.errorMessage ?? null

	const [developerOpen, setDeveloperOpen] = useState(developer)
	const [aboutOpen, setAboutOpen] = useState(false)

	const chips = presets.map((preset) => ({ label: preset.label, value: preset.value }))
	const showSheet = Boolean(busy || result || errorMessage || (loading && !runtime.ready))

	return (
		<>
			<div className="mw-map-chrome mw-map-chrome--top">
				<form
					className="mw-map-chrome__search"
					onSubmit={(event) => {
						event.preventDefault()
						geocode.submit()
					}}
				>
					<MapSearchBar
						label="Search addresses"
						leading={<span aria-hidden="true">⌕</span>}
						trailing={
							busy ? (
								<LoadingIndicator mode="spinner" size="small" />
							) : geocode.text ? (
								<button
									type="button"
									className="mw-map-searchbar__clear"
									aria-label="Clear the address"
									onClick={() => {
										geocode.setText("")
										geocode.reset()
									}}
								>
									×
								</button>
							) : null
						}
					>
						<input
							id="mw-pipeline-input"
							type="search"
							aria-label="Address"
							value={geocode.text}
							onChange={(event) => geocode.setText(event.target.value)}
							disabled={!runtime.ready}
							placeholder={placeholder}
							onKeyDown={autocomplete.onInputKeyDown}
							{...autocomplete.inputProps}
						/>
					</MapSearchBar>
				</form>

				<PlaceAutocomplete
					suggestions={autocomplete.suggestions}
					activeIndex={autocomplete.activeIndex}
					onPick={autocomplete.pick}
					onHover={autocomplete.setActiveIndex}
					listboxID={autocomplete.listboxID}
					optionID={autocomplete.optionID}
				/>

				<MapChipRow
					chips={chips}
					label="Example addresses"
					disabled={!runtime.ready || busy}
					onPick={(value) => {
						geocode.setText(value)
						geocode.reset()
						geocode.submit()
					}}
				/>

				{panels.bias}
			</div>

			<MapControlStack label="Map controls">
				<MapControlGroup>
					<MapControlButton label="About this geocoder" active={aboutOpen} onPress={() => setAboutOpen((v) => !v)}>
						<span aria-hidden="true">i</span>
					</MapControlButton>
					<MapControlButton
						label="Developer controls"
						active={developerOpen}
						onPress={() => setDeveloperOpen((v) => !v)}
					>
						<span aria-hidden="true">⚙</span>
					</MapControlButton>
				</MapControlGroup>
			</MapControlStack>

			{aboutOpen ? <aside className="mw-map-sheet mw-map-sheet--side">{panels.header}</aside> : null}

			{developerOpen ? (
				<aside className="mw-map-sheet mw-map-sheet--side" aria-label="Developer controls">
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
				</aside>
			) : null}

			{showSheet ? (
				<section className="mw-map-sheet mw-map-sheet--bottom" aria-label="Result">
					<div className="mw-map-sheet__handle" aria-hidden="true" />

					{loading && !runtime.ready ? (
						<LoadingIndicator
							mode="staged"
							steps={loading.stepLabels.length ? loading.stepLabels : undefined}
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

					{panels.permalink ? <div className="mw-map-sheet__actions">{panels.permalink(geocode.text)}</div> : null}
				</section>
			) : null}

			{panels.footer}
		</>
	)
}
