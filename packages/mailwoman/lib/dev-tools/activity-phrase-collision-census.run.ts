/**
 * Report-only phrase-collision census for `@mailwoman/activity-lexicon`.
 *
 * Not a release check.
 *
 * Runs every declared surface form.
 * It checks every candidate subject `matchPOISubject` would meet it through, against the
 * committed POI category lexicon and the POI name lexicon in a sealed `poi.db`.
 *
 * It classifies each colliding venue name as query-shaped or legitimate.
 * The committed report is `packages/mailwoman/lib/eval-harness/activity-lexicon/collision-census.json`.
 * Regenerate it whenever the lexicon or the database moves.
 *
 * ```bash
 * node packages/mailwoman/lib/dev-tools/activity-phrase-collision-census.run.ts \ --out packages/mailwoman/lib/eval-harness/activity-lexicon/collision-census.json
 * ```
 *
 * Expect roughly eleven minutes on the shipped `poi.db`.
 * The venue read uses `like` over every `name_key`.
 *
 * No index can answer that query.
 * Cost scales with the probes and rows: 19 probes over 13.68M names.
 *
 * Reaching for a ranked FTS read instead makes it fast and makes it wrong.
 * See `CensusPOIReader`.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { poiDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { POILookup } from "@mailwoman/resolver-wof-sqlite/poi"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import {
	type CensusVenue,
	printPhraseCollisionCensus,
	runPhraseCollisionCensus,
} from "#eval-harness/activity-lexicon/phrase-collision-census"
import { createPOINameLookup } from "#poi/intent"

const { values } = parseArguments({ options: { db: { type: "string" }, out: { type: "string" } } })

const databasePath = values.db ?? poiDatabasePath("poi.db")
using database = new DatabaseClient<POIDatabase>(databasePath, { readOnly: true })
using lookup = new POILookup({ database })
const shippedRung = createPOINameLookup(lookup)

// A complete key scan.
// See `CensusPOIReader` for why the ranked read is inadmissible.
// `like` is a superset filter.
// The census applies whole-token containment to the results.
// One scan covers the whole probe set, because the predicate is unindexable either way,
// so the cost is the 13.68M-row pass.
function candidates(probes: ReadonlyArray<string>): CensusVenue[] {
	if (!probes.length) return []

	const predicate = probes.map(() => "p.name_key LIKE ?").join(" OR ")

	const statement = database.prepare(
		"SELECT DISTINCT p.name AS name, p.country AS country, c.category AS category " +
			`FROM poi p LEFT JOIN poi_category_codes c ON c.id = p.category_id WHERE ${predicate}`
	)

	return statement.all(...probes.map((probe) => `%${probe}%`)).map((row): CensusVenue => ({
		name: String(row.name ?? ""),
		categoryID: row.category === null || row.category === undefined ? null : String(row.category),
		country: String(row.country ?? ""),
	}))
}

const census = runPhraseCollisionCensus({
	databasePath,
	reader: { candidates, claimedByShippedRung: (probe) => shippedRung(probe).length > 0 },
})

printPhraseCollisionCensus(await census)

if (values.out) {
	await writeLocalJSONFile(census, values.out)

	console.log(`\nwrote ${values.out}`)
}
