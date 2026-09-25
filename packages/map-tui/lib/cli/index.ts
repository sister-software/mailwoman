#!/usr/bin/env node

/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The `map-tui` bin, which opens a PMTiles archive as a full-screen terminal map.
 *
 * This file is the only place in the package that touches `process`.
 * It restores the terminal on SIGINT, SIGTERM and `exit`, because a process killed
 * while in raw mode leaves the shell unusable.
 */

import { errorMessage } from "@mailwoman/core/errors/schema"
import { createRequire } from "@mailwoman/core/module/resolvers"

import { MapBrowser } from "#browser"
import { type CLIArgs, CLIArgsError, HELP_TEXT, parseCLIArgs } from "#cli/args"
import { TileSource } from "#tile-source"

/**
 * Exit code for a command line that could not be parsed.
 */
const EXIT_USAGE = 1

/**
 * Reads the package version.
 *
 * The package self-reference resolves correctly both from the installed `out/`
 * directory and from the workspace.
 */
function readVersion(): string {
	const require = createRequire(import.meta.url)
	const manifest = require("@mailwoman/map-tui/package.json") as { version?: string }

	return manifest.version ?? "0.0.0"
}

/**
 * Opens the tile archive and reports a failure as a usage error that mentions `--tiles`.
 */
async function openTiles(path: string): Promise<TileSource> {
	try {
		return await TileSource.open(path)
	} catch (error) {
		throw new CLIArgsError(
			`Could not open the tile archive at ${path}: ${errorMessage(error)}\n` +
				"Pass --tiles <archive.pmtiles>, or download one from https://protomaps.com/downloads"
		)
	}
}

/**
 * Runs the interactive browser on an open archive and resolves with its exit code.
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
		// The bin reads raw argv and env here because `@mailwoman/core/env` depends on core's data-backed schema,
		// which is too heavy for an `npx` entry point.
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

	// The `using` declaration takes ownership only after the open succeeds.
	try {
		opened = await openTiles(args.tiles)
	} catch (error) {
		process.stderr.write(`${errorMessage(error)}\n`)

		return EXIT_USAGE
	}

	await using source = opened

	return await browse(source, args)
}

process.exitCode = await main()
