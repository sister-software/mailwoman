/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `--debug` branch of `mailwoman geocode` (Task 12/13). Two paths share one geocode:
 *
 *   - A piped/non-TTY invocation renders exactly ONE {@link DebugFrame} (the input row + the resolved output +
 *     a rendered map pane) through {@link renderInkToString} and writes it out with `writeRawStdout` — the same
 *     #1577 posture as `geocode.tsx`'s one-shot JSON/text/jsonld path: nothing on the success path renders
 *     through Ink's live reconciler, so there is no frame for Ink to clear and no frame tall enough to wipe the
 *     scrollback.
 *   - A TTY invocation gets the interactive three-panel session — landing in Task 13. This module only shows a
 *     placeholder for it today.
 *
 *   {@linkcode GeocodeDebugCommand} is itself a hook-free dispatcher between the two, the same shape
 *   `geocode.tsx`'s top-level `GeocodeCommand` uses to choose between this module and its own one-shot path.
 *   Branching on `process.stdout.isTTY` INSIDE a component that also calls `useCommandTask` would make that
 *   hook call conditional — forbidden by the rules of hooks even though `isTTY` never changes mid-process, because
 *   a static analyzer has no way to know that. Splitting the static and interactive halves into their own
 *   components (`GeocodeDebugStatic` / `GeocodeDebugInteractive`) keeps each one's own hook usage unconditional.
 */

import { $public } from "@mailwoman/core/env"
import { type MapFrame, MapRenderer, TileSource } from "@mailwoman/map-tui"
import { Text } from "ink"
import { commandError, useCommandTask, writeRawStdout } from "mailwoman/cli-kit"
import type React from "react"

import type { GeocodeCommandOptions } from "../commands/geocode.tsx"
import type { GeocodeResult } from "../geocode-core.ts"
import { createGeocodeSession } from "../geocode-session.ts"
import { DebugFrame, mapPaneCellSize } from "./DebugFrame.tsx"
import { renderInkToString } from "./static-render.ts"
import { resolveTilesPath } from "./tiles.ts"

//#region Zoom heuristic

/**
 * The map pane's initial zoom for a freshly-geocoded result, before any interactive pan/zoom (Task 13). Tight for a
 * house-grade fix; progressively wider for whatever admin tier the resolve actually reached, so an admin-only fallback
 * doesn't open on a single-building zoom over a whole region or country.
 */
export function initialZoomForTier(result: GeocodeResult): number {
	if (result.resolution_tier === "address_point" || result.resolution_tier === "interpolated") return 15

	const leaf = result.hierarchy.at(-1)?.tag

	if (leaf === "locality" || leaf === "dependent_locality") return 11

	if (leaf === "region") return 6

	return 4
}

//#endregion

//#region CLI-usage guards

/**
 * `--debug` is its own rendered surface (a captured Ink frame) — combining it with a `--format` shorthand has no
 * defensible reading. Thrown with {@link commandError} so it reports through the standard error state (exit code 1) on
 * the static path below; Task 13's interactive session wires the same guard at mount, matching `resolveFormat`'s
 * two-shorthands-at-once check in `geocode.tsx`.
 */
function assertDebugFormatSanity(options: GeocodeCommandOptions): void {
	const shorthands = (["json", "text", "jsonld"] as const).filter((name) => options[name])

	if (shorthands.length) {
		throw commandError(`--debug is its own output surface; drop ${shorthands.map((name) => `--${name}`).join(" ")}.`)
	}
}

/**
 * The smallest `--debug-size` `mapPaneCellSize` can turn into a map-tui viewport that actually renders. Below it,
 * `mapPaneCellSize`'s row math goes non-positive before `MapRenderer` ever runs: measured 2026-08-13, `100x5`
 * (`mapPaneCellSize` rows -3) crashes with a raw `RangeError: Invalid typed array length: -4608` from `new RGBAGrid`
 * deep inside map-tui, and `100x8` (rows 0) renders but with the ribbon/output/map panes overlapping garbled. `60x14`
 * (`mapPaneCellSize` → 28x6) is the smallest size that renders a legible, non-degenerate frame, so that's the floor —
 * checked at the CLI boundary, before any DB/weights work, same posture as {@link assertDebugFormatSanity}.
 */
const MIN_DEBUG_COLUMNS = 60
const MIN_DEBUG_ROWS = 14

function assertDebugSizeFloor(columns: number, rows: number): void {
	if (columns < MIN_DEBUG_COLUMNS || rows < MIN_DEBUG_ROWS) {
		throw commandError(`--debug-size below the ${MIN_DEBUG_COLUMNS}x${MIN_DEBUG_ROWS} minimum: ${columns}x${rows}`)
	}
}

//#endregion

//#region Static (non-TTY) path

/**
 * Geocode `input` once and render exactly one {@link DebugFrame} to a string — the whole non-TTY `--debug` answer. The
 * tile archive is opened independently of the geocode session (the session owns the gazetteer/shard handles; the
 * archive is a debug-view-only concern) and both are released in `finally`, so a mid-render throw — a corrupt tiles
 * archive, say — still closes every handle.
 *
 * Exported for `static.test.ts` only — not part of this module's consumer-facing surface (`GeocodeDebugCommand`,
 * `initialZoomForTier`); no caller outside this directory should import it.
 */
export async function runStaticDebug(input: string, options: GeocodeCommandOptions): Promise<string> {
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
				color={$public.NO_COLOR == null}
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

//#region Interactive (TTY) placeholder — Task 13 replaces this

function GeocodeDebugInteractive(): React.ReactElement {
	return <Text>interactive session lands in the next commit</Text>
}

//#endregion

//#region Dispatcher

export function GeocodeDebugCommand(props: { input: string; options: GeocodeCommandOptions }): React.ReactElement {
	return process.stdout.isTTY ? (
		<GeocodeDebugInteractive />
	) : (
		<GeocodeDebugStatic input={props.input} options={props.options} />
	)
}

//#endregion
