import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coordinate probe for a candidate-gazetteer postcode-coverage experiment: for a country's OA
 *   holdout, resolve each row's POSTCODE and its LOCALITY against the candidate table and grade
 *   BOTH coordinates against the rooftop truth. Answers "does adding this country's postcodes beat
 *   the locality-centroid path on the assembled coordinate?" — grade the coordinate, not the name.
 *
 *   Run: node --experimental-strip-types scripts/eval/postcode-vs-locality-probe.ts\
 *   --db <candidate.db> --eval /tmp/reg/eu-eval-at.jsonl --country AT
 */
import { haversineKm } from "@mailwoman/spatial"

import { normalizeLocalityForKey, stripLocalityQualifier } from "../../resolver-wof-sqlite/street-normalize.ts"

const { values: a } = parseArgs({
	options: { db: { type: "string" }, eval: { type: "string" }, country: { type: "string" } },
})

if (!a.db || !a.eval || !a.country) {
	console.error("--db, --eval, --country required")
	process.exit(1)
}
const CC = a.country.toUpperCase()

function pct(xs: number[], p: number): number {
	if (!xs.length) return NaN
	const s = [...xs].sort((x, y) => x - y)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

const db = new DatabaseSync(a.db, { readOnly: true })
const ccId = (db.prepare("SELECT id FROM country_codes WHERE code=?").get(CC) as { id?: number } | undefined)?.id
const ptId = (pt: string) =>
	(db.prepare("SELECT id FROM placetype_codes WHERE placetype=?").get(pt) as { id?: number } | undefined)?.id
const LOC_PTS = ["locality", "localadmin", "borough"].map(ptId).filter((v): v is number => v !== undefined)
const PC_PT = ptId("postalcode")

const q = db.prepare(
	`SELECT latitude AS lat, longitude AS lon FROM candidate WHERE name_key=? AND country_id=? AND placetype_id IN (SELECT value FROM json_each(?)) ORDER BY neg_rank ASC LIMIT 1`
)
const resolve = (key: string, pts: number[]): { lat: number; lon: number } | undefined => {
	if (ccId === undefined || !key) return undefined

	return q.get(key, ccId, JSON.stringify(pts)) as { lat: number; lon: number } | undefined
}

const pcErr: number[] = []
const locErr: number[] = []
let n = 0,
	pcHit = 0,
	locHit = 0

for (const line of readFileSync(a.eval, "utf8").trim().split("\n")) {
	if (!line) continue
	const r = JSON.parse(line) as { lat: number; lon: number; expected?: { locality?: string; postcode?: string } }

	if (typeof r.lat !== "number" || typeof r.lon !== "number") continue
	n++
	const pc = r.expected?.postcode

	if (pc && PC_PT !== undefined) {
		const hit = resolve(normalizeLocalityForKey(pc), [PC_PT])

		if (hit) {
			pcHit++
			pcErr.push(haversineKm(hit.lat, hit.lon, r.lat, r.lon))
		}
	}
	const loc = r.expected?.locality

	if (loc) {
		let hit = resolve(normalizeLocalityForKey(loc), LOC_PTS)

		if (!hit) {
			const s = normalizeLocalityForKey(stripLocalityQualifier(loc))

			if (s) hit = resolve(s, LOC_PTS)
		}

		if (hit) {
			locHit++
			locErr.push(haversineKm(hit.lat, hit.lon, r.lat, r.lon))
		}
	}
}
db.close()

const fmt = (xs: number[]) =>
	`p50 ${pct(xs, 50).toFixed(1)}km  mean ${(xs.reduce((s, x) => s + x, 0) / (xs.length || 1)).toFixed(1)}km`
console.log(`\n${CC} candidate coordinate: postcode-path vs locality-path (n=${n}, db ${a.db})\n`)
console.log(`  postcode path: resolve ${((100 * pcHit) / n).toFixed(1)}% (${pcHit}/${n})   ${fmt(pcErr)}`)
console.log(`  locality path: resolve ${((100 * locHit) / n).toFixed(1)}% (${locHit}/${n})   ${fmt(locErr)}`)
console.log(
	`\n  → postcode is ${pct(pcErr, 50) < pct(locErr, 50) ? "MORE" : "NOT more"} precise (p50 ${pct(pcErr, 50).toFixed(1)} vs ${pct(locErr, 50).toFixed(1)} km)\n`
)
