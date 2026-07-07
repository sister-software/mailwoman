#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-wof-build-coincident-roles <path-to-admin.db>... [--drop]`
 *
 *   Operator-side one-shot CLI (#403, epic #402): derives the `coincident_roles` relation into an
 *   existing admin gazetteer — the dual-role places (city-states, capital-seat provinces,
 *   consolidated city-counties) the hierarchy-completion step (#405) consults. Additive +
 *   idempotent; re-run after refreshing `spr`/`ancestors`. Mirrors `build-fts-cli.ts`. Should also
 *   be invoked as a post-step of the main `scripts/build-unified-wof.ts`.
 */

import { existsSync } from "node:fs"
import { exit, stderr } from "node:process"
import { DatabaseSync } from "node:sqlite"

import { cliArguments, runIfScript } from "@mailwoman/core/utils"

import { buildCoincidentRoles } from "./coincident-roles.js"

function printUsageAndExit(code: number): never {
	stderr.write(
		[
			"usage: mailwoman-wof-build-coincident-roles <path-to-admin.db>... [--drop]",
			"",
			"Derives the coincident_roles relation (dual-role places — city-states, capital-seat",
			"provinces, consolidated city-counties) into one or more admin gazetteers. The",
			"hierarchy-completion resolver step (#405) consults it. Additive + idempotent.",
			"",
			"  --drop   Drop and rebuild coincident_roles if it already exists (default: rebuild).",
			"",
			"Example:",
			"  mailwoman-wof-build-coincident-roles /data/wof/admin-global-priority.db",
			"",
		].join("\n")
	)
	exit(code)
}

function buildOne(path: string, drop: boolean): number {
	if (!existsSync(path)) {
		stderr.write(`mailwoman-wof-build-coincident-roles: file not found: ${path}\n`)

		return 1
	}
	stderr.write(`Opening ${path}…\n`)
	const db = new DatabaseSync(path)

	try {
		const result = buildCoincidentRoles(db, {
			drop,
			onProgress: (phase, detail) => stderr.write(`  [${phase}]${detail ? ` — ${detail}` : ""}\n`),
		})
		const top = Object.entries(result.byCountry)
			.sort((a, b) => b[1] - a[1])
			.map(([cc, n]) => `${cc} ${n}`)
			.join(", ")
		stderr.write(
			`Built: ${result.rowCount} coincident-role rows (${(result.durationMs / 1000).toFixed(2)}s)\n  by country: ${top}\n`
		)

		return 0
	} catch (err) {
		stderr.write(`mailwoman-wof-build-coincident-roles: ${err instanceof Error ? err.message : String(err)}\n`)

		return 1
	} finally {
		db.close()
	}
}

export function main(argv: readonly string[]): number {
	const paths: string[] = []
	// The relation is a cheap (~2 s) derived table that must reflect the current spr/ancestors, so it
	// rebuilds by default (idempotent). `--no-drop` appends instead — only useful for incremental tests.
	let drop = true

	for (const a of argv) {
		if (a === "--drop") {
			drop = true
		} else if (a === "--no-drop") {
			drop = false
		} else if (a === "--help" || a === "-h") {
			printUsageAndExit(0)
		} else if (a.startsWith("-")) {
			stderr.write(`mailwoman-wof-build-coincident-roles: unknown flag ${JSON.stringify(a)}\n`)
			printUsageAndExit(2)
		} else {
			paths.push(a)
		}
	}

	if (paths.length === 0) {
		printUsageAndExit(2)
	}
	let worst = 0

	for (const path of paths) {
		const rc = buildOne(path, drop)

		if (rc > worst) {
			worst = rc
		}
	}

	return worst
}

void runIfScript(import.meta, () => exit(main(cliArguments())))
