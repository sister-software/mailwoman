#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-wof-build-fts <path-to-wof.db>... [--drop]`
 *
 *   Operator-side one-shot CLI: takes one or more Who's On First SQLite distributions and adds the
 *   `place_search` FTS5 + `place_bbox` R*Tree virtual tables needed by `WOFSqlitePlaceLookup`. Run
 *   this once per downloaded WOF shard so production callers can skip the (~minutes-long) lazy
 *   build.
 *
 *   Multiple positional args process each DB in sequence — useful when you've just pulled the admin +
 *   postcode shards in one go.
 *
 *   Why a plain-args CLI rather than Ink / Pastel: this is a one-shot operator script, not an
 *   interactive TUI. The dep weight of inkjs / pastel would dominate the script's footprint and
 *   doesn't match how operators expect to drive a build step (`script /path/to/db` + stderr
 *   progress). Matches the spirit of `corpus/scripts/*.ts`.
 */

import { existsSync } from "node:fs"
import { exit, stderr } from "node:process"
import { DatabaseSync } from "node:sqlite"

import { cliArguments, runIfScript } from "@mailwoman/core/utils"

import { buildPlaceSearchFTS } from "./fts.js"

interface CLIArgs {
	databasePaths: string[]
	drop: boolean
}

function printUsageAndExit(code: number): never {
	stderr.write(
		[
			"usage: mailwoman-wof-build-fts <path-to-wof.db>... [--drop]",
			"",
			"Builds the place_search FTS5 + place_bbox R*Tree virtual tables in one or more",
			"Who's On First SQLite distributions. Run this once per downloaded WOF shard so",
			"production WOFSqlitePlaceLookup instances skip the lazy-build cost at first open.",
			"",
			"  --drop   Drop and rebuild place_search + place_bbox if they already exist.",
			"           Apply after refreshing the spr / names tables from a newer dump.",
			"",
			"Examples:",
			"  mailwoman-wof-build-fts /data/wof/admin-us.db",
			"  mailwoman-wof-build-fts /data/wof/admin-us.db /data/wof/postalcode-us.db",
			"  mailwoman-wof-build-fts /data/wof/admin-us.db --drop",
			"",
			"See https://github.com/sister-software/mailwoman/tree/main/resolver-wof-sqlite for",
			"the recommended WOF distribution sources + attribution requirements.",
			"",
		].join("\n")
	)
	exit(code)
}

function parseArgs(argv: readonly string[]): CLIArgs {
	const args: string[] = []
	let drop = false

	for (const a of argv) {
		if (a === "--drop") {
			drop = true
		} else if (a === "--help" || a === "-h") {
			printUsageAndExit(0)
		} else if (a.startsWith("-")) {
			stderr.write(`mailwoman-wof-build-fts: unknown flag ${JSON.stringify(a)}\n`)
			printUsageAndExit(2)
		} else {
			args.push(a)
		}
	}

	if (args.length === 0) {
		stderr.write(`mailwoman-wof-build-fts: expected at least one positional arg\n`)
		printUsageAndExit(2)
	}

	return { databasePaths: args, drop }
}

/**
 * Build indexes on a single DB. Returns 0 on success, 1 on failure. Errors are written to stderr but the call doesn't
 * throw — `main()` aggregates the exit code across multi-DB invocations.
 */
function buildOne(path: string, drop: boolean): number {
	if (!existsSync(path)) {
		stderr.write(`mailwoman-wof-build-fts: file not found: ${path}\n`)

		return 1
	}
	stderr.write(`Opening ${path}…\n`)
	const db = new DatabaseSync(path)

	try {
		const result = buildPlaceSearchFTS(db, {
			drop,
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

export function main(argv: readonly string[]): number {
	const args = parseArgs(argv)
	// Process every DB; if any fail, the worst exit code wins (so CI / scripts see failure).
	let worst = 0

	for (const path of args.databasePaths) {
		const rc = buildOne(path, args.drop)

		if (rc > worst) {
			worst = rc
		}
	}

	return worst
}

// Entry point — only run when invoked directly, not when imported by tests.
void runIfScript(import.meta, () => exit(main(cliArguments())))
