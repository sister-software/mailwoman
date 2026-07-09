#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-wof-build-slim --in <wof.db>... --out <slim.db> [--top 1000] [--countries US]`
 *
 *   Operator-side one-shot CLI that produces a "slim" WOF SQLite distribution sized for the
 *   browser-side mailwoman demo (Path B). Delegates to {@linkcode buildSlimWOFDatabase}; the CLI is
 *   just argument parsing + stderr progress.
 */

import { exit, stderr } from "node:process"
import { parseArgs } from "node:util"

import { runIfScript } from "@mailwoman/core/scripting"

import { buildSlimWOFDatabase, type BuildSlimOptions } from "./build-slim.ts"

interface CLIArgs {
	inputs: string[]
	output: string
	topLocalities: number
	countries: string[]
	dropNames: boolean
}

function printUsageAndExit(code: number): never {
	stderr.write(
		[
			"usage: mailwoman-wof-build-slim --in <wof.db>... --out <slim.db> [--top N] [--countries US,CA,...] [--drop-names]",
			"",
			"Builds a trimmed WOF SQLite distribution for the browser-side demo. Default selection:",
			"  - All ancestor placetypes (country/region/county/borough/macroregion) in scope",
			"  - Top --top localities by population (from the source place_population table, default 1000)",
			"  - All postalcodes in scope",
			"  - All names + place_population rows for selected IDs (+ coincident_roles, filtered)",
			"  - Fresh place_search FTS5 + place_bbox R*Tree (rebuilt from spr + names)",
			"",
			"--drop-names drops the names table after the FTS build (self-contained FTS5; ~2/3 size win,",
			"the resolver never reads names at runtime — see #359). Empty --in values are skipped (pass",
			'"" for a shard that isn\'t built yet).',
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

function parseSlimArgv(argv: readonly string[] | undefined) {
	return parseArgs({
		args: argv ? [...argv] : undefined,
		options: {
			in: { type: "string", multiple: true, default: [] },
			out: { type: "string" },
			top: { type: "string", default: "1000" },
			countries: { type: "string", default: "US" },
			"drop-names": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	})
}

function parseCLIArgs(argv: readonly string[] | undefined): CLIArgs {
	let parsed: ReturnType<typeof parseSlimArgv>

	try {
		parsed = parseSlimArgv(argv)
	} catch (error) {
		stderr.write(`mailwoman-wof-build-slim: ${error instanceof Error ? error.message : String(error)}\n`)
		printUsageAndExit(2)
	}

	if (parsed.values.help) {
		printUsageAndExit(0)
	}

	// Callers pass `--in ""` for a shard (e.g. a custom postcode DB) that isn't built yet — keep
	// only non-empty paths; build-slim skips the rest.
	const inputs = parsed.values.in.filter(Boolean)
	const output = parsed.values.out
	const top = Number(parsed.values.top)

	if (!Number.isFinite(top) || top <= 0) {
		stderr.write(`--top must be a positive number; got '${parsed.values.top}'\n`)
		exit(2)
	}
	const countries = parsed.values.countries
		.split(",")
		.map((c) => c.trim())
		.filter(Boolean)

	if (inputs.length === 0 || !output) {
		printUsageAndExit(2)
	}

	return { inputs, output, topLocalities: top, countries, dropNames: parsed.values["drop-names"] }
}

export async function main(argv?: readonly string[]): Promise<number> {
	const args = parseCLIArgs(argv)

	const opts: BuildSlimOptions = {
		inputs: args.inputs,
		output: args.output,
		countries: args.countries,
		topLocalitiesPerCountry: args.topLocalities,
		dropNames: args.dropNames,
		onProgress: (phase, detail) => {
			stderr.write(`[${phase}] ${detail}\n`)
		},
	}

	try {
		const result = await buildSlimWOFDatabase(opts)
		const mb = (result.outputBytes / 1024 / 1024).toFixed(1)
		stderr.write(
			`\nBuilt ${result.outputPath} (${mb} MB)\n` +
				`  spr=${result.rowCounts.spr}` +
				`  names=${result.rowCounts.names}${args.dropNames ? " (dropped)" : ""}` +
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

runIfScript(import.meta, () => main())
