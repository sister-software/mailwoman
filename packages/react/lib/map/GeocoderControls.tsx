/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
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
import { MapSheet, SheetClose } from "./MapSheet.tsx"
import { PlaceAutocomplete } from "./PlaceAutocomplete.tsx"
import { ResultPanel } from "./ResultPanel.tsx"
import { VersionPicker } from "./VersionPicker.tsx"

/**
 * Props for {@linkcode GeocoderControls}.
 */
export interface GeocoderControlsProps {
	/**
	 * The geocoder runtime supplied by the host.
	 */
	runtime: GeocoderRuntime
	/**
	 * The parse and resolve state.
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
	 * A query from the URL to run once the runtime is ready.
	 */
	initialQuery?: string | null
	/**
	 * Panels supplied by the host.
	 */
	panels: GeocoderPanels
	/**
	 * The example chips.
	 */
	presets: ReadonlyArray<Preset>
	/**
	 * The input placeholder.
	 *
	 * The field also selects its value on focus while it still equals this text.
	 */
	placeholder: string
	/**
	 * The map instance used by the compass, label picking, and layer controls.
	 */
	map?: MapInstance | null
	/**
	 * Called before each user-initiated query, so the host can write the query to its URL.
	 */
	onSubmitQuery?: (query: string) => void
	/**
	 * Called when the user selects a model version.
	 */
	onSelectVersion: (version: string) => void
	/**
	 * Called when the user toggles the forced WASM backend.
	 */
	onForceWASMChange: (forceWASM: boolean) => void
	/**
	 * Whether the developer panel starts open.
	 *
	 * @default false
	 */
	developer?: boolean
}

type SheetName = "about" | "layers" | "developer" | null

/**
 * The media query for the bottom-drawer layout.
 * It must match the breakpoint in `styles.css`.
 */
const DRAWER_LAYOUT = "(max-width: 600px)"

/**
 * The pointer travel, in px, that turns a press on the header into a drag instead of a tap.
 */
const DRAG_TRAVEL_PX = 3

/**
 * The downward travel, in px, that turns a pull at the top of the panel's scroll into a drawer drag.
 */
const OVERSCROLL_PROMOTE_PX = 8

