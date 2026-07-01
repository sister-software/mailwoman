#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-wof-build-candidate --in <admin.db> --out <candidate.db>`
 *
 *   Operator-side one-shot CLI that builds the global byte-range "candidate" lookup DB for the
 *   browser demo (the FTS-free, single-probe gazetteer). Delegates to
 *   {@linkcode buildCandidateTable}; the CLI is just argument parsing + stderr progress. The
 *   TypeScript port of the 2026-06-20 prototype — it lives in the package (not /scripts) so the
 *   name_key normalizer is the SAME shared `normalizeLocalityForKey` the query-side resolver uses.
 */

import { exit, stderr } from "node:process"

import { buildCandidateTable } from "./build-candidate.js"

interface CLIArgs {
	input: string
	output: string
	postcodes: string[]
}

function printUsageAndExit(code: number): never {
	stderr.write(
		[
			"usage: mailwoman-wof-build-candidate --in <admin.db> --out <candidate.db> [--postcodes <pc.db>]...",
			"",
			"Builds the global candidate lookup DB (FTS-free, single B-tree probe per resolve) from a",
			"unified admin WOF DB (needs spr, place_population, place_search, place_abbr, ancestors).",
			"--postcodes folds a postcode shard (spr placetype='postalcode' + coords, e.g. postalcode-us.db)",
			"in as postalcode rows so findPlace(postalcode) resolves a ZIP. Name keys use the shared",
			"normalizeLocalityForKey — the query side MUST match.",
			"",
		].join("\n")
	)
	exit(code)
}

function parseArgs(argv: string[]): CLIArgs {
	let input: string | undefined
	let output: string | undefined
	const postcodes: string[] = []

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]

		if (a === "--in" || a === "--input") input = argv[++i]
		else if (a === "--out" || a === "--output") output = argv[++i]
		else if (a === "--postcodes") {
			const v = argv[++i]

			if (v) postcodes.push(v)
		} else if (a === "-h" || a === "--help") printUsageAndExit(0)
		else {
			stderr.write(`unknown argument: ${a}\n`)
			printUsageAndExit(1)
		}
	}

	if (!input || !output) printUsageAndExit(1)

	return { input, output, postcodes }
}

export async function main(rawArgv: string[]): Promise<number> {
	const args = parseArgs(rawArgv)
	const t0 = Date.now()
	const result = await buildCandidateTable({
		input: args.input,
		output: args.output,
		postcodes: args.postcodes,
		onProgress: (phase, message) => stderr.write(`  [${phase}] ${message}\n`),
	})
	const secs = ((Date.now() - t0) / 1000).toFixed(1)
	stderr.write(
		`done in ${secs}s: ${result.rows.toLocaleString()} rows ` +
			`(${result.primaries.toLocaleString()} primary, ${result.aliases.toLocaleString()} alias, ` +
			`${result.abbrevs} abbr, ${result.postcodes.toLocaleString()} postcode) ` +
			`from ${result.places.toLocaleString()} places → ${args.output}\n`
	)

	return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2))
		.then((code) => exit(code))
		.catch((err) => {
			stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
			exit(1)
		})
}
