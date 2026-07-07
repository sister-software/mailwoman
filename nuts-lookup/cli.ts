#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-nuts` — build the NUTS polygon DB, or look up a coordinate's NUTS codes.
 *
 *   Mailwoman-nuts build --geojson NUTS_RG_03M_2021_4326.geojson --out nuts.db mailwoman-nuts --db
 *   nuts.db 52.52 13.405
 */

import { parseArgs } from "node:util"

import { buildNutsDB } from "./build.js"
import { NutsLookup } from "./index.js"

if (process.argv[2] === "build") {
	const { values } = parseArgs({
		args: process.argv.slice(3),
		options: { geojson: { type: "string" }, out: { type: "string" } },
	})

	if (!values.geojson || !values.out) {
		console.error("Usage: mailwoman-nuts build --geojson <path> --out <db>")
		process.exit(1)
	}
	const { regions } = buildNutsDB(values.geojson, values.out)
	console.error(`built ${values.out} (${regions} regions)`)
} else {
	// Hand-parse so negative coordinates work as positionals.
	const args = process.argv.slice(2)
	let databasePath: string | undefined
	const coords: number[] = []

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--db") {
			databasePath = args[++i]
		} else {
			const n = Number(args[i])

			if (Number.isFinite(n)) {
				coords.push(n)
			}
		}
	}
	const lat = coords[0]
	const lon = coords[1]

	if (!databasePath || lat == null || lon == null) {
		console.error("Usage: mailwoman-nuts --db <db> <lat> <lon>")
		process.exit(1)
	}
	const lookup = new NutsLookup({ databasePath })
	console.log(JSON.stringify({ nuts: lookup.find(lat, lon) }))
	lookup.close()
}
