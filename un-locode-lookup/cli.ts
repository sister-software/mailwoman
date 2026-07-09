#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-un-locode` — build the lookup DB, or look up a UN/LOCODE by name or coordinate.
 *
 *   ```sh
 *   mailwoman-un-locode build --csv code-list.csv --out un-locode.db
 *   mailwoman-un-locode --db un-locode.db --country US --name "New York"
 *   mailwoman-un-locode --db un-locode.db -- 40.7128 -74.0060
 *   ```
 *
 *   The `--` separates flags from coordinates so negative coordinates parse as positionals (the
 *   coordinate form is the nearest-code lookup, formerly `--near`).
 */

import { parseArgs } from "node:util"

import { buildUnLocodeDB } from "./build.ts"
import { UnLocodeLookup } from "./index.ts"

const { values, positionals } = parseArgs({
	options: {
		csv: { type: "string" },
		out: { type: "string" },
		db: { type: "string" },
		country: { type: "string" },
		name: { type: "string" },
	},
	allowPositionals: true,
})

if (positionals[0] === "build") {
	if (!values.csv || !values.out) {
		console.error("Usage: mailwoman-un-locode build --csv <code-list.csv> --out <db>")
		process.exit(1)
	}
	const { rows, withCoords } = buildUnLocodeDB(values.csv, values.out)
	console.error(`built ${values.out} (${rows} rows, ${withCoords} with coordinates)`)
} else {
	const lat = Number(positionals[0])
	const lon = Number(positionals[1])
	const byName = Boolean(values.country && values.name)
	const byCoord = Number.isFinite(lat) && Number.isFinite(lon)

	if (!values.db || (!byName && !byCoord)) {
		console.error("Usage: mailwoman-un-locode --db <db> (--country CC --name NAME | -- <lat> <lon>)")
		process.exit(1)
	}
	const lookup = new UnLocodeLookup({ databasePath: values.db })
	const code = byName ? lookup.byName(values.country!, values.name!) : lookup.nearest(lat, lon)
	console.log(JSON.stringify({ unLocode: code }))
	lookup.close()
}
