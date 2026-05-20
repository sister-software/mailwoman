#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-wof-build-fts <path-to-wof.db> [--drop]`
 *
 *   Operator-side one-shot CLI: takes a Who's On First SQLite distribution and adds the
 *   `place_search` FTS5 virtual table needed by `WofSqlitePlaceLookup`. Run this once after
 *   downloading a fresh WOF shard so production callers can skip the (~minutes-long) lazy build.
 *
 *   Why a plain-args CLI rather than Ink / Pastel: this is a one-shot operator script, not an
 *   interactive TUI. The dep weight of inkjs / pastel would dominate the script's footprint and
 *   doesn't match how operators expect to drive a build step (`script /path/to/db` + stderr
 *   progress). Matches the spirit of `corpus/scripts/*.ts`.
 */

import { existsSync } from "node:fs"
import { exit, stderr } from "node:process"
import { DatabaseSync } from "node:sqlite"

import { buildPlaceSearchFts } from "./fts.js"

interface CliArgs {
	databasePath: string
	drop: boolean
}

function printUsageAndExit(code: number): never {
	stderr.write(
		[
			"usage: mailwoman-wof-build-fts <path-to-wof.db> [--drop]",
			"",
			"Builds the place_search FTS5 virtual table in a Who's On First SQLite",
			"distribution. Run this once after downloading a fresh WOF shard so production",
			"WofSqlitePlaceLookup instances don't pay the lazy-build cost at first open.",
			"",
			"  --drop   Drop and rebuild place_search if it already exists. Use after",
			"           refreshing the `places` / `names` tables from an updated dump.",
			"",
			"See https://github.com/sister-software/mailwoman/tree/main/resolver-wof-sqlite for",
			"the recommended WOF distribution sources + attribution requirements.",
			"",
		].join("\n")
	)
	exit(code)
}

function parseArgs(argv: readonly string[]): CliArgs {
	const args: string[] = []
	let drop = false
	for (const a of argv) {
		if (a === "--drop") drop = true
		else if (a === "--help" || a === "-h") printUsageAndExit(0)
		else if (a.startsWith("-")) {
			stderr.write(`mailwoman-wof-build-fts: unknown flag ${JSON.stringify(a)}\n`)
			printUsageAndExit(2)
		} else args.push(a)
	}
	if (args.length !== 1) {
		stderr.write(`mailwoman-wof-build-fts: expected exactly one positional arg, got ${args.length}\n`)
		printUsageAndExit(2)
	}
	return { databasePath: args[0]!, drop }
}

export function main(argv: readonly string[]): number {
	const args = parseArgs(argv)
	if (!existsSync(args.databasePath)) {
		stderr.write(`mailwoman-wof-build-fts: file not found: ${args.databasePath}\n`)
		return 1
	}

	stderr.write(`Opening ${args.databasePath}…\n`)
	const db = new DatabaseSync(args.databasePath)
	try {
		const result = buildPlaceSearchFts(db, {
			drop: args.drop,
			onProgress: (phase, detail) => {
				const suffix = detail ? ` — ${detail}` : ""
				stderr.write(`  [${phase}]${suffix}\n`)
			},
		})
		const verb = result.created ? "Built" : "Already present"
		stderr.write(
			`${verb}: place_search has ${result.indexedRows.toLocaleString()} rows ` +
				`(${(result.durationMs / 1000).toFixed(2)}s)\n`
		)
		return 0
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		stderr.write(`mailwoman-wof-build-fts: ${message}\n`)
		return 1
	} finally {
		db.close()
	}
}

// Entry point — only run when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
	exit(main(process.argv.slice(2)))
}
