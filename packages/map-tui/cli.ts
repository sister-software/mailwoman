#!/usr/bin/env node

/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The `map-tui` bin — `npx @mailwoman/map-tui` opens a PMTiles archive as a full-screen terminal map.
 *
 * This file owns everything process-shaped so the rest of the package stays testable without one: argv and the
 * environment (parsed by ./cli-args.ts), the archive handle, signal handlers, and the exit code. `MapBrowser` takes
 * streams rather than reaching for `process` itself, which is what lets the PTY smoke test drive the real bin and a
 * unit test drive the parser with neither.
 *
 * Signal handling is not optional here. This is a raw-mode app on the alternate screen with mouse reporting on, and
 * there is no framework underneath to put any of that back — a process killed between `start` and `restore` leaves the
 * user with an unusable shell. So `restore` is wired to SIGINT, SIGTERM and `exit`, and it is idempotent for exactly
 * that reason.
 */

import { createRequire } from "@mailwoman/platform/module"

import { MapBrowser } from "./browser.ts"
import { type CLIArgs, CLIArgsError, HELP_TEXT, parseCLIArgs } from "./cli-args.ts"
import { TileSource } from "./tile-source.ts"

/**
 * Exit code for a command line that could not be parsed.
 */
const EXIT_USAGE = 1

/**
 * Reads the package's own version.
 *
 * Self-reference (`@mailwoman/map-tui/...`, which the package's `exports` publishes) rather than a path relative to
 * this file: the bin runs from `out/` when installed and from the workspace root in development, and only the package
 * graph knows which. `createRequire` parses the JSON itself, so no reader here has to.
 */
function readVersion(): string {
	const require = createRequire(import.meta.url)
	const manifest = require("@mailwoman/map-tui/package.json") as { version?: string }

	return manifest.version ?? "0.0.0"
}

/**
 * Opens the archive, translating the filesystem's error into something that names the flag that was wrong.
 */
async function openTiles(path: string): Promise<TileSource> {
	try {
		return await TileSource.open(path)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)

		throw new CLIArgsError(
			`Could not open the tile archive at ${path}: ${detail}\n` +
				"Pass --tiles <archive.pmtiles>, or download one from https://protomaps.com/downloads"
		)
	}
}

/**
 * Runs the interactive browser against an already-open archive, resolving with its exit code.
 */
async function browse(source: TileSource, args: { lat: number; lon: number; zoom: number }): Promise<number> {
	const browser = new MapBrowser({
		source,
		input: process.stdin,
		output: process.stdout,
		lat: args.lat,
		lon: args.lon,
		zoom: args.zoom,
	})

	const onSignal = (): void => browser.requestExit(130)
	const onExit = (): void => browser.restore()

	process.on("SIGINT", onSignal)
	process.on("SIGTERM", onSignal)
	process.on("exit", onExit)

	try {
		return await browser.run()
	} finally {
		browser.restore()
		process.off("SIGINT", onSignal)
		process.off("SIGTERM", onSignal)
		process.off("exit", onExit)
	}
}

async function main(): Promise<number> {
	let args: CLIArgs

	try {
		/**
		 * This package takes no `@mailwoman` dependency by design (see ./mercator.ts), so the blessed readers are out of
		 * reach: `@mailwoman/core/env` would pull core's shipped data behind a CLI whose whole premise is `npx`.
		 * `parseCLIArgs` is the local equivalent — argv and the environment are read on this one line, and nowhere else in
		 * the package.
		 */
		// oxlint-disable-next-line sister-software/no-process-globals -- see above.
		args = parseCLIArgs(process.argv.slice(2), process.env)
	} catch (error) {
		if (!(error instanceof CLIArgsError)) throw error

		process.stderr.write(`${error.message}\n`)

		return EXIT_USAGE
	}

	if (args.mode === "help") {
		process.stdout.write(HELP_TEXT)

		return 0
	}

	if (args.mode === "version") {
		process.stdout.write(`${readVersion()}\n`)

		return 0
	}

	let opened: TileSource

	// A bad `--tiles` path is a usage error, not a crash — the guard stays around the open, and ownership passes to the
	// `using` declaration only once the open succeeded.
	try {
		opened = await openTiles(args.tiles)
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)

		return EXIT_USAGE
	}

	await using source = opened

	return await browse(source, args)
}

process.exitCode = await main()
