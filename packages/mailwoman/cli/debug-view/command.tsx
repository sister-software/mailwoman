/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CommandError } from "@mailwoman/core/scripting/command"
import { type MapFrame, MapRenderer, TileSource } from "@mailwoman/map-tui"
import { render, Text, useApp } from "ink"
import React, { useEffect } from "react"

import { useCommandTask, writeRawStdout } from "#cli-kit"
import { renderInkToString } from "#cli/debug-view/static-render"
import { resolveTilesPath } from "#cli/debug-view/tiles"
import { assertDebugFormatSanity, assertDebugSizeFloor, initialZoomForTier } from "#cli/debug-view/view-policy"
import { $public } from "#env"
import type { GeocodeCommandOptions } from "#geocode/command-options"
import { createGeocodeSession } from "#geocode/session"

import { DebugFrame, mapPaneCellSize } from "./DebugFrame.tsx"
import { DebugSessionApp } from "./DebugSessionApp.tsx"

/**
 * Geocode `input` once and render exactly one {@link DebugFrame} to a string for the non-TTY
 * `--debug` answer, exported for `static.test.ts` rather than as a consumer-facing surface.
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

	const session = await createGeocodeSession({ ...options, trace: true })

	try {
		const { result, tree, trace, timing } = await session.geocode(input)
		const tilesPath = await resolveTilesPath(options.tiles)
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
				await source[Symbol.asyncDispose]()
			}
		}

		return await renderInkToString(
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
		session[Symbol.dispose]()
	}
}

function GeocodeDebugStatic(props: { input: string; options: GeocodeCommandOptions }): React.ReactElement | null {
	const state = useCommandTask(async () => runStaticDebug(props.input, props.options))

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	if (state.status !== "done") {
		return null
	}

	return writeRawStdout(state.result)
}

/**
 * Ink keeps one renderer per stdout, so the command tree unmounts before the session
 * renders rather than mounting a second renderer.
 */
/* oxlint-disable react-hooks/exhaustive-deps -- One-shot by interface, like `useCommandTask`: the handoff happens
	 once at mount. A fresh `options` object per render must not repeat it. The empty deps array is the point. */

function DebugSessionHandoff(props: { input: string; options: GeocodeCommandOptions }): React.ReactElement | null {
	const { exit } = useApp()

	useEffect(() => {
		let handed = false

		const handoff = setImmediate(() => {
			handed = true
			exit()

			const session = render(<DebugSessionApp initialInput={props.input} options={props.options} />, {
				alternateScreen: true,
				incrementalRendering: true,
				// No code in the session logs through `console`; leaving the native methods
				// unchanged keeps the resolver's own stderr banner out of Ink's re-render path.
				patchConsole: false,
			})

			// A fatal is reported on stderr because Ink discards alternate-screen teardown output,
			// so a message rendered inside the session would not survive the switch.
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
