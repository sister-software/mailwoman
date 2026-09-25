/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Holds the zoom, flag and frame-size rules shared by the static `--debug` capture and the interactive session.
 */

import { CommandError } from "@mailwoman/core/scripting/command"

import type { GeocodeCommandOptions } from "#geocode/command-options"
import type { GeocodeResult } from "#geocode/result"

// #region Zoom heuristic

/**
 * Returns the map pane's initial zoom for a geocoded result.
 *
 * An address-grade result opens close in.
 * An admin-only result opens wider as its finest place gets coarser.
 */
export function initialZoomForTier(result: GeocodeResult): number {
	if (result.resolution_tier === "address_point" || result.resolution_tier === "interpolated") return 15

	// `hierarchy` is ordered most specific first, so its head is the finest resolved place.
	const leaf = result.hierarchy.at(0)?.tag

	if (leaf === "locality" || leaf === "dependent_locality") return 11

	if (leaf === "region") return 6

	return 4
}

// #endregion

// #region CLI-usage guards

/**
 * Rejects `--debug` combined with a `--format` shorthand or a non-default `--format` value.
 *
 * `--debug` renders its own output, so no other output format applies.
 *
 * @throws {CommandError} On a conflicting format flag.
 */
export function assertDebugFormatSanity(options: GeocodeCommandOptions): void {
	const shorthands = (["json", "text", "jsonld"] as const).filter((name) => options[name])

	if (shorthands.length) {
		throw new CommandError(
			`--debug is its own output surface; drop ${shorthands.map((name) => `--${name}`).join(" ")}.`
		)
	}

	// An explicit `--format json` cannot be told apart from the default, so only other values fail.
	if (options.format && options.format !== "json") {
		throw new CommandError(`--debug is its own output surface; drop --format ${options.format}.`)
	}
}

/**
 * Sets the smallest frame that renders a usable map pane.
 *
 * A smaller frame makes `mapPaneCellSize` return a non-positive row count, which crashes map-tui.
 * The row floor is `DebugFrame`'s fixed chrome plus six map rows.
 * If the chrome grows, `MIN_DEBUG_ROWS` must grow with it.
 */
const MIN_DEBUG_COLUMNS = 60
const MIN_DEBUG_ROWS = 20

/**
 * Describes how a frame falls below the size floor, or returns null when it is large enough.
 *
 * The static path rejects the violation.
 * The interactive session shows it as a note in place of the map pane.
 */
export function debugSizeFloorViolation(columns: number, rows: number): string | null {
	if (columns >= MIN_DEBUG_COLUMNS && rows >= MIN_DEBUG_ROWS) return null

	return `below the ${MIN_DEBUG_COLUMNS}x${MIN_DEBUG_ROWS} minimum: ${columns}x${rows}`
}

/**
 * Rejects a `--debug-size` below the size floor before any database or weights load.
 *
 * @throws {CommandError} When the size is below the floor.
 */
export function assertDebugSizeFloor(columns: number, rows: number): void {
	const violation = debugSizeFloorViolation(columns, rows)

	if (violation) throw new CommandError(`--debug-size ${violation}`)
}

// #endregion
