/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `--debug` branch of `mailwoman geocode`. Two paths share one geocode:
 *
 *   - A piped/non-TTY invocation renders exactly ONE {@link DebugFrame} (the input row + the resolved output +
 *     a rendered map pane) through {@link renderInkToString} and writes it out with `writeRawStdout` — the same
 *     #1577 posture as `geocode.tsx`'s one-shot JSON/text/jsonld path: nothing on the success path renders
 *     through Ink's live reconciler, so there is no frame for Ink to clear and no frame tall enough to wipe the
 *     scrollback.
 *   - A TTY invocation gets the interactive three-panel session, {@link DebugSessionApp}, rendered through an Ink
 *     instance THIS MODULE creates — see {@link DebugSessionHandoff}.
 *
 *   {@linkcode GeocodeDebugCommand} is itself a hook-free dispatcher between the two, the same shape
 *   `geocode.tsx`'s top-level `GeocodeCommand` uses to choose between this module and its own one-shot path.
 *   Branching on `process.stdout.isTTY` INSIDE a component that also calls `useCommandTask` would make that
 *   hook call conditional — forbidden by the rules of hooks even though `isTTY` never changes mid-process, because
 *   a static analyzer has no way to know that. Splitting the static and interactive halves into their own
 *   components (`GeocodeDebugStatic` / {@link DebugSessionHandoff}) keeps each one's own hook usage unconditional.
 *
 *   The decisions both surfaces have to agree on — the opening zoom, the `--format` guard, the map-pane size floor —
 *   live in `view-policy.ts` rather than here. This module imports the session, so the session cannot import back out
 *   of it (`import/no-cycle`), and a second copy of a guard is a second place for it to drift.
 */

import { $public } from "@mailwoman/core/env"
import { type MapFrame, MapRenderer, TileSource } from "@mailwoman/map-tui"
import { render, Text, useApp } from "ink"
import { CommandError, useCommandTask, writeRawStdout } from "mailwoman/cli-kit"
import React, { useEffect } from "react"

import type { GeocodeCommandOptions } from "../geocode-command-options.ts"
import { createGeocodeSession } from "../geocode-session.ts"
import { DebugFrame, mapPaneCellSize } from "./DebugFrame.tsx"
import { DebugSessionApp } from "./DebugSessionApp.tsx"
import { renderInkToString } from "./static-render.ts"
import { resolveTilesPath } from "./tiles.ts"
import { assertDebugFormatSanity, assertDebugSizeFloor, initialZoomForTier } from "./view-policy.ts"

//#region Static (non-TTY) path

/**
 * Geocode `input` once and render exactly one {@link DebugFrame} to a string — the whole non-TTY `--debug` answer. The
 * tile archive is opened independently of the geocode session (the session owns the gazetteer/shard handles; the
 * archive is a debug-view-only concern) and both are released in `finally`, so a mid-render throw — a corrupt tiles
 * archive, say — still closes every handle.
 *
 * Exported for `static.test.ts` only — not part of this module's consumer-facing surface (`GeocodeDebugCommand`); no
 * caller outside this directory should import it.
 */
export async function runStaticDebug(input: string, options: GeocodeCommandOptions): Promise<string> {
	if (!input.trim().length) {
		throw new CommandError(
			'geocode requires a positional address argument  (e.g. mailwoman geocode "350 5th Ave, New York, NY")'
		)
	}

	assertDebugFormatSanity(options)

	const [columns, rows] = options.debugSize.split("x").map(Number) as [number, number]

	assertDebugSizeFloor(columns, rows)

	// Same opt-in the interactive session makes: the captured frame carries the evidence rows, so it has to pay
	// for the trace too.
	const session = await createGeocodeSession({ ...options, trace: true })

	try {
		const { result, tree, trace, timing } = await session.geocode(input)
		const tilesPath = resolveTilesPath(options.tiles)
		let frame: MapFrame | null = null
		let mapNote: string | null = null

		if (result.lat == null || result.lon == null) {
			mapNote = "unresolved: no coordinate"
		} else if (tilesPath == null) {
			mapNote = "no tiles: set $MAILWOMAN_TILES or --tiles"
		} else {
			const source = await TileSource.open(tilesPath)

			try {
				const pane = mapPaneCellSize(columns, rows)
				const renderer = new MapRenderer(source)

				frame = await renderer.renderFrame(
					{
						centerLon: result.lon,
						centerLat: result.lat,
						zoom: initialZoomForTier(result),
						columns: pane.columns,
						rows: pane.rows,
					},
					{
						markers: [{ lon: result.lon, lat: result.lat }],
						...(result.uncertainty_m != null
							? { ring: { lon: result.lon, lat: result.lat, radiusMeters: result.uncertainty_m } }
							: {}),
					}
				)
			} finally {
				await source.close()
			}
		}

		return renderInkToString(
			<DebugFrame
				columns={columns}
				rows={rows}
				focused={null}
				color={!$public.NO_COLOR}
				data={{ input, tree, result, frame, mapNote, ...(trace ? { trace } : {}), timing }}
			/>,
			columns
		)
	} finally {
		session.close()
	}
}

