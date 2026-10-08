/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { GeocodeResult } from "@mailwoman/core/geocode"
import { clamp } from "@mailwoman/core/numeric"
import { CommandError } from "@mailwoman/core/scripting/command"
import { lonLatToWorldPx, MapRenderer, TileSource, worldPxToLonLat, type MapFrame } from "@mailwoman/map-tui"
import { Text, useApp, useInput, useWindowSize, type Key } from "ink"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { outputLines } from "#cli/debug-view/output-lines"
import { QueryInput, type InputState } from "#cli/debug-view/QueryInput"
import { resolveTilesPath } from "#cli/debug-view/tiles"
import { assertDebugFormatSanity, debugSizeFloorViolation, initialZoomForTier } from "#cli/debug-view/view-policy"
import { $public } from "#env"
import type { GeocodeCommandOptions } from "#geocode/command-options"
import { createGeocodeSession, type GeocodeRun, type GeocodeSession } from "#geocode/session"

import { DebugFrame, mapPaneCellSize, outputPaneCapacity, type DebugData, type DebugPane } from "./DebugFrame.tsx"

export interface DebugSessionAppProps {
	/**
	 * The address the command was invoked with, geocoded once at mount
	 * and used as the input row's starting text.
	 */
	initialInput: string
	options: GeocodeCommandOptions
}

/**
 * `loading` covers session open and the first geocode; `busy` is a re-run with a result
 * already on screen; `fatal` is terminal and reachable only from `loading`.
 */
type SessionPhase = "loading" | "ready" | "busy" | "fatal"

/**
 * What the map pane is looking at.
 *
 * A null viewport follows the result, re-derived by {@link resultViewport} so a fresh query re-centers.
 */
interface Viewport {
	centerLon: number
	centerLat: number
	zoom: number
}

/**
 * The session's long-lived handles.
 *
 * `renderer` is null when no usable tile archive exists.
 * `mapNote` is what the map pane shows in its place.
 */
interface Resources {
	session: GeocodeSession
	source: TileSource | null
	renderer: MapRenderer | null
	mapNote: string | null
}

/**
 * One geocode plus the query text that produced it.
 *
 * The input row renders `input`, not the geocoder's own `result.input` echo.
 */
interface SessionRun extends GeocodeRun {
	input: string
}

const PANE_CYCLE: readonly DebugPane[] = ["input", "output", "map"]

const NO_TILES_NOTE = "no tiles: set $MAILWOMAN_TILES or --tiles"
const UNRESOLVED_NOTE = "unresolved: no coordinate"

/**
 * One arrow keypress in map-tui device pixels.
 *
 * The renderer's grid is 2 device pixels per braille cell across and 4 down.
 */
const PAN_STEP_PIXELS = 12

/**
 * Web-Mercator's latitude cutoff.
 *
 * A pan beyond it produces a non-finite world pixel, so the code clamps the center.
 */
const MAX_MERCATOR_LATITUDE = 85.05112878

/**
 * The zoom ceiling used when no tile archive is open.
 * The bound only has to keep the stored viewport sane.
 */
const FALLBACK_MAX_ZOOM = 22

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * The viewport a result opens on, or null when the resolve produced no coordinate.
 */
function resultViewport(result: GeocodeResult): Viewport | null {
	if (result.lat == null || result.lon == null) return null

	return { centerLon: result.lon, centerLat: result.lat, zoom: initialZoomForTier(result) }
}

function clampViewport(view: Viewport): Viewport {
	return {
		centerLon: clamp(view.centerLon, -180, 180),
		centerLat: clamp(view.centerLat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE),
		zoom: view.zoom,
	}
}

/**
 * Shift the center by device pixels at the current zoom, so a keypress moves
 * the same number of cells whatever the scale.
 */
function pannedViewport(view: Viewport, dx: number, dy: number): Viewport {
	const world = lonLatToWorldPx(view.centerLon, view.centerLat, view.zoom)
	const moved = worldPxToLonLat(world.x + dx, world.y + dy, view.zoom)

	return clampViewport({ centerLon: moved.lon, centerLat: moved.lat, zoom: view.zoom })
}

/**
 * Zoom by whole steps, clamped to the archive's own range so the stored zoom
 * matches the one `MapRenderer` renders at.
 */
function zoomedViewport(view: Viewport, delta: number, source: TileSource | null): Viewport {
	return {
		...view,
		zoom: clamp(view.zoom + delta, source?.minZoom ?? 0, source?.maxZoom ?? FALLBACK_MAX_ZOOM),
	}
}

/**
 * Open the session and tile archive and geocode the starting query.
 * Tile trouble degrades to a note while anything else throws.
 */
async function openResources(options: GeocodeCommandOptions): Promise<Resources> {
	// `trace: true` is the debug view's own opt-in.
	// It costs one extra decode per input that no other caller of the session should pay for.
	const session = await createGeocodeSession({ ...options, trace: true })
	const tilesPath = await resolveTilesPath(options.tiles)

	if (!tilesPath) return { session, source: null, renderer: null, mapNote: NO_TILES_NOTE }

	try {
		const source = await TileSource.open(tilesPath)

		return { session, source, renderer: new MapRenderer(source), mapNote: null }
	} catch (error) {
		// A corrupt or unreadable archive makes the map pane unavailable.
		// The session still provides the parse and resolution the user came for.
		return { session, source: null, renderer: null, mapNote: `tiles unavailable: ${messageOf(error)}` }
	}
}

