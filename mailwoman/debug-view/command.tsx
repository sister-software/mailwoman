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
 *   - A TTY invocation gets the interactive three-panel session, {@link DebugSessionApp}, which owns its own
 *     session, tile archive and alternate-screen lifecycle.
 *
 *   {@linkcode GeocodeDebugCommand} is itself a hook-free dispatcher between the two, the same shape
 *   `geocode.tsx`'s top-level `GeocodeCommand` uses to choose between this module and its own one-shot path.
 *   Branching on `process.stdout.isTTY` INSIDE a component that also calls `useCommandTask` would make that
 *   hook call conditional — forbidden by the rules of hooks even though `isTTY` never changes mid-process, because
 *   a static analyzer has no way to know that. Splitting the static and interactive halves into their own
 *   components (`GeocodeDebugStatic` / {@link DebugSessionApp}) keeps each one's own hook usage unconditional.
 *
 *   The decisions both surfaces have to agree on — the opening zoom, the `--format` guard, the map-pane size floor —
 *   live in `view-policy.ts` rather than here. This module imports the session, so the session cannot import back out
 *   of it (`import/no-cycle`), and a second copy of a guard is a second place for it to drift.
 */

import { $public } from "@mailwoman/core/env"
import { type MapFrame, MapRenderer, TileSource } from "@mailwoman/map-tui"
import { Text } from "ink"
import { commandError, useCommandTask, writeRawStdout } from "mailwoman/cli-kit"
import type React from "react"

import type { GeocodeCommandOptions } from "../commands/geocode.tsx"
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
		throw commandError(
			'geocode requires a positional address argument  (e.g. mailwoman geocode "350 5th Ave, New York, NY")'
		)
	}

	assertDebugFormatSanity(options)

	const [columns, rows] = options.debugSize.split("x").map(Number) as [number, number]

	assertDebugSizeFloor(columns, rows)

	const session = await createGeocodeSession(options)

	try {
		const { result, tree } = await session.geocode(input)
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
				data={{ input, tree, result, frame, mapNote }}
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

//#region Dispatcher

export function GeocodeDebugCommand(props: {
	input: string
	options: GeocodeCommandOptions
}): React.ReactElement | null {
	return process.stdout.isTTY ? (
		<DebugSessionApp initialInput={props.input} options={props.options} />
	) : (
		<GeocodeDebugStatic input={props.input} options={props.options} />
	)
}

//#endregion
