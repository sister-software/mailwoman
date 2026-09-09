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

import { type ReactNode, useCallback, useState } from "react"
import type { MapInstance } from "react-map-gl/maplibre"

import type { GeocoderPanels, GeocoderRuntime } from "#map/types"
import type { UseCompareState } from "#map/useCompareState"
import type { UseGeocode } from "#map/useGeocode"
import { useMapBearing } from "#map/useMapBearing"
import { useMapLabelPick } from "#map/useMapLabelPick"
import type { UsePlaceAutocomplete } from "#map/usePlaceAutocomplete"

import { LoadingIndicator } from "../common/LoadingIndicator.tsx"
import type { Preset } from "../common/PresetChips.tsx"
import { BackendControl } from "./BackendControl.tsx"
import { CompareToggle } from "./CompareToggle.tsx"
import { MapChipRow } from "./MapChipRow.tsx"
import { MapCompass } from "./MapCompass.tsx"
import { MapControlButton, MapControlGroup, MapControlStack } from "./MapControlStack.tsx"
import { MapProgressBar } from "./MapProgressBar.tsx"
import { MapSearchBar } from "./MapSearchBar.tsx"
import { MapSheet } from "./MapSheet.tsx"
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
	 * The live map, for the controls that read it: the compass takes its bearing, the host's layer control reads its
	 * style. `null` until react-map-gl instantiates the map.
	 */
	map?: MapInstance | null
	/**
	 * Fired with the query whenever one is submitted, before the parse starts. The host writes it into the URL; this
	 * package never touches `location`, because the address bar is the app's state, not a control's.
	 */
	onSubmitQuery?: (query: string) => void
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
 * Which side sheet is open. At most one, because they share an edge and a phone gives each the whole panel.
 */
type SheetName = "about" | "layers" | "developer" | null

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
	map = null,
	onSubmitQuery,
	onSelectVersion,
	onForceWASMChange,
	developer = false,
}: GeocoderControlsProps): ReactNode {
	const versions = runtime.availableVersions ?? []
	const { busy, result, selectedCandidate } = geocode
	const loading = runtime.loading
	const errorMessage = geocode.parseError ?? runtime.errorMessage ?? null

	// One sheet at a time. Two open at once stack on the same edge, and on a phone each is the full panel.
	const [openSheet, setOpenSheet] = useState<SheetName>(developer ? "developer" : null)
	const { bearing, resetNorth } = useMapBearing(map)

	const toggleSheet = (name: Exclude<SheetName, null>) => setOpenSheet((current) => (current === name ? null : name))
	const closeSheet = useCallback(() => setOpenSheet(null), [])

	// Every path that starts a query goes through here, so the URL is written in exactly one place — the event that
	// caused it, rather than an effect watching the result after the fact.
	const runQuery = useCallback(
		(query: string) => {
			onSubmitQuery?.(query)
			void geocode.submit(query)
		},
		[onSubmitQuery, geocode]
	)

	// A label on the map is a search a visitor already typed by pointing at it.
	const pickLabel = useCallback(
		(name: string) => {
			geocode.setText(name)
			geocode.reset()
			runQuery(name)
		},
		[geocode, runQuery]
	)

	useMapLabelPick(map, pickLabel)

	const chips = presets.map((preset) => ({ label: preset.label, value: preset.value }))
	// The bundle load no longer opens the result sheet: it reports on the bar at the top of the viewport and in the
	// footer, so an empty sheet does not sit over the map for the length of a 38 MB download.
	const showSheet = Boolean(busy || result || errorMessage)

	const bundleLoading = Boolean(loading && !runtime.ready)
	const steps = loading?.stepLabels.length ?? 0

	return (
		<>
			<MapProgressBar
				active={bundleLoading}
				fraction={steps ? ((loading?.stepIndex ?? 0) + 1) / steps : null}
				label="Loading the geocoder"
			/>

			<div className="mw-map-chrome mw-map-chrome--top">
				<form
					className="mw-map-chrome__search"
					onSubmit={(event) => {
						event.preventDefault()
						runQuery(geocode.text)
					}}
				>
					{/*
					 * `type="search"` brings its own clear button, so the pill carries no trailing slot: a second cross
					 * beside the native one is two controls for one job, and the spinner that used to live there changed
					 * the field's height on every submit.
					 */}
					<MapSearchBar label="Search addresses" leading={<span aria-hidden="true">⌕</span>} busy={busy}>
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
					activeValue={geocode.text}
					disabled={!runtime.ready || busy}
					onPick={(value) => {
						geocode.setText(value)
						geocode.reset()
						runQuery(value)
					}}
				/>

				{panels.bias}
			</div>

			{/*
			 * Every floating control lives in this one column, so nothing can land on top of anything else: the layer
			 * control joins the capsule rather than sitting in the left column, and the compass takes its own capsule
			 * below because it comes and goes and would otherwise resize the one above it.
			 */}
			<MapControlStack label="Map controls">
				<MapControlGroup>
					<MapControlButton
						label="About this geocoder"
						active={openSheet === "about"}
						onPress={() => toggleSheet("about")}
					>
						<span aria-hidden="true">i</span>
					</MapControlButton>

					{panels.layers ? (
						<MapControlButton label="Map layers" active={openSheet === "layers"} onPress={() => toggleSheet("layers")}>
							<span aria-hidden="true">≡</span>
						</MapControlButton>
					) : null}

					<MapControlButton
						label="Developer controls"
						active={openSheet === "developer"}
						onPress={() => toggleSheet("developer")}
					>
						<span aria-hidden="true">⚙</span>
					</MapControlButton>
				</MapControlGroup>

				<MapControlGroup className="mw-map-control-group--compass">
					<MapCompass bearing={bearing} onResetNorth={resetNorth} />
				</MapControlGroup>
			</MapControlStack>

			{openSheet === "about" ? (
				<MapSheet title="About" onClose={closeSheet}>
					{panels.header}
				</MapSheet>
			) : null}

			{openSheet === "layers" ? (
				<MapSheet title="Layers" onClose={closeSheet}>
					{panels.layers?.({ map })}
				</MapSheet>
			) : null}

			{openSheet === "developer" ? (
				<MapSheet title="Developer" onClose={closeSheet}>
					{panels.releaseInfo ? (
						<div className="mw-map-sheet__row">
							<span className="mw-map-sheet__label">This release</span>
							{panels.releaseInfo}
						</div>
					) : null}

					<div className="mw-map-sheet__row">
						<VersionPicker
							versions={versions}
							selected={runtime.selectedVersion ?? null}
							onSelect={onSelectVersion}
							disabled={busy}
						/>
					</div>

					<div className="mw-map-sheet__row">
						<BackendControl
							activeBackend={runtime.activeBackend}
							forceWASM={runtime.forceWASM ?? false}
							onForceWASMChange={onForceWASMChange}
						/>
					</div>

					<div className="mw-map-sheet__row">
						<CompareToggle
							versions={versions}
							primaryVersion={runtime.selectedVersion ?? null}
							compareMode={compare.compareMode}
							onCompareModeChange={compare.setCompareMode}
							compareVersion={compare.compareVersion}
							onCompareVersionChange={compare.setCompareVersion}
							disabled={busy}
						/>
					</div>

					{panels.developerExtras}
				</MapSheet>
			) : null}

			{showSheet ? (
				<section className="mw-map-sheet mw-map-sheet--bottom" aria-label="Result">
					<div className="mw-map-sheet__handle" aria-hidden="true" />

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