function closeResources(resources: Resources | null): void {
	if (!resources) return

	resources.session[Symbol.dispose]()

	void resources.source?.[Symbol.asyncDispose]().catch(() => {
		// Teardown is best-effort: this runs after the terminal is restored and
		// while the process exits, so no caller remains to receive a close error.
	})
}

/* oxlint-disable react-hooks/exhaustive-deps -- The mount effect runs once by interface. It opens the
	 session, the tile archive and the first geocode. Its cleanup is the only code that closes them.
	 A dependency on `options`/`initialInput` would re-open every handle on any identity change. A fresh options object
	 per render is enough. The empty deps array is the point, same as `useCommandTask`. */

export function DebugSessionApp({ initialInput, options }: DebugSessionAppProps): React.ReactElement | null {
	const { exit } = useApp()
	const size = useWindowSize()
	const [phase, setPhase] = useState<SessionPhase>("loading")
	const [fatalError, setFatalError] = useState<unknown>(null)
	const [resources, setResources] = useState<Resources | null>(null)
	const [run, setRun] = useState<SessionRun | null>(null)
	const [frame, setFrame] = useState<MapFrame | null>(null)
	const [mapNote, setMapNote] = useState<string | null>(null)
	const [errorNote, setErrorNote] = useState<string | null>(null)
	const [focused, setFocused] = useState<DebugPane>("input")
	const [field, setField] = useState<InputState>(() => ({ value: initialInput, cursor: initialInput.length }))
	const [viewport, setViewport] = useState<Viewport | null>(null)
	const [scrollOffset, setScrollOffset] = useState(0)

	// Monotonic request IDs: every async completion below discards its result
	// when a newer request has started.
	const frameRequestRef = useRef(0)
	const runRequestRef = useRef(0)

	useEffect(() => {
		let disposed = false
		let opened: Resources | null = null

		const fail = (error: unknown): void => {
			setFatalError(error)
			setPhase("fatal")
		}

		try {
			assertDebugFormatSanity(options)

			if (!initialInput) {
				throw new CommandError('--debug needs an address to start from: mailwoman geocode "<address>" --debug')
			}
		} catch (error) {
			fail(error)

			return
		}

		void (async () => {
			try {
				opened = await openResources(options)

				if (disposed) {
					closeResources(opened)

					return
				}

				const first = await opened.session.geocode(initialInput)

				if (disposed) return

				setResources(opened)
				setRun({ input: initialInput, ...first })
				setPhase("ready")
			} catch (error) {
				if (disposed) return

				fail(error)
			}
		})()

		return () => {
			disposed = true

			// Symmetric with the frame effect's cleanup: an in-flight geocode that settles
			// after teardown finds a counter it can no longer match.
			runRequestRef.current++

			closeResources(opened)
		}
	}, [])

	// The effect passes the error through `waitUntilExit()` rather than rendering it: Ink restores
	// the primary buffer and rejects `waitUntilExit()`, where `command.tsx` prints the message.
	useEffect(() => {
		if (phase !== "fatal") return

		exit(fatalError instanceof Error ? fatalError : new CommandError(messageOf(fatalError)))
	}, [phase, fatalError, exit])

	useEffect(() => {
		if (!run) return

		const view = viewport ?? resultViewport(run.result)

		if (!view) {
			setFrame(null)
			setMapNote(UNRESOLVED_NOTE)

			return
		}

		if (!resources?.renderer) {
			setFrame(null)
			setMapNote(resources?.mapNote ?? NO_TILES_NOTE)

			return
		}

		const violation = debugSizeFloorViolation(size.columns, size.rows)

		if (violation) {
			// A live terminal below the floor is the user's to fix by resizing; `mapPaneCellSize`'s
			// row math is already non-positive here and would reach `MapRenderer` as a `RangeError`.
			setFrame(null)
			setMapNote(`terminal ${violation}`)

			return
		}

		const pane = mapPaneCellSize(size.columns, size.rows)
		const requestID = ++frameRequestRef.current
		const { result } = run
		const marked = result.lat != null && result.lon != null

		void resources.renderer
			.renderFrame(
				{ ...view, columns: pane.columns, rows: pane.rows },
				{
					...(marked ? { markers: [{ lon: result.lon!, lat: result.lat! }] } : {}),
					...(marked && result.uncertainty_m != null
						? { ring: { lon: result.lon!, lat: result.lat!, radiusMeters: result.uncertainty_m } }
						: {}),
				}
			)
			.then(
				(rendered) => {
					if (requestID !== frameRequestRef.current) return

					setFrame(rendered)
					setMapNote(null)
				},
				(error: unknown) => {
					if (requestID !== frameRequestRef.current) return

					setFrame(null)
					setMapNote(`map render failed: ${messageOf(error)}`)
				}
			)

		return () => {
			// Invalidates whatever is in flight, including on unmount, where the archive is about to close.
			frameRequestRef.current++
		}
	}, [run, viewport, resources, size.columns, size.rows])

	// Stable across a keystroke so the memoized input field is too.
	// A fresh handler identity would drag the whole frame with it.
	const submit = useCallback(
		(value: string): void => {
			const query = value.trim()

			if (!resources || phase === "busy" || !query) return

			setPhase("busy")
			// The previous attempt's failure is stale the moment a new one starts. leaving it
			// up through the busy window reads as if this query had already failed.
			setErrorNote(null)

			const requestID = ++runRequestRef.current

			void resources.session.geocode(query).then(
				(reran) => {
					if (requestID !== runRequestRef.current) return

					setRun({ input: query, ...reran })
					// A new result re-centers the map and re-anchors the output pane,
					// so a pan against the previous answer cannot leave the marker off screen.
					setViewport(null)
					setScrollOffset(0)
					setPhase("ready")
				},
				(error: unknown) => {
					if (requestID !== runRequestRef.current) return

					// The previous result stays on screen.
					// A failed re-run is a message rather than a reset.
					setErrorNote(messageOf(error))
					setPhase("ready")
				}
			)
		},
		[resources, phase]
	)

	const nudge = (mutate: (view: Viewport) => Viewport): void => {
		if (!run) return

		const base = viewport ?? resultViewport(run.result)

		if (!base) return

		setViewport(mutate(base))
	}

	const onMapKey = (input: string, key: Key): void => {
		if (key.leftArrow) {
			nudge((view) => pannedViewport(view, -PAN_STEP_PIXELS, 0))
		} else if (key.rightArrow) {
			nudge((view) => pannedViewport(view, PAN_STEP_PIXELS, 0))
		} else if (key.upArrow) {
			nudge((view) => pannedViewport(view, 0, -PAN_STEP_PIXELS))
		} else if (key.downArrow) {
			nudge((view) => pannedViewport(view, 0, PAN_STEP_PIXELS))
		} else if (input === "+" || input === "=") {
			nudge((view) => zoomedViewport(view, 1, resources?.source ?? null))
		} else if (input === "-") {
			nudge((view) => zoomedViewport(view, -1, resources?.source ?? null))
		} else if (input === "0") {
			// Drop the override — the pane goes back to following the result.
			setViewport(null)
		}
	}

	const onOutputKey = (key: Key): void => {
		if (key.upArrow) {
			setScrollOffset((prior) => Math.max(0, prior - 1))

			return
		}

		if (!key.downArrow) return

		// Only the down arrow needs the bound, clamped against the pane's own lines
		// and capacity so the scroll cannot run past what the pane shows.
		const lineCount = run
			? outputLines({
					result: run.result,
					tree: run.tree,
					...(run.trace ? { trace: run.trace } : {}),
					timing: run.timing,
					errorNote,
				}).length
			: 0

		const lastOffset = Math.max(0, lineCount - outputPaneCapacity(size.rows))

		setScrollOffset((prior) => Math.min(lastOffset, prior + 1))
	}

	useInput(
		(input, key) => {
			// Esc quits from anywhere; `ink-text-input` ignores it, so no keystroke is claimed twice.
			if (key.escape) {
				exit()

				return
			}

			if (key.tab) {
				setFocused((prior) => PANE_CYCLE[(PANE_CYCLE.indexOf(prior) + 1) % PANE_CYCLE.length]!)

				return
			}

			// `q` is a quit key everywhere except the input field, where it is a letter someone is typing.
			if (input === "q" && focused !== "input") {
				exit()

				return
			}

			if (focused === "map") {
				onMapKey(input, key)
			} else if (focused === "output") {
				onOutputKey(key)
			}
		},
		{ isActive: phase === "ready" || phase === "busy" }
	)

	// Memoized because `DebugFrame`'s panes are memoized.
	// The scroll offset uses its own prop so scrolling leaves `data` identical.
	const data = useMemo<DebugData | null>(
		() =>
			run
				? {
						input: run.input,
						tree: run.tree,
						result: run.result,
						frame,
						mapNote,
						...(run.trace ? { trace: run.trace } : {}),
						timing: run.timing,
					}
				: null,
		[run, frame, mapNote]
	)

	const inputField = useMemo(
		() => (
			<QueryInput
				value={field.value}
				cursor={field.cursor}
				onChange={setField}
				onSubmit={submit}
				focus={focused === "input"}
			/>
		),
		[field, focused, submit]
	)

	if (phase === "fatal") return null

	if (!run || !data) return <Text>loading model…</Text>

	return (
		<DebugFrame
			columns={size.columns}
			rows={size.rows}
			focused={focused}
			busy={phase === "busy"}
			color={!$public.NO_COLOR}
			errorNote={errorNote}
			scrollOffset={scrollOffset}
			data={data}
			inputField={inputField}
		/>
	)
}

/* oxlint-enable react-hooks/exhaustive-deps */
