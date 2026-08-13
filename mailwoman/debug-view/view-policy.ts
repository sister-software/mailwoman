/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The three decisions `--debug`'s two surfaces have to agree on: which zoom the map pane opens at, which flag
 *   combinations are a usage error, and how small a frame is too small to render. Both the static capture
 *   (`command.tsx`) and the interactive session (`DebugSessionApp.tsx`) enforce all three, and they enforce them
 *   differently — the static path rejects a bad `--debug-size`, the session degrades a too-small TERMINAL to a note —
 *   so the shared part is the verdict, not the reaction to it.
 *
 *   Their own module because the alternative is a cycle: the session is imported BY the command module and would have
 *   to import these back OUT of it, which `import/no-cycle` refuses. Pure and JSX-free, so it type-strips under bare
 *   node like the rest of the non-component tier.
 */

import { commandError } from "mailwoman/cli-kit"

import type { GeocodeCommandOptions } from "../commands/geocode.tsx"
import type { GeocodeResult } from "../geocode-core.ts"

//#region Zoom heuristic

/**
 * The map pane's initial zoom for a freshly-geocoded result, before any interactive pan/zoom. Tight for a house-grade
 * fix; progressively wider for whatever admin tier the resolve actually reached, so an admin-only fallback doesn't open
 * on a single-building zoom over a whole region or country.
 */
export function initialZoomForTier(result: GeocodeResult): number {
	if (result.resolution_tier === "address_point" || result.resolution_tier === "interpolated") return 15

	// `hierarchy` is ordered MOST SPECIFIC FIRST (`GeocodeResult.hierarchy`: "locality → country"), so the head is the
	// finest place the resolver decorated. Reading `.at(-1)` took the COUNTRY instead and opened every admin-tier
	// answer at the whole-country zoom 4: a bare "Portland, Oregon" resolved its locality and then showed North
	// America.
	const leaf = result.hierarchy.at(0)?.tag

	if (leaf === "locality" || leaf === "dependent_locality") return 11

	if (leaf === "region") return 6

	return 4
}

//#endregion

//#region CLI-usage guards

/**
 * `--debug` is its own rendered surface (a captured Ink frame) — combining it with a `--format` shorthand, or with an
 * explicit non-default `--format` value, has no defensible reading. Thrown with {@link commandError} so it reports
 * through the standard error state (exit code 1) on the static path; the interactive session runs the same guard as the
 * FIRST statement of its mount effect, before it takes the alternate screen, matching `resolveFormat`'s
 * two-shorthands-at-once check in `geocode.tsx`.
 */
export function assertDebugFormatSanity(options: GeocodeCommandOptions): void {
	const shorthands = (["json", "text", "jsonld"] as const).filter((name) => options[name])

	if (shorthands.length) {
		throw commandError(`--debug is its own output surface; drop ${shorthands.map((name) => `--${name}`).join(" ")}.`)
	}

	// `--format json` stays indistinguishable from the default (unset) here — same documented blind spot as
	// `resolveFormat` in `geocode.tsx`. Only an explicit non-default value is a usage error.
	if (options.format && options.format !== "json") {
		throw commandError(`--debug is its own output surface; drop --format ${options.format}.`)
	}
}

/**
 * The smallest frame `mapPaneCellSize` can turn into a map-tui viewport that actually renders. Below it,
 * `mapPaneCellSize`'s row math goes non-positive before `MapRenderer` ever runs: measured 2026-08-13, `100x5`
 * (`mapPaneCellSize` rows -3) crashes with a raw `RangeError: Invalid typed array length: -4608` from `new RGBAGrid`
 * deep inside map-tui, and a size whose map-pane row budget lands at 0 renders with the panes overlapping garbled.
 *
 * The row floor is `DebugFrame`'s fixed chrome plus the 6 map rows that were the smallest legible pane: input area 9 +
 * footer 1 + MapPane's own 4 = 14, so 20. (It was 14 while the input area was 4 rows and there was no footer — the
 * evidence rows and the key hints moved the floor, not a change of mind about how small a map may be.)
 */
const MIN_DEBUG_COLUMNS = 60
const MIN_DEBUG_ROWS = 20

/**
 * A COLSxROWS pair's floor violation as reportable text, or null when it clears the floor. One function decides the
 * verdict AND names the minimum, so the two surfaces that report it can never disagree about where the floor sits: the
 * static path prefixes `--debug-size` and rejects, while the interactive session prefixes `terminal` and degrades the
 * map pane to a note — a live terminal below the floor is something the user can fix by resizing.
 */
export function debugSizeFloorViolation(columns: number, rows: number): string | null {
	if (columns >= MIN_DEBUG_COLUMNS && rows >= MIN_DEBUG_ROWS) return null

	return `below the ${MIN_DEBUG_COLUMNS}x${MIN_DEBUG_ROWS} minimum: ${columns}x${rows}`
}

/**
 * The static path's reaction to {@link debugSizeFloorViolation} — checked at the CLI boundary, before any DB/weights
 * work, same posture as {@link assertDebugFormatSanity}.
 */
export function assertDebugSizeFloor(columns: number, rows: number): void {
	const violation = debugSizeFloorViolation(columns, rows)

	if (violation) throw commandError(`--debug-size ${violation}`)
}

//#endregion
