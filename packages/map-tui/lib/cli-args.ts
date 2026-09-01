import { errorMessage } from "@mailwoman/core/errors/schema"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Argument parsing for the `map-tui` bin.
 *
 * `parseCLIArgs` is pure: it takes the argv slice and an environment record, and answers with a discriminated result
 * (`help` / `version` / `browse`) or throws {@link CLIArgsError}. Reading `process.argv` / `process.env` is the bin's
 * job (./cli.ts), which keeps every rejection path testable without a subprocess.
 */

/**
 * Center longitude when `--lon` is omitted — the world view mapscii opens on.
 */
const DEFAULT_LON = 0

/**
 * Center latitude when `--lat` is omitted.
 */
const DEFAULT_LAT = 0

/**
 * Zoom when `--zoom` is omitted. z2 shows a full hemisphere in a typical terminal, so a planet archive opens on
 * something recognizable rather than a single ocean tile.
 */
const DEFAULT_ZOOM = 2

/**
 * Widest zoom any tile archive uses.
 */
const MIN_ZOOM = 0

/**
 * Deepest zoom the Web-Mercator tile pyramid is defined for. The archive's own `maxZoom` clamps further at runtime;
 * this is only the range a flag value must fall inside to be meaningful at all.
 */
const MAX_ZOOM = 24

// True geographic bounds, not Web-Mercator's ±85.05113: the flag accepts any real latitude, and the browser clamps
// the CENTER to the projection's MERCATOR_LATITUDE_LIMIT itself (see ./browser.ts) — rejecting 87 here would refuse a
// value the viewport handles fine.
const MIN_LAT = -90
const MAX_LAT = 90
const MIN_LON = -180
const MAX_LON = 180

/**
 * A view request: an archive to read and where to open it.
 */
export interface BrowseArgs {
	mode: "browse"
	/**
	 * Path to the PMTiles archive.
	 */
	tiles: string
	lat: number
	lon: number
	/**
	 * Integer zoom level. The renderer draws whole tile-pyramid levels, so a fractional flag value is rounded here rather
	 * than carried as a lie through the viewport.
	 */
	zoom: number
}

export type CLIArgs = { mode: "help" } | { mode: "version" } | BrowseArgs

/**
 * A rejected command line. The message is user-facing: it says what was wrong AND what to pass instead, since the bin
 * prints it verbatim to stderr.
 */
export class CLIArgsError extends Error {
	override name = "CLIArgsError"
}

/**
 * Environment keys the CLI reads. Passed in rather than read here so the parser stays pure.
 */
export interface CLIEnvironment {
	MAILWOMAN_TILES?: string | undefined
}

/**
 * `--help` output. It doubles as the package's key reference, so the bindings listed here and the ones ./input.ts
 * decodes are the same list said twice — a key added there without a line here is a key nobody finds.
 */
export const HELP_TEXT = `map-tui — the whole world in your terminal

Usage
  npx @mailwoman/map-tui --tiles <archive.pmtiles> [options]

Options
  --tiles <path|url>  PMTiles archive — local path or https:// URL (default: $MAILWOMAN_TILES)
  --lat <degrees>   Initial center latitude, -90..90 (default: ${DEFAULT_LAT})
  --lon <degrees>   Initial center longitude, -180..180 (default: ${DEFAULT_LON})
  --zoom <level>    Initial zoom, ${MIN_ZOOM}..${MAX_ZOOM} (default: ${DEFAULT_ZOOM})
  -h, --help        Print this help and exit
  -v, --version     Print the package version and exit

Keys
  arrows, hjkl      Pan
  +, =, a           Zoom in
  -, _, z           Zoom out
  q, Esc, Ctrl+C    Quit

Mouse
  Wheel zooms toward the pointer, drag pans, click centers.

Tiles are never bundled with this package. Download a planet or region
archive from https://protomaps.com/downloads and point --tiles at it.
`

/**
 * Reads one numeric flag, rejecting anything `Number` would quietly accept as garbage (empty string, whitespace,
 * `Infinity`) as well as out-of-range values.
 */
function numericFlag(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
	if (raw == null) return fallback

	const value = Number(raw.trim())

	if (!Number.isFinite(value) || !raw.trim().length) {
		throw new CLIArgsError(`--${name} expects a number, got ${JSON.stringify(raw)}`)
	}

	if (value < min || value > max) {
		throw new CLIArgsError(`--${name} must be between ${min} and ${max}, got ${value}`)
	}

	return value
}

/**
 * Flags whose value is a number, and may therefore start with a dash.
 */
const NUMERIC_FLAGS = new Set(["--lat", "--lon", "--zoom"])

/**
 * Joins `--lon -122.6` into `--lon=-122.6` before `parseArgs` sees it.
 *
 * `node:util`'s parser refuses a separate value that starts with a dash — it cannot tell a negative number from a
 * mistyped flag, and says so ("argument is ambiguous"). Half the planet has a negative longitude, so the space-form has
 * to work. The join is conditional on the next token parsing as a finite number, which leaves a genuinely missing value
 * (`--lon --zoom 3`) to `parseArgs` and its own error.
 */
function joinNegativeNumbers(argv: readonly string[]): string[] {
	const joined: string[] = []

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index]!
		const next = argv[index + 1]

		if (NUMERIC_FLAGS.has(token) && next?.startsWith("-") && Number.isFinite(Number(next))) {
			joined.push(`${token}=${next}`)
			index += 1

			continue
		}

		joined.push(token)
	}

	return joined
}

interface ParsedFlags {
	tiles?: string | undefined
	lat?: string | undefined
	lon?: string | undefined
	zoom?: string | undefined
	help?: boolean | undefined
	version?: boolean | undefined
}

/**
 * `node:util`'s own rejections (unknown flag, missing value) name the flag but not the remedy, so they're re-thrown as
 * a {@link CLIArgsError} pointing at `--help`.
 */
function readFlags(argv: readonly string[]): ParsedFlags {
	try {
		const { values } = parseArguments({
			args: joinNegativeNumbers(argv),
			options: {
				tiles: { type: "string" },
				lat: { type: "string" },
				lon: { type: "string" },
				zoom: { type: "string" },
				help: { type: "boolean", short: "h" },
				version: { type: "boolean", short: "v" },
			},
			allowPositionals: false,
			strict: true,
		})

		return values
	} catch (error) {
		throw new CLIArgsError(`${errorMessage(error)}\nRun \`map-tui --help\` for the supported flags.`)
	}
}

/**
 * Parses a `map-tui` command line.
 *
 * @throws {CLIArgsError} On an unknown flag, an unparseable or out-of-range number, or a missing archive path.
 */
export function parseCLIArgs(argv: readonly string[], environment: CLIEnvironment = {}): CLIArgs {
	const values = readFlags(argv)

	if (values.help) return { mode: "help" }

	if (values.version) return { mode: "version" }

	const tiles = (values.tiles ?? environment.MAILWOMAN_TILES ?? "").trim()

	if (!tiles.length) {
		throw new CLIArgsError(
			"No tile archive: pass --tiles <archive.pmtiles> or set MAILWOMAN_TILES.\n" +
				"Planet and region archives: https://protomaps.com/downloads"
		)
	}

	return {
		mode: "browse",
		tiles,
		lat: numericFlag("lat", values.lat, DEFAULT_LAT, MIN_LAT, MAX_LAT),
		lon: numericFlag("lon", values.lon, DEFAULT_LON, MIN_LON, MAX_LON),
		zoom: Math.round(numericFlag("zoom", values.zoom, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM)),
	}
}
