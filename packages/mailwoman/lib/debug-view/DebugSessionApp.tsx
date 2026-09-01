/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The interactive half of `mailwoman geocode --debug`: one component owning the whole session — the warm
 *   {@link createGeocodeSession}, the PMTiles handle behind the map pane, and focus/pan/zoom/scroll state.
 *   {@link DebugFrame} stays pure; everything below is the shell that feeds it.
 *
 *   THE ALTERNATE SCREEN IS NOT THIS COMPONENT'S. `command.tsx` renders it through an Ink instance configured with
 *   `alternateScreen: true`, and Ink enters before its first frame and leaves from `unmount()` — which its
 *   `signal-exit` subscription reaches on a signal death too. The buffer is what makes the full-height frame safe at
 *   all: Ink emits `\x1b[2J\x1b[3J\x1b[H` for a frame as tall as the terminal, and `3J` wipes the SCROLLBACK (the
 *   #1577 damage `geocode.tsx`'s one-shot path exists to avoid). On the alternate screen that clear costs nothing —
 *   the buffer has no scrollback of its own, and leaving it restores the primary buffer untouched. So this component
 *   may render a full-height frame from its FIRST frame; there is no primary buffer underneath to protect.
 *
 *   FATAL is reachable only from the loading phase — a failed format guard, an empty query, or a session that could
 *   not open (missing weights/gazetteer, whose {@link CommandError} messages ARE the CLI's error contract). It is
 *   reported by exiting the app WITH the error rather than by rendering it: Ink treats alternate-screen teardown
 *   output as disposable, so a message painted here would be erased by the buffer switch on the way out. `command.tsx`
 *   writes it to stderr once the primary buffer is back. Failures after the first result are NOT fatal — a rejected
 *   re-run reports in the output pane and keeps the previous result, and a map render that throws degrades that pane
 *   to a note.
 */

import { $public } from "@mailwoman/core/env"
import { clamp } from "@mailwoman/core/numeric"
import { lonLatToWorldPx, MapRenderer, TileSource, worldPxToLonLat, type MapFrame } from "@mailwoman/map-tui"
import { Text, useApp, useInput, useStdout, type Key } from "ink"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { CommandError } from "#cli-kit"
import { outputLines } from "#debug-view/output-lines"
import { QueryInput, type InputState } from "#debug-view/QueryInput"
import { resolveTilesPath } from "#debug-view/tiles"
import { assertDebugFormatSanity, debugSizeFloorViolation, initialZoomForTier } from "#debug-view/view-policy"
import type { GeocodeCommandOptions } from "#geocode/command-options"
import type { GeocodeResult } from "#geocode/result"
import { createGeocodeSession, type GeocodeRun, type GeocodeSession } from "#geocode/session"

import { DebugFrame, mapPaneCellSize, outputPaneCapacity, type DebugData, type DebugPane } from "./DebugFrame.tsx"

//#region Contract

export interface DebugSessionAppProps {
	/**
	 * The address the command was invoked with — geocoded once at mount, and the input row's starting text.
	 */
	initialInput: string
	options: GeocodeCommandOptions
}

/**
 * `loading` covers session open + the first geocode; `busy` is a re-run with a result already on screen (the panes stay
 * live, the output title gains an ellipsis); `fatal` is terminal and reachable only from `loading` (see the header).
 */
type SessionPhase = "loading" | "ready" | "busy" | "fatal"

/**
 * What the map pane is looking at. Null state means "follow the result" — {@link resultViewport} re-derives it from the
 * geocode, which is what makes a fresh query re-center without the user pressing anything.
 */
interface Viewport {
	centerLon: number
	centerLat: number
	zoom: number
}

/**
 * The session's long-lived handles. `renderer` is null when there is no usable tile archive; `mapNote` says why, and is
 * what the map pane shows in its place.
 */
interface Resources {
	session: GeocodeSession
	source: TileSource | null
	renderer: MapRenderer | null
	mapNote: string | null
}

/**
 * One geocode, plus the query text that produced it — `result.input` is the geocoder's own echo, but the input row
 * renders what the user typed.
 */
interface SessionRun extends GeocodeRun {
	input: string
}

//#endregion

//#region Constants

const PANE_CYCLE: readonly DebugPane[] = ["input", "output", "map"]

const NO_TILES_NOTE = "no tiles: set $MAILWOMAN_TILES or --tiles"
const UNRESOLVED_NOTE = "unresolved: no coordinate"

/**
 * One arrow keypress, in map-tui device pixels. The renderer's grid is 2 device pixels per braille cell across and 4
 * down, so a single step of 12 moves the view 6 cells horizontally and 3 cells vertically — visibly a nudge on both
 * axes rather than a screenful, and the same physical distance either way.
 */
const PAN_STEP_PIXELS = 12

/**
 * Web-Mercator's latitude cutoff. Panning past it is not a clipped view, it is a division by zero:
 * `lonLatToWorldPx(±90)` takes `log((1 + sin φ) / (1 - sin φ))` and returns a non-finite world pixel, which the next
 * viewport carries into the renderer. Clamping the CENTER is what keeps a held arrow key from walking off the map.
 */
const MAX_MERCATOR_LATITUDE = 85.05112878

/**
 * The zoom ceiling used when no tile archive is open — the map pane is a note in that state, so the bound only has to
 * keep the stored viewport sane.
 */
const FALLBACK_MAX_ZOOM = 22

//#endregion

//#region Viewport math

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
 * Shift the center by device pixels AT THE CURRENT ZOOM, so a keypress moves the same number of cells whatever the
 * scale — the round trip through world pixels is what converts "6 cells right" into the degrees that means here.
 */
function pannedViewport(view: Viewport, dx: number, dy: number): Viewport {
	const world = lonLatToWorldPx(view.centerLon, view.centerLat, view.zoom)
	const moved = worldPxToLonLat(world.x + dx, world.y + dy, view.zoom)

	return clampViewport({ centerLon: moved.lon, centerLat: moved.lat, zoom: view.zoom })
}

/**
 * Zoom by whole steps, clamped to the archive's own range. Whole steps keep the stored zoom equal to the one
 * `MapRenderer` renders at (it rounds and clamps internally), so the pan math above and the pixels on screen agree.
 */
function zoomedViewport(view: Viewport, delta: number, source: TileSource | null): Viewport {
	return {
		...view,
		zoom: clamp(view.zoom + delta, source?.minZoom ?? 0, source?.maxZoom ?? FALLBACK_MAX_ZOOM),
	}
}

//#endregion

//#region Session

/**
 * Open the session, the tile archive, and geocode the starting query. Tile trouble degrades (the pane becomes a note);
 * anything else throws, and the caller turns it into the fatal phase.
 */
async function openResources(options: GeocodeCommandOptions): Promise<Resources> {
	// `trace: true` is the debug view's own opt-in — it buys the evidence rows one extra decode per input, which
	// no other caller of the session should pay for.
	const session = await createGeocodeSession({ ...options, trace: true })
	const tilesPath = await resolveTilesPath(options.tiles)

	if (!tilesPath) return { session, source: null, renderer: null, mapNote: NO_TILES_NOTE }

	try {
		const source = await TileSource.open(tilesPath)

		return { session, source, renderer: new MapRenderer(source), mapNote: null }
	} catch (error) {
		// A corrupt or unreadable archive costs the map pane, not the session — the parse and the resolution are
		// still the answer the user came for.
		return { session, source: null, renderer: null, mapNote: `tiles unavailable: ${messageOf(error)}` }
	}
}

function closeResources(resources: Resources | null): void {
	if (!resources) return

	resources.session[Symbol.dispose]()

	void resources.source?.[Symbol.asyncDispose]().catch(() => {
		// Teardown is best-effort. This runs after the terminal has already been restored and while the process is
		// on its way out, so a rejected close has nobody left to tell — and an unhandled rejection would take the
		// exit code with it.
	})
}

//#endregion

/* oxlint-disable react-hooks/exhaustive-deps -- The mount effect is one-shot BY CONTRACT: it opens the
	 session, the tile archive and the first geocode, and its cleanup is the only thing that closes them.
	 Tracking `options`/`initialInput` would re-open every handle on any identity change — a fresh options
	 object per render is enough. The empty deps array is the point, same as `useCommandTask`. */

export function DebugSessionApp({ initialInput, options }: DebugSessionAppProps): React.ReactElement | null {
	const { exit } = useApp()
	const { stdout } = useStdout()

	const [size, setSize] = useState(() => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 }))
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

	// Monotonic request IDs. Every async completion below compares its own ID against the ref before touching
	// state, so a slow frame or a slow geocode that lands after a newer one was started is DISCARDED rather than
	// overwriting it — the classic out-of-order-render artifact when a held arrow key outruns tile IO.
	const frameRequestRef = useRef(0)
	const runRequestRef = useRef(0)

	//#region Lifecycle — mount, resize, fatal exit

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

			// Symmetric with the frame effect's cleanup: an in-flight geocode that settles after teardown finds a
			// counter it can no longer match and drops its result instead of setting state on a closed session.
			runRequestRef.current++

			closeResources(opened)
		}
	}, [])

	useEffect(() => {
		const onResize = (): void => {
			setSize((prior) => {
				const columns = stdout.columns || prior.columns
				const rows = stdout.rows || prior.rows

				// Same dimensions ⇒ same object, so a resize event that changed nothing costs no re-render and no
				// re-rendered map frame.
				return columns === prior.columns && rows === prior.rows ? prior : { columns, rows }
			})
		}

		stdout.on("resize", onResize)

		return () => {
			stdout.off("resize", onResize)
		}
	}, [stdout])

	// Exiting WITH the error rather than rendering it — see the header. Ink unmounts, restores the primary buffer,
	// and rejects `waitUntilExit()`, which is where `command.tsx` prints the message.
	useEffect(() => {
		if (phase !== "fatal") return

		exit(fatalError instanceof Error ? fatalError : new CommandError(messageOf(fatalError)))
	}, [phase, fatalError, exit])

	//#endregion

	//#region Map frame — the request-counter-guarded render

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
			// A live terminal below the floor is the user's to fix by resizing — `mapPaneCellSize`'s row math is
			// already non-positive here, and handing that to `MapRenderer` is the raw `RangeError` the static path's
			// flag check exists to prevent.
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
			// Invalidates whatever is in flight — including on unmount, where the archive is about to close.
			frameRequestRef.current++
		}
	}, [run, viewport, resources, size.columns, size.rows])

	//#endregion

	//#region Input + keys

	// Stable across a keystroke so the memoized input field is, too — it is the ONE element that has to re-render
	// when the user types, and a fresh handler identity would drag the whole frame with it.
	const submit = useCallback(
		(value: string): void => {
			const query = value.trim()

			if (!resources || phase === "busy" || !query) return

			setPhase("busy")
			// The previous attempt's failure is stale the moment a new one starts — leaving it up through the busy
			// window reads as if THIS query had already failed.
			setErrorNote(null)

			const requestID = ++runRequestRef.current

			void resources.session.geocode(query).then(
				(reran) => {
					if (requestID !== runRequestRef.current) return

					setRun({ input: query, ...reran })
					// A new result re-centers the map and re-anchors the output pane; a pan the user made against the
					// PREVIOUS answer would otherwise leave the marker off screen.
					setViewport(null)
					setScrollOffset(0)
					setPhase("ready")
				},
				(error: unknown) => {
					if (requestID !== runRequestRef.current) return

					// The previous result stays on screen — a failed re-run is a message, not a reset.
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

		// Only the DOWN arrow needs the bound, so only it pays for the list. Clamped against the pane's OWN lines
		// and window — the same builder and capacity function `DebugFrame` renders with, so the scroll can never run
		// past what the pane shows, and the last page stays full instead of scrolling into empty rows.
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
			// Esc quits from anywhere, including the input field — `ink-text-input` ignores it, so there is no
			// keystroke both handlers want.
			if (key.escape) {
				exit()

				return
			}

			if (key.tab) {
				setFocused((prior) => PANE_CYCLE[(PANE_CYCLE.indexOf(prior) + 1) % PANE_CYCLE.length]!)

				return
			}

			// `q` is a quit key everywhere EXCEPT the input field, where it is a letter someone is typing.
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

	//#endregion

	//#region Render

	// Memoized because `DebugFrame`'s panes are memoized: a fresh object literal per render would defeat every one of
	// them, and the map pane is the expensive one — 28 rows of truecolor braille whose longest line is ~1 kB of SGR,
	// re-measured by `string-width` and re-tokenized by `ansi-tokenize` on any prop identity change. Typing in the
	// input row changes none of these values.
	//
	// The scroll offset is deliberately NOT in here: it rides its own prop into the output pane, so scrolling leaves
	// `data` identical and the map frame effect (which depends on `run`) never re-runs on an arrow key.
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

	//#endregion
}

/* oxlint-enable react-hooks/exhaustive-deps */
