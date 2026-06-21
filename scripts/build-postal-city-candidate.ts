/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the POSTAL-CITY CANDIDATE side-index (#741 / #475) INTO a candidate gazetteer so the
 *   candidate-backend resolver (the demo/CLI default) can resolve a user-typed postal city to its
 *   geographic locality. Adds one table, `postal_city_candidate(name_key, postcode → spr_id, …)`,
 *   keyed exactly by `(name_key, postcode)`.
 *
 *   Bridge (no admin-DB join): for each DIVERGENT `(postcode, postal_city)` in the alias DB, the
 *   `postcode_locality` shard gives the postcode's CONTAINING `locality_id`; that locality's coord
 *   + name come straight from the candidate table's own row for that `spr_id`. So a postal-city
 *   query with the postcode resolves to exactly the geographic locality the FTS coordinate-first
 *   path would pick — but via one exact probe, no population/region ranking.
 *
 *   Idempotent: drops + recreates the table each run. Modifies the candidate DB IN PLACE — run it on
 *   a COPY to validate, then fold it into the canonical candidate build before republish.
 *
 *   Usage: node --experimental-strip-types scripts/build-postal-city-candidate.ts\
 *   --candidate-db /path/to/candidate.db\
 *   --alias-db /mnt/playpen/mailwoman-data/wof/postal-city-alias-us.db\
 *   --postcode-locality-db /mnt/playpen/mailwoman-data/wof/postcode-locality-us.db
 */

import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"
import {
	POSTAL_CITY_CANDIDATE_COLUMNS,
	POSTAL_CITY_CANDIDATE_DDL,
	POSTAL_CITY_CANDIDATE_TABLE,
} from "../resolver-wof-sqlite/postal-city-candidate-schema.ts"
import { normalizeLocalityForKey } from "../resolver-wof-sqlite/street-normalize.ts"

const { values: a } = parseArgs({
	options: {
		"candidate-db": { type: "string" },
		"alias-db": { type: "string", default: "/mnt/playpen/mailwoman-data/wof/postal-city-alias-us.db" },
		"postcode-locality-db": { type: "string", default: "/mnt/playpen/mailwoman-data/wof/postcode-locality-us.db" },
	},
})
if (!a["candidate-db"]) throw new Error("--candidate-db is required (modified in place — run on a copy first)")

const db = new DatabaseSync(a["candidate-db"]!)

// postcode → containing locality_id (the geo-locality the postcode sits in).
const pcl = new DatabaseSync(a["postcode-locality-db"]!, { readOnly: true })
const pcToLocality = new Map<string, number>()
for (const r of pcl
	.prepare("SELECT postcode, locality_id FROM postcode_locality WHERE is_containing = 1")
	.all() as unknown as Array<{ postcode: string; locality_id: number }>) {
	// First containing locality per postcode wins (postcodes with one containing polygon — the norm).
	if (!pcToLocality.has(String(r.postcode))) pcToLocality.set(String(r.postcode), Number(r.locality_id))
}
pcl.close()

// spr_id → {name, lat, lon} from the candidate table's own rows (the coord bridge).
const sprToPlace = new Map<number, { name: string; lat: number; lon: number }>()
for (const r of db
	.prepare("SELECT spr_id, name, latitude AS lat, longitude AS lon FROM candidate WHERE latitude IS NOT NULL")
	.all() as unknown as Array<{ spr_id: number; name: string | null; lat: number; lon: number }>) {
	if (!sprToPlace.has(Number(r.spr_id))) {
		sprToPlace.set(Number(r.spr_id), { name: String(r.name ?? ""), lat: Number(r.lat), lon: Number(r.lon) })
	}
}

// Divergent postal-city edges.
const alias = new DatabaseSync(a["alias-db"]!, { readOnly: true })
const edges = alias
	.prepare("SELECT postcode, postal_city FROM postal_city_alias WHERE divergent = 1")
	.all() as unknown as Array<{ postcode: string; postal_city: string }>
alias.close()

db.exec(`DROP TABLE IF EXISTS ${POSTAL_CITY_CANDIDATE_TABLE};${POSTAL_CITY_CANDIDATE_DDL}`)
const insert = db.prepare(
	`INSERT OR IGNORE INTO ${POSTAL_CITY_CANDIDATE_TABLE} (${POSTAL_CITY_CANDIDATE_COLUMNS.join(", ")})
	 VALUES (${POSTAL_CITY_CANDIDATE_COLUMNS.map(() => "?").join(", ")})`
)

let inserted = 0
let noLocality = 0
let noCoord = 0
db.exec("BEGIN")
for (const e of edges) {
	const localityId = pcToLocality.get(String(e.postcode))
	if (localityId === undefined) {
		noLocality++
		continue
	}
	const place = sprToPlace.get(localityId)
	if (!place) {
		noCoord++
		continue
	}
	const key = normalizeLocalityForKey(e.postal_city)
	if (!key) continue
	insert.run(key, String(e.postcode), localityId, place.name, place.lat, place.lon)
	inserted++
}
db.exec("COMMIT")
db.exec(`CREATE INDEX IF NOT EXISTS idx_pcc_spr ON ${POSTAL_CITY_CANDIDATE_TABLE} (spr_id);`)
db.close()

console.log(
	`postal_city_candidate built: ${inserted} edges inserted ` +
		`(${noLocality} skipped — postcode has no containing locality in the postcode_locality shard; ` +
		`${noCoord} skipped — locality not in candidate table) → ${a["candidate-db"]}`
)
