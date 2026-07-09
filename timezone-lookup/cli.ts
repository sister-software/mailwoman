#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-timezone` — build the polygon DB, or look up a coordinate's IANA timezone.
 *
 *   ```sh
 *   mailwoman-timezone build --geojson combined-with-oceans.json --out timezone.db
 *   mailwoman-timezone --db timezone.db -- 40.7128 -74.0060
 *   ```
 *
 *   The `--` separates flags from coordinates so negative longitudes parse as positionals.
 */

import { parseArgs } from "node:util"

import { buildTimezoneDB } from "./build.ts"
import { offsetSecForTimezone, TimezoneLookup } from "./index.ts"

const { values, positionals } = parseArgs({
	options: {
		geojson: { type: "string" },
		out: { type: "string" },
		db: { type: "string" },
	},
	allowPositionals: true,
})

if (positionals[0] === "build") {
	if (!values.geojson || !values.out) {
		console.error("Usage: mailwoman-timezone build --geojson <path> --out <db>")
		process.exit(1)
	}
	const { features } = buildTimezoneDB(values.geojson, values.out)
	console.error(`built ${values.out} (${features} features)`)
} else {
	const lat = Number(positionals[0])
	const lon = Number(positionals[1])

	if (!values.db || !Number.isFinite(lat) || !Number.isFinite(lon)) {
		console.error("Usage: mailwoman-timezone --db <db> -- <lat> <lon>")
		process.exit(1)
	}
	const lookup = new TimezoneLookup({ databasePath: values.db })
	const tzid = lookup.find(lat, lon)
	console.log(JSON.stringify({ timezone: tzid, offsetSec: tzid ? offsetSecForTimezone(tzid) : null }))
	lookup.close()
}
