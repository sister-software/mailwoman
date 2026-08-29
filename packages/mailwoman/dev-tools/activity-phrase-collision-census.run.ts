/**
 * Report-only phrase-collision census for `@mailwoman/activity-lexicon` (#1962). Not a release check.
 *
 * Runs every declared surface form — and every candidate subject `matchPOISubject` would meet it through — against the
 * committed POI category lexicon and the POI name lexicon in a sealed `poi.db`, and classifies each colliding venue
 * name as query-shaped or legitimate. The committed report is
 * `packages/mailwoman/eval-harness/activity-lexicon/collision-census.json`; regenerate it whenever the lexicon or the
 * database moves.
 *
 * ```bash
 * node packages/mailwoman/dev-tools/activity-phrase-collision-census.run.ts \
 *   --out packages/mailwoman/eval-harness/activity-lexicon/collision-census.json
 * ```
 *
 * Expect roughly eleven minutes on the shipped `poi.db`. The venue read is a `LIKE` over every `name_key`, which no
 * index can answer, and the cost scales with probes × rows: 19 probes over 13.68M names. Reaching for a ranked FTS read
 * instead is what makes it fast and what makes it wrong — see `CensusPOIReader`.
 */

import { dataRootPath } from "@mailwoman/core/utils"
import { writeFileSync } from "@mailwoman/platform/fs"
import { parseArgs } from "@mailwoman/platform/util"
import { POILookup } from "@mailwoman/resolver-wof-sqlite/poi-lookup"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import {
	type CensusVenue,
	printPhraseCollisionCensus,
	runPhraseCollisionCensus,
} from "../eval-harness/activity-lexicon/phrase-collision-census.ts"
import { createPOINameLookup } from "../poi-intent.ts"

const { values } = parseArgs({ options: { db: { type: "string" }, out: { type: "string" } } })

const databasePath = values.db ?? String(dataRootPath("poi", "poi.db"))
using database = new DatabaseClient<POIDatabase>(databasePath, { readOnly: true })
using lookup = new POILookup({ database })
const shippedRung = createPOINameLookup(lookup)

// A complete key scan rather than a ranked read — see `CensusPOIReader` for the measurement that made the ranked one
// inadmissible. `LIKE` is a superset filter; the census applies whole-token containment to what comes back. One scan
// for the whole probe set: the predicate is unindexable either way, so the cost is the 13.68M-row pass, not the
// number of terms in it.
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

printPhraseCollisionCensus(census)

if (values.out) {
	writeFileSync(values.out, `${JSON.stringify(census, null, "\t")}\n`)

	console.log(`\nwrote ${values.out}`)
}
