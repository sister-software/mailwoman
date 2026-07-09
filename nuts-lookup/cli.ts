#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-nuts` — build the NUTS polygon DB, or look up a coordinate's NUTS codes.
 *
 *   ```sh
 *   mailwoman-nuts build --geojson NUTS_RG_03M_2021_4326.geojson --out nuts.db
 *   mailwoman-nuts --db nuts.db -- 52.52 13.405
 *   ```
 *
 *   The `--` separates flags from coordinates so negative coordinates parse as positionals.
 */

import { parseArgs } from "node:util"

import { buildNutsDB } from "./build.ts"
import { NutsLookup } from "./index.ts"

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
		console.error("Usage: mailwoman-nuts build --geojson <path> --out <db>")
		process.exit(1)
	}
	const { regions } = buildNutsDB(values.geojson, values.out)
	console.error(`built ${values.out} (${regions} regions)`)
} else {
	const lat = Number(positionals[0])
	const lon = Number(positionals[1])

	if (!values.db || !Number.isFinite(lat) || !Number.isFinite(lon)) {
		console.error("Usage: mailwoman-nuts --db <db> -- <lat> <lon>")
		process.exit(1)
	}
	const lookup = new NutsLookup({ databasePath: values.db })
	console.log(JSON.stringify({ nuts: lookup.find(lat, lon) }))
	lookup.close()
}
