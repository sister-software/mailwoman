// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { coordinatePairText } from "@mailwoman/spatial/point-query"
import type React from "react"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import type { MapInstance } from "react-map-gl/maplibre"

import type { GeocoderPanels, GeocoderRuntime } from "#map/types"
import type { UseCompareState } from "#map/useCompareState"
import type { UseGeocode } from "#map/useGeocode"
import { useMapBearing } from "#map/useMapBearing"
import { type MapPick, useMapPick } from "#map/useMapPick"
import type { UsePlaceAutocomplete } from "#map/usePlaceAutocomplete"

import { LoadingIndicator } from "../common/LoadingIndicator.tsx"
import type { Preset } from "../common/PresetChips.tsx"
import { CompareToggle } from "./CompareToggle.tsx"
import { DebugInfo } from "./DebugInfo.tsx"
import { LoadLedgerList } from "./LoadLedgerList.tsx"
import { MapChipRow } from "./MapChipRow.tsx"
import { MapCompass } from "./MapCompass.tsx"
import { MapContextMenu, MapContextMenuAction, useMapContextMenu } from "./MapContextMenu.tsx"
import { MapControlButton, MapControlGroup, MapControlStack } from "./MapControlStack.tsx"
import { MapPlaceCard, pickQuery } from "./MapPlaceCard.tsx"
import { MapProgressBar } from "./MapProgressBar.tsx"
import { MapSearchBar, SearchGlyph } from "./MapSearchBar.tsx"
import { MapSheet } from "./MapSheet.tsx"
import { PlaceAutocomplete } from "./PlaceAutocomplete.tsx"
import { ResultPanel } from "./ResultPanel.tsx"
import { VersionPicker } from "./VersionPicker.tsx"

/**
 * Props for {@linkcode GeocoderControls}.
 */
