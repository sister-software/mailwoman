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
 *   node-safe: pure React + the shared units, no maplibre.
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
	 * A query that arrived with the page (a permalink's `?q=`), run once as soon as
	 * the runtime is ready. See `GeocoderProps.initialQuery`.
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
	 * The live map, for the controls that read it: the compass takes its direction,
	 * the host's layer control reads its style. `null` until react-map-gl instantiates the map.
	 */
	map?: MapInstance | null
	/**
	 * Fired with the query whenever one is submitted, before the parse starts.
	 * The host writes it into the URL. this package never touches `location`,
	 * because the address bar is the app's state rather than a control's.
	 */
	onSubmitQuery?: (query: string) => void
	/**
	 * Select a model version (the composed geocoder also clears a now-colliding compare selection).
	 */
	onSelectVersion: (version: string) => void
	/**
	 * Toggle the forced wasm backend.
	 */
	onForceWASMChange: (forceWASM: boolean) => void
	/**
	 * Open the developer panel on mount. The model version, the backend readout
	 * and compare live inside it: they read on the model rather than on an address,
	 * and above the query field they were the first thing every visitor met.
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
 * The width at or below which the panel is a bottom drawer rather than a left column.
 *
 * Stated once, and it has to agree with the `@media (max-width: 600px)` block in
 * `styles.css` that actually moves the panel: the gestures below arm on this query,
 * so a disagreement arms a drag on a layout with nowhere to drag to.
 */
const DRAWER_LAYOUT = "(max-width: 600px)"

/**
 * Travel, in pixels, that turns a press on the drawer's header into a drag rather than a tap.
 *
 * A finger never holds still, so zero would make every tap a one-pixel drag
 * and put the tap-to-toggle path out of reach. Three is the smallest number that
 * survives a resting hand without swallowing a deliberate short pull.
 */
const DRAG_TRAVEL_PX = 3

/**
 * Downward travel, in pixels, that promotes a pull at the top of the scroll into a drag on the drawer.
 *
 * Larger than {@link DRAG_TRAVEL_PX} because this gesture starts on the content,
 * where the same few pixels could still turn out to be a scroll: the drawer must not
 * start moving under a reader who meant to flick the result up.
 */
const OVERSCROLL_PROMOTE_PX = 8

/**
 * The chrome. Everything positioned here floats over the map. nothing occupies a column of the page.
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

	// The result sheet covers the bottom half of the map and had no way out: no close,
	// no Escape, no backdrop — the only way to clear it was to run another query.
	// `MapSheet` states the rule for the other four sheets ("the close button is not optional");
	// this one is hand-rolled and never got it. Reset on every new query, below.
	const [resultDismissed, setResultDismissed] = useState(false)

	// The result sheet's height, in px, once a visitor has dragged it; `null` means the stylesheet's default detent.
	const sheetRef = useRef<HTMLElement>(null)
	const [sheetHeight, setSheetHeight] = useState<number | null>(null)
	const sheetDragRef = useRef<{ startY: number; startHeight: number; moved: boolean } | null>(null)

	// Detents as fractions of the viewport, resolved at interaction time so a rotated phone
	// or a resized window gets the right numbers without a listener.
	const sheetDetents = useCallback(() => {
		const viewport = window.innerHeight

		return {
			medium: viewport * 0.52,
			large: viewport * 0.88,
			floor: viewport * 0.15,
			// Released below this, the drag reads as "put it away" rather than "make it small".
			dismissBelow: viewport * 0.28,
			// At or under this the drawer is a search field over a map rather than a panel standing on one.
			collapsedBelow: viewport * 0.2,
		}
	}, [])

	/*
	 * A pull that began at the top of the scroll rather than on the header.
	 * Armed on pointer-down and promoted to a real drag once it has travelled far enough
	 * downward — until then it is still a scroll, and a tap is neither.
	 */
	const overscrollRef = useRef<{ startY: number; pointerId: number } | null>(null)

	// The detents exist only where the panel is a drawer.
	// The desktop column is sized by its content and has nothing to drag towards,
	// so every pointer gesture there is a scroll or a click.
	const isDrawerLayout = () => globalThis.window !== undefined && globalThis.matchMedia(DRAWER_LAYOUT).matches

	const beginSheetDrag = useCallback((clientY: number, pointerId: number) => {
		const sheet = sheetRef.current

		if (!sheet) return

		sheet.setPointerCapture(pointerId)
		sheetDragRef.current = { startY: clientY, startHeight: sheet.getBoundingClientRect().height, moved: false }
	}, [])

	/*
	 * The whole header is the grab target rather than just the pill: that is the
	 * part of a sheet a thumb lands on, and the pill alone is a 3rem strip to hit.
	 * The field and the close keep their own gestures.
	 */
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

			// Up is taller, so the delta is inverted against the pointer's y.
			const delta = drag.startY - event.clientY

			if (Math.abs(delta) > DRAG_TRAVEL_PX) {
				drag.moved = true
			}

			const { floor, large } = sheetDetents()

			setSheetHeight(Math.min(large, Math.max(floor, drag.startHeight + delta)))
		},
		[sheetDetents]
	)

	/*
	 * The two-detent toggle, in one place. A tap on the bar, Enter on the pill,
	 * and the `aria-expanded` the pill reports are the same question asked three ways,
	 * and they were three copies of `(medium + large) / 2` — one of them the literal `0.7`,
	 * which is that midpoint written out by hand and silently wrong the moment a detent moves.
	 */
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

		// A press with no travel is a tap: toggle between the two detents, which is what a keyboard gets too.
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

	/*
	 * overscroll is A drag rather than a bounce. Pull down on a sheet that is already scrolled
	 * to its top and the sheet itself should come down — that is what the reference sheets do,
	 * and it is what makes a drawer dismissable without first hunting for the pill.
	 * A rubber band in that position says the gesture was heard and refused.
	 *
	 * The pull is only armed here. it becomes a drag after 8px of downward travel,
	 * so a tap stays a tap and a flick upward stays a scroll.
	 */
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
			// Measured from where the pull started, so the sheet does not jump by the threshold at the moment it takes over.
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

	// Every path that starts a query goes through here, so the URL is written in exactly one place —
	// the event that caused it, rather than an effect watching the result after the fact.
	const runQuery = useCallback(
		(query: string) => {
			// A new query is a new answer: whatever the visitor dismissed, they want to see this one,
			// at the size the stylesheet picks rather than whatever the last drag left behind.
			setResultDismissed(false)
			setSheetHeight(null)
			onSubmitQuery?.(query)
			void geocode.submit(query)
		},
		[onSubmitQuery, geocode]
	)

	// A permalink answers on arrival. `runtime.ready` holds it back — the parse pipeline drops
	// a submit made before the model is loaded. It is exactly the window a cold permalink
	// lands in — and the ref makes it once-only. Therefore, a later re-render
	// (or the visitor clearing the field) cannot re-run the URL's query over their own work.
	const autoRanInitialQuery = useRef(false)

	useEffect(() => {
		if (autoRanInitialQuery.current) return

		if (!initialQuery || !runtime.ready) return

		autoRanInitialQuery.current = true
		// `geocode.submit` rather than `runQuery`: the query is already in the URL,
		// so writing it back is a no-op that would only add a history entry's worth of churn.
		void geocode.submit(initialQuery)
	}, [initialQuery, runtime.ready, geocode])

	/*
	 * A dragged height belongs to the layout it was dragged in.
	 * Carried across the breakpoint it clipped the desktop column at whatever detent a
	 * phone-width drag had left behind, so the card ended mid-result with no way to say so.
	 * Crossing the breakpoint in either direction hands the height back to the stylesheet.
	 */
	useEffect(() => {
		const query = globalThis.matchMedia(DRAWER_LAYOUT)
		const onChange = () => setSheetHeight(null)

		query.addEventListener("change", onChange)

		return () => query.removeEventListener("change", onChange)
	}, [])

	/*
	 * touching the MAP puts the drawer down. A phone shows the map through whatever the drawer leaves,
	 * so the first thing a visitor does after reading a result is pan to see where it is — and a
	 * drawer that stays at its detent through that gesture is answering a question nobody asked twice.
	 *
	 * It shrinks rather than closes: the result is still there, one pull away.
	 * Only a gesture counts — a programmatic camera move carries no `originalEvent`,
	 * and the fly-to that answers a query is exactly such a move, so reacting to
	 * those would put a result away at the moment it arrived.
	 */
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

	/*
	 * Escape dismisses the result, matching `MapSheet`.
	 *
	 * Only while nothing is over it. `MapSheet` binds the same key for its own sheet
	 * and both listeners are on the document, so Escape over an open About or Layers
	 * panel closed that panel and threw away the result behind it — one keystroke,
	 * two dismissals, the second of them invisible until the panel came away.
	 */
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
	// The bundle load no longer opens the result sheet: it reports on the bar at the top of the viewport
	// and in the footer, so an empty sheet does not sit over the map for the length of a 38 MB download.
	const showSheet = Boolean(busy || result || errorMessage) && !resultDismissed

	/*
	 * The drawer stands over the map, as opposed to resting at the bottom of it.
	 * Shrunk to its smallest detent it is a search field with a map behind it, and the map's
	 * own controls belong back on screen at that point — which is the state a pan leaves it in.
	 */
	const drawerRaised =
		showSheet &&
		(sheetHeight === null || (globalThis.window !== undefined && sheetHeight > sheetDetents().collapsedBelow))

	const bundleLoading = Boolean(loading && !runtime.ready)
	const steps = loading?.stepLabels.length ?? 0

	// The model downloads before the first step is entered, so the step fraction holds at 1/steps
	// for the whole of a 38 MB transfer — the part of the wait a visitor actually sits through.
	// While bytes are arriving the bar follows them, scaled into the first step's share
	// so it never runs backwards when the steps take over.
	const stepFraction = steps ? ((loading?.stepIndex ?? 0) + 1) / steps : null
	const byteFraction = loading?.byteFraction

	const fraction =
		typeof byteFraction === "number" && steps ? (byteFraction * 1) / steps : (byteFraction ?? stepFraction)

	return (
		<>
			<MapProgressBar active={bundleLoading} fraction={fraction} label="Loading the geocoder" />

			{/*
			 * One surface owns the search, the examples and the result — the arrangement
			 * the reference map apps use. They used to be two: a floating pill at the top
			 * and a separate bottom sheet, which is what put the search field in the
			 * same row as the control rail (the rail won, and covered its right end)
			 * and left a phone with a result sheet it could not get back from.
			 *
			 * Desktop: a column down the left, sized to its content, over a full-bleed map.
			 * Phone: a bottom drawer with detents, the search riding at its top.
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
				{/*
				 * the header stays. The grab bar and the search field are one sticky block,
				 * so scrolling a long result never takes the field with it — the thing a visitor reaches
				 * for next is the thing that scrolled away. It is opaque because the panel's
				 * own material is glass, and text read through a pinned header.
				 */}
				<div className="mw-map-panel__header" onPointerDown={onHeaderPointerDown}>
					<div className="mw-map-panel__grip">
						{/*
						 * The handle appears only with a result. With the drawer holding a search field
						 * and a row of examples there is nothing behind it to pull into view,
						 * and a handle offered over nothing either expands a band of empty glass
						 * or reads as broken — the same fault as the decorative handle it replaced.
						 */}
						{showSheet ? (
							<button
								type="button"
								className="mw-map-sheet__handle"
								aria-label="Resize the panel"
								aria-expanded={atLargeDetent()}
								// The pointer gesture belongs to the header, which is the whole grab target.
								// This is the keyboard's way in: `detail === 0` is a click with no pointer
								// behind it, so a drag that ends on the pill does not also toggle a detent.
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
						{/*
						 * `type="search"` brings its own clear button, so the pill carries no trailing slot:
						 * a second cross beside the native one is two controls for one job, and the
						 * spinner that used to live there changed the field's height on every submit.
						 */}
						<MapSearchBar label="Search addresses" leading={<SearchGlyph />} busy={busy}>
							<input
								id="mw-pipeline-input"
								type="search"
								aria-label="Address"
								value={geocode.text}
								onChange={(event) => geocode.setText(event.target.value)}
								// The field ships pre-filled with the demo address, so the first click used
								// to drop a caret in the middle of it and the visitor typed into someone
								// else's address. Select the seed on focus so one keystroke replaces it —
								// and only while it is the untouched seed, so this never eats real work.
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
			 * Every floating control lives in this one column, so nothing can land on top
			 * of anything else: the layer control joins the capsule rather than sitting in
			 * the left column, and the compass takes its own capsule below because it comes
			 * and goes and would otherwise resize the one above it.
			 */}
			{/*
			 * The rail steps aside for the drawer on a phone. It is pinned to the corner the
			 * drawer's tall detent reaches, and a control stranded above an open result is one a
			 * thumb cannot get to anyway. It comes back with the map, when the result is put away.
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
