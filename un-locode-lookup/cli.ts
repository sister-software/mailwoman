#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-un-locode` — build the lookup DB, or look up a UN/LOCODE by name or coordinate.
 *
 *   Mailwoman-un-locode build --csv code-list.csv --out un-locode.db mailwoman-un-locode --db
 *   un-locode.db --country US --name "New York" mailwoman-un-locode --db un-locode.db --near
 *   40.7128 -74.0060
 */

import { parseArgs } from "node:util"

import { cliArguments } from "@mailwoman/core/scripting/utils"

import { buildUnLocodeDB } from "./build.ts"
import { UnLocodeLookup } from "./index.ts"

const argvAll = cliArguments()

if (argvAll[0] === "build") {
	const { values } = parseArgs({
		args: argvAll.slice(1),
		options: { csv: { type: "string" }, out: { type: "string" } },
	})

	if (!values.csv || !values.out) {
		console.error("Usage: mailwoman-un-locode build --csv <code-list.csv> --out <db>")
		process.exit(1)
	}
	const { rows, withCoords } = buildUnLocodeDB(values.csv, values.out)
	console.error(`built ${values.out} (${rows} rows, ${withCoords} with coordinates)`)
} else {
	// Hand-parse so negative coordinates work as positionals.
	const args = argvAll
	let databasePath: string | undefined
	let country: string | undefined
	let name: string | undefined
	const near: number[] = []

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--db") {
			databasePath = args[++i]
		} else if (args[i] === "--country") {
			country = args[++i]
		} else if (args[i] === "--name") {
			name = args[++i]
		} else if (args[i] === "--near") continue
		else {
			const n = Number(args[i])

			if (Number.isFinite(n)) {
				near.push(n)
			}
		}
	}

	if (!databasePath) {
		console.error("Usage: mailwoman-un-locode --db <db> (--country CC --name NAME | --near <lat> <lon>)")
		process.exit(1)
	}
	const lookup = new UnLocodeLookup({ databasePath })
	let code: string | null = null

	if (country && name) {
		code = lookup.byName(country, name)
	} else if (near.length === 2) {
		code = lookup.nearest(near[0]!, near[1]!)
	}
	console.log(JSON.stringify({ unLocode: code }))
	lookup.close()
}