/**
 * Renders the search panel, result panel, map control rail, and side sheets over the map.
 *
 * On narrow screens the search panel is a bottom drawer that the user can drag between detents.
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

	// Only one side sheet is open at a time, because two would stack on the same edge.
	const [openSheet, setOpenSheet] = useState<SheetName>(developer ? "developer" : null)

	// This flag hides the result panel until the next query resets it.
	const [resultDismissed, setResultDismissed] = useState(false)

	// The drawer height is in px.
	// A `null` height leaves the size to the stylesheet.
	const sheetRef = useRef<HTMLElement>(null)
	const [sheetHeight, setSheetHeight] = useState<number | null>(null)
	const sheetDragRef = useRef<{ startY: number; startHeight: number; moved: boolean } | null>(null)

	// The detents are computed on each call, so a rotated or resized viewport needs no resize listener.
	const sheetDetents = useCallback(() => {
		const viewport = window.innerHeight

		return {
			medium: viewport * 0.52,
			large: viewport * 0.88,
			floor: viewport * 0.15,
			// A drag released below this height dismisses the result.
			dismissBelow: viewport * 0.28,
			// At or below this height the drawer counts as collapsed, and the control rail returns.
			collapsedBelow: viewport * 0.2,
		}
	}, [])

	// This ref holds a pull that started at the top of the panel's scroll.
	// It becomes a drag after `OVERSCROLL_PROMOTE_PX` of downward travel.
	const overscrollRef = useRef<{ startY: number; pointerId: number } | null>(null)

	// Drag gestures apply only in the drawer layout.
	// The desktop column is sized by its content.
	const isDrawerLayout = () => globalThis.window !== undefined && globalThis.matchMedia(DRAWER_LAYOUT).matches

	const beginSheetDrag = useCallback((clientY: number, pointerId: number) => {
		const sheet = sheetRef.current

		if (!sheet) return

		sheet.setPointerCapture(pointerId)
		sheetDragRef.current = { startY: clientY, startHeight: sheet.getBoundingClientRect().height, moved: false }
	}, [])

	// The whole header is the grab target, except the search input and the close button.
	const onHeaderPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (!isDrawerLayout()) return

			if (event.target instanceof Element && event.target.closest("input, .mw-map-sheet__close")) return

			beginSheetDrag(event.clientY, event.pointerId)
		},
		[beginSheetDrag]
	)

	const onGripPointerMove = useCallback(
		(event: React.PointerEvent<HTMLElement>) => {
			const drag = sheetDragRef.current

			if (!drag) return

			// Dragging up makes the drawer taller, so the delta is inverted against the pointer's y.
			const delta = drag.startY - event.clientY

			if (Math.abs(delta) > DRAG_TRAVEL_PX) {
				drag.moved = true
			}

			const { floor, large } = sheetDetents()

			setSheetHeight(Math.min(large, Math.max(floor, drag.startHeight + delta)))
		},
		[sheetDetents]
	)

	// A tap, the handle's keyboard activation, and the handle's `aria-expanded` all
	// use this midpoint to decide which detent the drawer is at.
	const detentMidpoint = useCallback(() => {
		const { medium, large } = sheetDetents()

		return (medium + large) / 2
	}, [sheetDetents])

	const atLargeDetent = () => sheetHeight !== null && sheetHeight > detentMidpoint()

	const toggleDetent = useCallback(() => {
		const { medium, large } = sheetDetents()
		const current = sheetRef.current?.getBoundingClientRect().height ?? medium

		setSheetHeight(current > detentMidpoint() ? medium : large)
	}, [sheetDetents, detentMidpoint])

	const onGripPointerUp = useCallback(() => {
		const drag = sheetDragRef.current

		if (!drag) return

		sheetDragRef.current = null

		const { medium, large, dismissBelow } = sheetDetents()
		const midpoint = (medium + large) / 2
		const current = sheetRef.current?.getBoundingClientRect().height ?? medium

		// A press without travel is a tap, which toggles between the two detents.
		if (!drag.moved) {
			toggleDetent()

			return
		}

		if (current < dismissBelow) {
			setResultDismissed(true)
			setSheetHeight(null)

			return
		}

		setSheetHeight(current > midpoint ? large : medium)
	}, [sheetDetents, toggleDetent])

	// A downward pull on a panel scrolled to its top drags the drawer down.
	// This handler only arms the pull; `onPanelPointerMove` promotes it, so taps
	// and upward scrolls are unaffected.
	const onPanelPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
		if (!isDrawerLayout()) return

		if (sheetDragRef.current) return

		const sheet = sheetRef.current

		if (!sheet || sheet.scrollTop > 0) return

		if (event.target instanceof Element && event.target.closest(".mw-map-panel__header")) return

		overscrollRef.current = { startY: event.clientY, pointerId: event.pointerId }
	}, [])

	const onPanelPointerMove = useCallback(
		(event: React.PointerEvent<HTMLElement>) => {
			if (sheetDragRef.current) {
				onGripPointerMove(event)

				return
			}

			const armed = overscrollRef.current

			if (!armed || armed.pointerId !== event.pointerId) return

			const sheet = sheetRef.current

			if (!sheet) return

			if (sheet.scrollTop > 0) {
				overscrollRef.current = null

				return
			}

			if (event.clientY - armed.startY < OVERSCROLL_PROMOTE_PX) return

			overscrollRef.current = null
			// The drag starts from the pull's origin, so the drawer does not jump by the threshold.
			sheetDragRef.current = { startY: armed.startY, startHeight: sheet.getBoundingClientRect().height, moved: true }
			sheet.setPointerCapture(event.pointerId)
			onGripPointerMove(event)
		},
		[onGripPointerMove]
	)

	const onPanelPointerUp = useCallback(() => {
		overscrollRef.current = null
		onGripPointerUp()
	}, [onGripPointerUp])

	const { bearing, resetNorth } = useMapBearing(map)

	const toggleSheet = (name: Exclude<SheetName, null>) => setOpenSheet((current) => (current === name ? null : name))
	const closeSheet = useCallback(() => setOpenSheet(null), [])

	// Every user-initiated query goes through this function, so `onSubmitQuery` fires from one place.
	const runQuery = useCallback(
		(query: string) => {
			// A new query shows the result panel again at its default height.
			setResultDismissed(false)
			setSheetHeight(null)
			onSubmitQuery?.(query)
			void geocode.submit(query)
		},
		[onSubmitQuery, geocode]
	)

	// The initial query waits for `runtime.ready` because the parse pipeline drops
	// a submit made before the model loads.
	// The ref makes it run once, so a later render cannot overwrite the user's own query.
	const autoRanInitialQuery = useRef(false)

	useEffect(() => {
		if (autoRanInitialQuery.current) return

		if (!initialQuery || !runtime.ready) return

		autoRanInitialQuery.current = true
		// This calls `geocode.submit` directly because the query is already in the URL.
		void geocode.submit(initialQuery)
	}, [initialQuery, runtime.ready, geocode])

	// Crossing the drawer breakpoint clears a dragged height, which would otherwise clip the desktop column.
	useEffect(() => {
		const query = globalThis.matchMedia(DRAWER_LAYOUT)
		const onChange = () => setSheetHeight(null)

		query.addEventListener("change", onChange)

		return () => query.removeEventListener("change", onChange)
	}, [])

	// A user pan, zoom, or rotate shrinks the drawer to its floor detent without dismissing the result.
	// Programmatic camera moves, such as the fly-to after a query, carry no `originalEvent` and are ignored.
	useEffect(() => {
		if (!map) return

		const collapse = (event: { originalEvent?: unknown }) => {
			if (!event.originalEvent) return

			if (!isDrawerLayout()) return

			const { floor } = sheetDetents()

			setSheetHeight((current) => (current !== null && current <= floor ? current : floor))
		}

		map.on("dragstart", collapse)
		map.on("zoomstart", collapse)
		map.on("rotatestart", collapse)

		return () => {
			map.off("dragstart", collapse)
			map.off("zoomstart", collapse)
			map.off("rotatestart", collapse)
		}
	}, [map, sheetDetents])

	// Escape dismisses the result only while no side sheet is open.
	// `MapSheet` also listens for Escape on the document, so one keystroke would otherwise close both.
	useEffect(() => {
		if (openSheet) return

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setResultDismissed(true)
			}
		}

		document.addEventListener("keydown", onKeyDown)

		return () => document.removeEventListener("keydown", onKeyDown)
	}, [openSheet])

	// Clicking a map label searches for its name.
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
	// The model download does not open the result panel.
	// The progress bar reports it instead.
	const showSheet = Boolean(busy || result || errorMessage) && !resultDismissed

	// The control rail hides while the drawer is raised above its collapsed height.
	const drawerRaised =
		showSheet &&
		(sheetHeight === null || (globalThis.window !== undefined && sheetHeight > sheetDetents().collapsedBelow))

	const bundleLoading = Boolean(loading && !runtime.ready)
	const steps = loading?.stepLabels.length ?? 0

	// The model downloads during the first step.
	// While bytes arrive, the bar follows the byte fraction scaled into the first step's share,
	// so it does not move backwards when step progress takes over.
	const stepFraction = steps ? ((loading?.stepIndex ?? 0) + 1) / steps : null
	const byteFraction = loading?.byteFraction

	const fraction =
		typeof byteFraction === "number" && steps ? (byteFraction * 1) / steps : (byteFraction ?? stepFraction)

	return (
		<>
			<MapProgressBar active={bundleLoading} fraction={fraction} label="Loading the geocoder" />

			{/*
			 * One panel holds the search, the examples, and the result.
			 *
			 * On desktop it is a left column sized to its content.
			 * On narrow screens it is a bottom drawer.
			 */}
			<section
				className="mw-map-panel"
				aria-label="Search and results"
				ref={sheetRef}
				onPointerDown={onPanelPointerDown}
				onPointerMove={onPanelPointerMove}
				onPointerUp={onPanelPointerUp}
				onPointerCancel={onPanelPointerUp}
				{...(sheetHeight === null ? {} : { style: { maxHeight: `${Math.round(sheetHeight)}px` } })}
			>
				{/* The header holds the grab bar and the search field, and it stays pinned while the result scrolls. */}
				<div className="mw-map-panel__header" onPointerDown={onHeaderPointerDown}>
					<div className="mw-map-panel__grip">
						{/* The handle appears only with a result, because there is no content to expand without one. */}
						{showSheet ? (
							<button
								type="button"
								className="mw-map-sheet__handle"
								aria-label="Resize the panel"
								aria-expanded={atLargeDetent()}
								// The header handles pointer gestures.
								// A click with `detail === 0` comes from the keyboard,
								// so only that toggles the detent here.
								onClick={(event) => {
									if (event.detail !== 0) return

									toggleDetent()
								}}
							/>
						) : null}

						{showSheet ? (
							<SheetClose
								label="Close the result"
								className="mw-map-sheet__close--floating"
								onClose={() => setResultDismissed(true)}
							/>
						) : null}
					</div>

					<form
						className="mw-map-panel__search"
						onSubmit={(event) => {
							event.preventDefault()
							runQuery(geocode.text)
						}}
					>
						{/* The search bar has no trailing control because `type="search"` provides a native clear button. */}
						<MapSearchBar label="Search addresses" leading={<SearchGlyph />} busy={busy}>
							<input
								id="mw-pipeline-input"
								type="search"
								aria-label="Address"
								value={geocode.text}
								onChange={(event) => geocode.setText(event.target.value)}
								// Focus selects the value only while it equals the placeholder, so typing replaces it.
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
				</div>

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
			 * Every floating control lives in this one rail so none can overlap.
			 *
			 * The compass has its own group because it appears and disappears.
			 * The rail hides while the drawer is raised.
			 */}
			<MapControlStack label="Map controls" className={drawerRaised ? "mw-map-control-stack--drawer-open" : undefined}>
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
