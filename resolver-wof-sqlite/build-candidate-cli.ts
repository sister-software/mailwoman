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
import { parseArgs } from "node:util"

import { runIfScript } from "@mailwoman/core/scripting"

import { buildCandidateTable } from "./build-candidate.ts"

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

function parseCandidateArgv(argv: readonly string[] | undefined) {
	return parseArgs({
		args: argv ? [...argv] : undefined,
		options: {
			in: { type: "string" },
			input: { type: "string" },
			out: { type: "string" },
			output: { type: "string" },
			postcodes: { type: "string", multiple: true, default: [] },
			help: { type: "boolean", short: "h", default: false },
		},
	})
}

function parseCLIArgs(argv: readonly string[] | undefined): CLIArgs {
	let parsed: ReturnType<typeof parseCandidateArgv>

	try {
		parsed = parseCandidateArgv(argv)
	} catch (error) {
		stderr.write(`mailwoman-wof-build-candidate: ${error instanceof Error ? error.message : String(error)}\n`)
		printUsageAndExit(1)
	}

	if (parsed.values.help) {
		printUsageAndExit(0)
	}
	const input = parsed.values.input ?? parsed.values.in
	const output = parsed.values.output ?? parsed.values.out

	if (!input || !output) {
		printUsageAndExit(1)
	}

	return { input, output, postcodes: parsed.values.postcodes.filter(Boolean) }
}

export async function main(argv?: readonly string[]): Promise<number> {
	const args = parseCLIArgs(argv)
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

runIfScript(import.meta, () => main())
