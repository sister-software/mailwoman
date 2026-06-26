#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-timezone` — build the polygon DB, or look up a coordinate's IANA timezone.
 *
 *   Mailwoman-timezone build --geojson combined-with-oceans.json --out timezone.db mailwoman-timezone
 *   --db timezone.db 40.7128 -74.0060
 */

import { parseArgs } from "node:util"
import { buildTimezoneDb } from "./build.js"
import { offsetSecForTimezone, TimezoneLookup } from "./index.js"

if (process.argv[2] === "build") {
	const { values } = parseArgs({
		args: process.argv.slice(3),
		options: { geojson: { type: "string" }, out: { type: "string" } },
	})
	if (!values.geojson || !values.out) {
		console.error("Usage: mailwoman-timezone build --geojson <path> --out <db>")
		process.exit(1)
	}
	const { features } = buildTimezoneDb(values.geojson, values.out)
	console.error(`built ${values.out} (${features} features)`)
} else {
	// Hand-parse so negative longitudes (which look like options to parseArgs) work as positionals.
	const args = process.argv.slice(2)
	let databasePath: string | undefined
	const coords: number[] = []
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--db") databasePath = args[++i]
		else {
			const n = Number(args[i])
			if (Number.isFinite(n)) coords.push(n)
		}
	}
	const lat = coords[0]
	const lon = coords[1]
	if (!databasePath || lat == null || lon == null) {
		console.error("Usage: mailwoman-timezone --db <db> <lat> <lon>")
		process.exit(1)
	}
	const lookup = new TimezoneLookup({ databasePath })
	const tzid = lookup.find(lat, lon)
	console.log(JSON.stringify({ timezone: tzid, offsetSec: tzid ? offsetSecForTimezone(tzid) : null }))
	lookup.close()
}