/**
 * The non-TTY half of `--debug`: one captured frame, written raw. Same #1577 posture as `geocode.tsx`'s one-shot path —
 * running renders `null` (height 0, nothing for Ink to clear or overflow), and the finished frame bypasses `<Text>`
 * entirely so it can't be re-wrapped at the piped 80-column default.
 */
function GeocodeDebugStatic(props: { input: string; options: GeocodeCommandOptions }): React.ReactElement | null {
	const state = useCommandTask(() => runStaticDebug(props.input, props.options))

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	if (state.status !== "done") {
		return null
	}

	return writeRawStdout(state.result)
}

//#endregion

//#region Interactive (TTY) path — the Ink handoff

/**
 * Hand the terminal from the command adapter's Ink instance to a full-screen renderer configured here.
 *
 * The command adapter renders with Ink's defaults, which are wrong for a full-screen view redrawn on every keystroke.
 * With `incrementalRendering` off, Ink rewrites the whole frame per commit: **7.10 KB down the tty per keystroke at
 * 120×36, against 0.33 KB with it on**, all of it truecolor braille that the emulator (and, over SSH, the wire) has to
 * chew through. And Ink has no alternate-screen buffer unless it is asked for one, which is what forced the hand-rolled
 * escapes this component's callee used to carry — a frame exactly as tall as the terminal makes Ink emit `\x1b[3J`, and
 * that wipes the user's SCROLLBACK (#1577).
 *
 * Ink keeps ONE renderer per stdout (`ink/render.js`'s `getInstance`) and warns, then reuses the old one, if a second
 * `render()` arrives for the same stream. So the handoff is an unmount-then-render, not a second mount: `exit()`
 * unmounts the command tree synchronously through to `instances.delete(stdout)`, which frees the slot. It runs from a
 * `setImmediate` rather than from the effect body because `exit()` unmounts the tree this effect belongs to, and React
 * should not be asked to do that from inside its own commit.
 *
 * The command tree renders `null` throughout — height 0, so the primary buffer is never written to and there is nothing
 * left in the scrollback once the session exits.
 */
/* oxlint-disable react-hooks/exhaustive-deps -- One-shot by contract, like `useCommandTask`: the handoff happens
	 once at mount, and a fresh `options` object per render must not repeat it. The empty deps array is the point. */

function DebugSessionHandoff(props: { input: string; options: GeocodeCommandOptions }): React.ReactElement | null {
	const { exit } = useApp()

	useEffect(() => {
		let handed = false

		const handoff = setImmediate(() => {
			handed = true
			exit()

			const session = render(<DebugSessionApp initialInput={props.input} options={props.options} />, {
				// `alternateScreen` also retires the hand-rolled enter/leave escapes:
				// Ink enters before its first frame and leaves from `unmount()`, which its `signal-exit`
				// subscription reaches on a signal death too.
				alternateScreen: true,
				incrementalRendering: true,
				// Nothing in the session logs through `console`; leaving the native methods alone keeps the
				// resolver's own stderr banner out of Ink's re-render path.
				patchConsole: false,
			})

			// Ink's own Ctrl+C handling unmounts the app, so this settles on every exit path — Esc, `q`, Ctrl+C,
			// a fatal. `waitUntilExit` resolves after the teardown writes have flushed, so the primary buffer is
			// back before either branch writes: the session reports a fatal by exiting WITH the error (Ink discards
			// alternate-screen teardown output, so a message rendered inside the session would not survive the
			// switch), and stderr here is where it lands.
			void session.waitUntilExit().then(
				() => process.exit(process.exitCode ?? 0),
				(error: unknown) => {
					process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
					process.exit(1)
				}
			)
		})

		return () => {
			if (!handed) {
				clearImmediate(handoff)
			}
		}
	}, [])

	return null
}

/* oxlint-enable react-hooks/exhaustive-deps */

//#endregion

//#region Dispatcher

export function GeocodeDebugCommand(props: {
	input: string
	options: GeocodeCommandOptions
}): React.ReactElement | null {
	return process.stdout.isTTY ? (
		<DebugSessionHandoff input={props.input} options={props.options} />
	) : (
		<GeocodeDebugStatic input={props.input} options={props.options} />
	)
}

//#endregion
