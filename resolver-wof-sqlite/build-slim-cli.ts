#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-wof-build-slim --in <wof.db>... --out <slim.db> [--top 1000] [--countries US]`
 *
 *   Operator-side one-shot CLI that produces a "slim" WOF SQLite distribution sized for the
 *   browser-side mailwoman demo (Path B). Delegates to {@linkcode buildSlimWofDatabase}; the CLI is
 *   just argument parsing + stderr progress.
 */

import { exit, stderr } from "node:process"

import { buildSlimWofDatabase, type BuildSlimOptions } from "./build-slim.js"

interface CliArgs {
	inputs: string[]
	output: string
	topLocalities: number
	countries: string[]
}

function printUsageAndExit(code: number): never {
	stderr.write(
		[
			"usage: mailwoman-wof-build-slim --in <wof.db>... --out <slim.db> [--top N] [--countries US,CA,...]",
			"",
			"Builds a trimmed WOF SQLite distribution for the browser-side demo. Default selection:",
			"  - All ancestor placetypes (country/region/county/borough/macroregion) in scope",
			"  - Top --top localities by wof:population (default 1000)",
			"  - All postalcodes in scope",
			"  - All names + geojson rows for selected IDs",
			"  - Fresh place_search FTS5, place_bbox R*Tree, place_population aux tables",
			"",
			"Examples:",
			"  mailwoman-wof-build-slim --in admin-us.db --in postalcode-us.db --out wof-hot.db",
			"  mailwoman-wof-build-slim --in admin-us.db --out wof-tiny.db --top 100",
			"  mailwoman-wof-build-slim --in admin-na.db --out wof-na.db --countries US,CA,MX",
			"",
		].join("\n")
	)
	exit(code)
}

function parseArgs(argv: string[]): CliArgs {
	const out: CliArgs = { inputs: [], output: "", topLocalities: 1000, countries: ["US"] }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === "--in") {
			const v = argv[++i]
			if (!v) printUsageAndExit(2)
			out.inputs.push(v)
		} else if (a === "--out") {
			const v = argv[++i]
			if (!v) printUsageAndExit(2)
			out.output = v
		} else if (a === "--top") {
			const v = argv[++i]
			if (!v) printUsageAndExit(2)
			const n = Number(v)
			if (!Number.isFinite(n) || n <= 0) {
				stderr.write(`--top must be a positive number; got '${v}'\n`)
				exit(2)
			}
			out.topLocalities = n
		} else if (a === "--countries") {
			const v = argv[++i]
			if (!v) printUsageAndExit(2)
			out.countries = v
				.split(",")
				.map((c) => c.trim())
				.filter(Boolean)
		} else if (a === "--help" || a === "-h") {
			printUsageAndExit(0)
		} else {
			stderr.write(`unknown argument: '${a}'\n`)
			printUsageAndExit(2)
		}
	}
	if (out.inputs.length === 0 || !out.output) printUsageAndExit(2)
	return out
}

export function main(rawArgv: string[]): number {
	let args: CliArgs
	try {
		args = parseArgs(rawArgv)
	} catch {
		return 2
	}

	const opts: BuildSlimOptions = {
		inputs: args.inputs,
		output: args.output,
		countries: args.countries,
		topLocalitiesPerCountry: args.topLocalities,
		onProgress: (phase, detail) => {
			stderr.write(`[${phase}] ${detail}\n`)
		},
	}

	try {
		const result = buildSlimWofDatabase(opts)
		const mb = (result.outputBytes / 1024 / 1024).toFixed(1)
		stderr.write(
			`\nBuilt ${result.outputPath} (${mb} MB)\n` +
				`  spr=${result.rowCounts.spr}` +
				`  names=${result.rowCounts.names}` +
				`  geojson=${result.rowCounts.geojson}` +
				`  fts=${result.rowCounts.placeSearch}` +
				`  bbox=${result.rowCounts.placeBbox}` +
				`  pop=${result.rowCounts.placePopulation}\n`
		)
		return 0
	} catch (err) {
		stderr.write(`build-slim failed: ${(err as Error).message}\n`)
		return 1
	}
}

// Run when invoked as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
	exit(main(process.argv.slice(2)))
}