export interface GeocoderControlsProps {
	runtime: GeocoderRuntime
	geocode: UseGeocode
	autocomplete: UsePlaceAutocomplete
	compare: UseCompareState
	/**
	 * The query the host's URL names.
	 *
	 * Each new value is submitted once the runtime is ready, unless it is the query submitted last.
	 */
	query?: string | null
	panels: GeocoderPanels
	presets: ReadonlyArray<Preset>
	/**
	 * The input placeholder.
	 *
	 * A host that pre-fills the field with the same text gets its value selected
	 * on focus, so typing replaces it.
	 */
	placeholder: string
	map?: MapInstance | null
	/**
	 * Called before each user-initiated query, so the host can write the query to its URL.
	 */
	onSubmitQuery?: (query: string) => void
	onSelectVersion: (version: string) => void
	/**
	 * Whether the developer panel starts open.
	 *
	 * @defaultValue `false`
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
 * Renders the search and result panels, map control rail and side sheets over the map.
 *
 * On narrow screens, users can drag the search panel between bottom-drawer detents.
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
	query = null,
	onSubmitQuery,
	onSelectVersion,
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
			// At or below this height, the drawer counts as collapsed.
			// The control rail then returns.
			collapsedBelow: viewport * 0.2,
		}
	}, [])

	// This ref holds a pull that started at the top of the panel's scroll.
	// It becomes a drag after `OVERSCROLL_PROMOTE_PX` of downward travel.
	const overscrollRef = useRef<{ startY: number; pointerId: number } | null>(null)

	// Drag gestures apply only in the drawer layout.
	// The desktop column is sized by its content.
	const isDrawerLayout = () => globalThis.window && globalThis.matchMedia(DRAWER_LAYOUT).matches

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

			// An upward drag makes the drawer taller, so the delta is inverted against the pointer's y.
			const delta = drag.startY - event.clientY

			if (Math.abs(delta) > DRAG_TRAVEL_PX) {
				drag.moved = true
			}

			const { floor, large } = sheetDetents()

			setSheetHeight(Math.min(large, Math.max(floor, drag.startHeight + delta)))
		},
		[sheetDetents]
	)

	// A tap, keyboard activation of the handle and the handle's `aria-expanded` state
	// all use this midpoint to select the drawer detent.
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

		// A press without travel counts as a tap.
		// It toggles between the two detents.
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
			// The drag starts from the pull's origin, so the drawer doesn't jump by the threshold.
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

	// The query submitted last, from the field or from the host's URL, so the URL's query
	// isn't submitted a second time after the host records the submit it heard.
	const lastSubmitted = useRef<string | null>(null)

	// Every user-initiated query goes through this function, so `onSubmitQuery` fires from one place.
	const runQuery = useCallback(
		(text: string) => {
			// A new query shows the result panel again at its default height.
			setResultDismissed(false)
			setSheetHeight(null)
			lastSubmitted.current = text
			onSubmitQuery?.(text)
			void geocode.submit(text)
		},
		[onSubmitQuery, geocode]
	)

	// An emptied field removes the result and its pin.
	// It also tells the host to drop the query from its URL.
	const clearQuery = useCallback(() => {
		geocode.reset()
		setSheetHeight(null)
		lastSubmitted.current = null
		onSubmitQuery?.("")
	}, [onSubmitQuery, geocode])

	// The URL's query waits for `runtime.ready` because the parse pipeline drops
	// a submit made before the model loads.
	// A later value, such as the one the back button restores, fills the field and runs.
	// A URL with no query after one with a query is the entry before the first search.
	// It clears the field and the result.
	useEffect(() => {
		if (query === lastSubmitted.current) return

		if (!query) {
			if (lastSubmitted.current === null) return

			lastSubmitted.current = null
			geocode.setText("")
			geocode.reset()

			return
		}

		if (!runtime.ready) return

		lastSubmitted.current = query
		geocode.setText(query)
		// oxlint-disable-next-line react/set-state-in-effect -- The history is the external system here: a restored entry's result shows again as a submitted one would.
		setResultDismissed(false)
		// This calls `geocode.submit` directly because the query is already in the URL.
		void geocode.submit(query)
	}, [query, runtime.ready, geocode])

	// A drawer-breakpoint crossing clears any dragged height.
	// The height could clip the desktop column.
	useEffect(() => {
		const layout = globalThis.matchMedia(DRAWER_LAYOUT)
		const onChange = () => setSheetHeight(null)

		layout.addEventListener("change", onChange)

		return () => layout.removeEventListener("change", onChange)
	}, [])

	// A user pan, zoom, or rotate shrinks the drawer to its floor detent without dismissing the result.
	// Programmatic camera moves, such as the fly-to after a query, have no `originalEvent` and are ignored.
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

	// A click on the map opens the place card for what it landed on and pins that point.
	// A label click also fills the field with the label's name, without a parse: the tile
	// feature already holds the coordinate, and a parse could land on a homonym elsewhere.
	const [pick, setPick] = useState<MapPick | null>(null)

	const onMapPick = useCallback(
		(picked: MapPick) => {
			const [lon, lat] = picked.lngLat

			if (picked.kind === "label" && picked.name) {
				geocode.setText(picked.name)
				geocode.reset()
			}

			geocode.pin({
				id: 0,
				name: pickQuery(picked),
				placetype: picked.placetype ?? "point",
				lat,
				lon,
				score: null,
				bbox: null,
				tier: null,
				uncertaintyM: null,
			})

			setPick(picked)
		},
		[geocode]
	)

	const closeCard = useCallback(() => {
		setPick(null)
		geocode.pin(null)
	}, [geocode])

	// Escape dismisses the result and the place card only while no side sheet is open.
	// `MapSheet` also listens for Escape on the document, so one keystroke would otherwise close both.
	useEffect(() => {
		if (openSheet) return

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setResultDismissed(true)
				closeCard()
			}
		}

		document.addEventListener("keydown", onKeyDown)

		return () => document.removeEventListener("keydown", onKeyDown)
	}, [openSheet, closeCard])

	useMapPick(map, onMapPick)

	// A search from the map fills the field and runs the text, as a typed query would.
	const searchFromMap = useCallback(
		(text: string) => {
			setPick(null)
			geocode.setText(text)
			geocode.reset()
			runQuery(text)
		},
		[geocode, runQuery]
	)

	// The right-click menu.
	// Its one built-in action searches the point itself.
	// The runtime reads that query as a coordinate pair.
	const contextMenu = useMapContextMenu(map)
	const menuPoint = contextMenu.point

	const searchMenuPoint = useCallback(() => {
		if (!menuPoint) return

		const [lon, lat] = menuPoint.lngLat

		contextMenu.close()
		searchFromMap(coordinatePairText(lat, lon))
	}, [menuPoint, contextMenu, searchFromMap])

	const chips = presets.map((preset) => ({ label: preset.label, value: preset.value }))
	// The model download doesn't open the result panel.
	// The progress bar reports it instead.
	const showSheet = Boolean(busy || result || errorMessage) && !resultDismissed

	// The control rail hides while the drawer is raised above its collapsed height.
	const drawerRaised =
		showSheet && (sheetHeight === null || (globalThis.window && sheetHeight > sheetDetents().collapsedBelow))

	// A failed load is over, so the bar stops and the error takes its place.
	const bundleLoading = Boolean(loading && !runtime.ready && !runtime.errorMessage)
	const steps = loading?.stepLabels.length ?? 0

	// The step index is the step in progress, so the steps before it are complete.
	// The model downloads during the first step.
	// While bytes arrive, the bar follows the byte fraction scaled into the first step's share,
	// so it doesn't move backwards when step progress takes over.
	const stepFraction = steps ? Math.max(0, loading?.stepIndex ?? 0) / steps : null
	const byteFraction = loading?.byteFraction

	const fraction =
		typeof byteFraction === "number" && steps ? (byteFraction * 1) / steps : (byteFraction ?? stepFraction)

	return (
		<>
			<MapProgressBar active={bundleLoading} fraction={fraction} label="Loading the geocoder" />

			{/* One panel holds the search, examples and result. On desktop it is a left column sized to its content.
			    On narrow screens it is a bottom drawer. */}
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
				{/*
				 * The header holds the grab bar and search field.
				 * It stays pinned while the result scrolls.
				 */}
				<div className="mw-map-panel__header" onPointerDown={onHeaderPointerDown}>
					<div className="mw-map-panel__grip">
						{/* The handle appears only with a result, because there's no content to expand without one. */}
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
					</div>

					<form
						className="mw-map-panel__search"
						onSubmit={(event) => {
							event.preventDefault()
							runQuery(geocode.text)
						}}
					>
						{/*
						 * The search bar has no trailing control because `type="search"`
						 * provides a native clear button.
						 *
						 * An empty field clears the result, its pin and the URL's query,
						 * so that button is the one way to clear a search.
						 */}
						<MapSearchBar label="Search addresses" leading={<SearchGlyph />} busy={busy}>
							<input
								id="mw-pipeline-input"
								type="search"
								aria-label="Address"
								value={geocode.text}
								onChange={(event) => {
									const text = event.target.value

									geocode.setText(text)

									if (text === "") {
										clearQuery()
									}
								}}
								// Focus selects the value only while it equals the placeholder, so typing replaces it.
								onFocus={(event) => {
									if (placeholder && event.currentTarget.value === placeholder) {
										event.currentTarget.select()
									}
								}}
								disabled={!runtime.ready}
								placeholder={placeholder}
								// An address is full of proper nouns and codes the browser's dictionary lacks.
								spellCheck={false}
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
						{errorMessage ? (
							<div className="mw-load-error">
								<p className="mw-error">{errorMessage}</p>
								{runtime.errorMessage && runtime.retryLoad ? (
									<button type="button" className="mw-load-error__retry" onClick={runtime.retryLoad}>
										Retry
									</button>
								) : null}
							</div>
						) : null}

						{runtime.errorMessage && loading?.ledger ? <LoadLedgerList ledger={loading.ledger} open /> : null}

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

			{/* Every floating control uses this rail to prevent overlap. The compass has its own group because it appears
			    and disappears. The rail hides while the drawer is raised. */}
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
						<span className="mw-map-sheet__label">Debug info</span>
						<DebugInfo
							activeBackend={runtime.activeBackend}
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

			{pick ? <MapPlaceCard pick={pick} onSearch={searchFromMap} onClose={closeCard} /> : null}

			{menuPoint ? (
				<MapContextMenu point={menuPoint} onClose={contextMenu.close}>
					{panels.contextMenu?.(menuPoint)}
					<MapContextMenuAction onSelect={searchMenuPoint}>Search this point</MapContextMenuAction>
				</MapContextMenu>
			) : null}

			{panels.footer}
		</>
	)
}
