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

import type React from "react"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
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
import { DebugInfo } from "./DebugInfo.tsx"
import { MapChipRow } from "./MapChipRow.tsx"
import { MapCompass } from "./MapCompass.tsx"
import { MapControlButton, MapControlGroup, MapControlStack } from "./MapControlStack.tsx"
import { MapProgressBar } from "./MapProgressBar.tsx"
import { MapSearchBar, SearchGlyph } from "./MapSearchBar.tsx"
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
	 * A query that arrived with the page (a permalink's `?q=`), run once as soon as the runtime is ready. See
	 * `GeocoderProps.initialQuery`.
	 */
	initialQuery?: string | null
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
	initialQuery = null,
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

	// The result sheet covers the bottom half of the map and had no way out: no close, no Escape, no backdrop — the
	// only way to clear it was to run another query. `MapSheet` states the rule for the other four sheets ("the close
	// button is not optional"); this one is hand-rolled and never got it. Reset on every new query, below.
	const [resultDismissed, setResultDismissed] = useState(false)

	// The result sheet's height, in px, once a visitor has dragged it; `null` means the stylesheet's default detent.
	const sheetRef = useRef<HTMLElement>(null)
	const [sheetHeight, setSheetHeight] = useState<number | null>(null)
	const sheetDragRef = useRef<{ startY: number; startHeight: number; moved: boolean } | null>(null)

	// Detents as fractions of the viewport, resolved at interaction time so a rotated phone or a resized window gets
	// the right numbers without a listener.
	const sheetDetents = useCallback(() => {
		const viewport = window.innerHeight

		return {
			medium: viewport * 0.52,
			large: viewport * 0.88,
			floor: viewport * 0.15,
			// Released below this, the drag reads as "put it away" rather than "make it small".
			dismissBelow: viewport * 0.28,
		}
	}, [])

	const onGripPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
		const sheet = sheetRef.current

		if (!sheet) return

		event.currentTarget.setPointerCapture(event.pointerId)
		sheetDragRef.current = { startY: event.clientY, startHeight: sheet.getBoundingClientRect().height, moved: false }
	}, [])

	const onGripPointerMove = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			const drag = sheetDragRef.current

			if (!drag) return

			// Up is taller, so the delta is inverted against the pointer's y.
			const delta = drag.startY - event.clientY

			if (Math.abs(delta) > 3) drag.moved = true

			const { floor, large } = sheetDetents()

			setSheetHeight(Math.min(large, Math.max(floor, drag.startHeight + delta)))
		},
		[sheetDetents]
	)

	const onGripPointerUp = useCallback(() => {
		const drag = sheetDragRef.current

		if (!drag) return

		sheetDragRef.current = null

		const { medium, large, dismissBelow } = sheetDetents()
		const midpoint = (medium + large) / 2
		const current = sheetRef.current?.getBoundingClientRect().height ?? medium

		// A press with no travel is a tap: toggle between the two detents, which is what a keyboard gets too.
		if (!drag.moved) {
			setSheetHeight(current > midpoint ? medium : large)

			return
		}

		if (current < dismissBelow) {
			setResultDismissed(true)
			setSheetHeight(null)

			return
		}

		setSheetHeight(current > midpoint ? large : medium)
	}, [sheetDetents])
	const { bearing, resetNorth } = useMapBearing(map)

	const toggleSheet = (name: Exclude<SheetName, null>) => setOpenSheet((current) => (current === name ? null : name))
	const closeSheet = useCallback(() => setOpenSheet(null), [])

	// Every path that starts a query goes through here, so the URL is written in exactly one place — the event that
	// caused it, rather than an effect watching the result after the fact.
	const runQuery = useCallback(
		(query: string) => {
			// A new query is a new answer: whatever the visitor dismissed, they want to see this one, at the size the
			// stylesheet picks rather than whatever the last drag left behind.
			setResultDismissed(false)
			setSheetHeight(null)
			onSubmitQuery?.(query)
			void geocode.submit(query)
		},
		[onSubmitQuery, geocode]
	)

	// A permalink answers on arrival. `runtime.ready` holds it back — the parse pipeline drops a submit made before the
	// model is loaded, which is exactly the window a cold permalink lands in — and the ref makes it once-only, so a
	// later re-render (or the visitor clearing the field) cannot re-run the URL's query over their own work.
	const autoRanInitialQuery = useRef(false)

	useEffect(() => {
		if (autoRanInitialQuery.current) return

		if (!initialQuery || !runtime.ready) return

		autoRanInitialQuery.current = true
		// `geocode.submit` rather than `runQuery`: the query is already in the URL, so writing it back is a no-op that
		// would only add a history entry's worth of churn.
		void geocode.submit(initialQuery)
	}, [initialQuery, runtime.ready, geocode])

	// Escape dismisses the result sheet, matching `MapSheet`.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setResultDismissed(true)
			}
		}

		document.addEventListener("keydown", onKeyDown)

		return () => document.removeEventListener("keydown", onKeyDown)
	}, [])

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
	const showSheet = Boolean(busy || result || errorMessage) && !resultDismissed

	const bundleLoading = Boolean(loading && !runtime.ready)
	const steps = loading?.stepLabels.length ?? 0

	// The model downloads BEFORE the first step is entered, so the step fraction holds at 1/steps for the whole of a
	// 38 MB transfer — the part of the wait a visitor actually sits through. While bytes are arriving the bar follows
	// them, scaled into the first step's share so it never runs backwards when the steps take over.
	const stepFraction = steps ? ((loading?.stepIndex ?? 0) + 1) / steps : null
	const byteFraction = loading?.byteFraction

	const fraction =
		typeof byteFraction === "number" && steps ? (byteFraction * 1) / steps : (byteFraction ?? stepFraction)

	return (
		<>
			<MapProgressBar active={bundleLoading} fraction={fraction} label="Loading the geocoder" />

			{/*
			 * ONE surface owns the search, the examples and the result — the arrangement the reference map apps use.
			 * They used to be two: a floating pill at the top and a separate bottom sheet, which is what put the search
			 * field in the same row as the control rail (the rail won, and covered its right end) and left a phone with
			 * a result sheet it could not get back from.
			 *
			 * Desktop: a column down the left, sized to its content, over a full-bleed map.
			 * Phone: a bottom drawer with detents, the search riding at its top.
			 */}
			<section
				className="mw-map-panel"
				aria-label="Search and results"
				ref={sheetRef}
				{...(sheetHeight === null ? {} : { style: { maxHeight: `${Math.round(sheetHeight)}px` } })}
			>
				{/*
				 * The drawer's grab bar. Sticky and opaque so it survives the panel scrolling under it; the handle is
				 * only meaningful where the panel IS a drawer, so CSS hides it on the desktop column.
				 */}
				<div className="mw-map-panel__grip">
					{/*
					 * The handle appears only WITH a result. With the drawer holding a search field and a row of examples
					 * there is nothing behind it to pull into view, and a handle offered over nothing either expands a band
					 * of empty glass or reads as broken — the same fault as the decorative handle it replaced.
					 */}
					{showSheet ? (
						<button
							type="button"
							className="mw-map-sheet__handle"
							aria-label="Resize the panel"
							aria-expanded={sheetHeight !== null && sheetHeight > window.innerHeight * 0.7}
							onPointerDown={onGripPointerDown}
							onPointerMove={onGripPointerMove}
							onPointerUp={onGripPointerUp}
							onPointerCancel={onGripPointerUp}
						/>
					) : null}

					{showSheet ? (
						<button
							type="button"
							className="mw-map-sheet__close mw-map-sheet__close--floating"
							aria-label="Close the result"
							onClick={() => setResultDismissed(true)}
						>
							<span aria-hidden="true">×</span>
						</button>
					) : null}
				</div>

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
					<MapSearchBar label="Search addresses" leading={<SearchGlyph />} busy={busy}>
						<input
							id="mw-pipeline-input"
							type="search"
							aria-label="Address"
							value={geocode.text}
							onChange={(event) => geocode.setText(event.target.value)}
							// The field ships pre-filled with the demo address, so the first click used to drop a caret in the
							// middle of it and the visitor typed into someone else's address. Select the seed on focus so one
							// keystroke replaces it — and only while it IS the untouched seed, so this never eats real work.
							onFocus={(event) => {
								if (placeholder && event.currentTarget.value === placeholder) {
									event.currentTarget.select()
								}
							}}
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

				{showSheet ? (
					<div className="mw-map-panel__result">
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
					</div>
				) : null}
			</section>

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
						<span className="mw-map-sheet__label">Debug info</span>
						<DebugInfo
							activeBackend={runtime.activeBackend}
							forceWASM={runtime.forceWASM}
							selectedVersion={runtime.selectedVersion}
							ready={runtime.ready}
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

			{panels.footer}
		</>
	)
}
