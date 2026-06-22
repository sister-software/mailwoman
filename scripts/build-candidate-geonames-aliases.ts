/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #743/#193 — fold GeoNames bilingual / alternate place-names into a candidate gazetteer as
 *   ALIASES. The candidate table's hard-filter recall gap on bilingual countries (Finland: hard FI
 *   resolves only 69.5%) is NOT missing places — it's missing alt-language NAMES. The place is
 *   present under one language (Swedish "Karis") but the address uses the other (Finnish "Karjaa"),
 *   and the unified-WOF `names` only carried the primary, so the candidate alias path had nothing
 *   to explode. GeoNames' per-country dump carries the variants inline (the Karis row's
 *   `alternatenames` includes "Karjaa").
 *
 *   This reads a GeoNames country dump (`FI.txt`-style TSV), and for every POPULATED place (feature
 *   class `P`) inserts each Latin alt-name not already present as a `locality` candidate pointing
 *   at that place's own coordinate/population — so a query in either language resolves to the same
 *   point. Operates on a COPY to prove the resolve-rate lift via `oa-resolver-eval --candidate-db
 *   <copy> --place-country-hard-all` BEFORE any canonical rebuild; the durable fix is to fold the
 *   same alt-names into the unified-WOF `names` upstream.
 *
 *   Usage: node --experimental-strip-types scripts/build-candidate-geonames-aliases.ts\
 *   --src /mnt/playpen/mailwoman-data/wof/candidate-global-intl.db\
 *   --out /mnt/playpen/mailwoman-data/wof/candidate-aug-193.db\
 *   --geonames /mnt/playpen/mailwoman-data/geonames/FI.txt --country FI
 */
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { copyFileSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

const { values: a } = parseArgs({
	options: {
		src: { type: "string", default: "/mnt/playpen/mailwoman-data/wof/candidate-global-intl.db" },
		out: { type: "string", default: "/mnt/playpen/mailwoman-data/wof/candidate-aug-193.db" },
		geonames: { type: "string" },
		country: { type: "string", default: "FI" },
		"min-pop": { type: "string", default: "0" },
	},
})
if (!a.geonames) throw new Error("--geonames <country dump TSV> is required")
const cc = a.country!.toUpperCase()
const minPop = Number(a["min-pop"])

// Latin-only, no bracket/paren noise (GeoNames packs things like "(( Karis Landskommun ))" + airport
// codes into alternatenames), 2–60 chars, not a postcode/number.
const LATIN_NAME = /^[\p{Script=Latin}\p{M}\s\-'.]{2,60}$/u
const cleanName = (s: string): string | null => {
	const t = s.trim()
	if (!t || !LATIN_NAME.test(t)) return null
	if (!/\p{L}/u.test(t)) return null
	return t
}

copyFileSync(a.src!, a.out!)
const db = new DatabaseSync(a.out!)
const ccRow = db.prepare("SELECT id FROM country_codes WHERE code = ?").get(cc) as { id: number } | undefined
if (!ccRow) throw new Error(`candidate DB has no country code ${cc}`)
const cid = ccRow.id
const localityPt = (db.prepare("SELECT id FROM placetype_codes WHERE placetype = 'locality'").get() as { id: number })
	.id
const exists = db.prepare("SELECT 1 FROM candidate WHERE name_key = ? AND country_id = ? LIMIT 1")
const ins = db.prepare(
	`INSERT INTO candidate (name_key, country_id, region_id, placetype_id, neg_rank, spr_id, name,
		latitude, longitude, min_lat, min_lon, max_lat, max_lon, population, is_primary)
	 VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
)

let sprBase = 9_600_000_000_000
let nIns = 0
let nSkip = 0
let nPlaces = 0
const insertedKeys = new Set<string>() // de-dupe within this run too

db.exec("BEGIN")
for (const line of readFileSync(a.geonames!, "utf8").split("\n")) {
	if (!line) continue
	// GeoNames dump columns: 1 name, 2 asciiname, 3 alternatenames, 4 lat, 5 lon, 6 feature_class, 14 pop
	const f = line.split("\t")
	if (f[6] !== "P") continue // populated places only
	const lat = Number(f[4])
	const lon = Number(f[5])
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
	const pop = Number(f[14]) || 0
	if (pop < minPop) continue
	nPlaces++
	const names = [f[1], f[2], ...(f[3] ? f[3].split(",") : [])]
	const neg = -Math.log10(pop + 1)
	for (const raw of names) {
		const name = cleanName(raw)
		if (!name) continue
		const key = normalizeLocalityForKey(name)
		if (!key || insertedKeys.has(key) || exists.get(key, cid)) {
			if (key && exists.get(key, cid)) nSkip++
			continue
		}
		insertedKeys.add(key)
		ins.run(key, cid, localityPt, neg, sprBase++, name, lat, lon, lat, lon, lat, lon, pop)
		nIns++
	}
}
db.exec("COMMIT")
db.exec("ANALYZE candidate")
db.close()
console.log(
	`${cc}: scanned ${nPlaces} populated places; +${nIns} alias localities inserted, ${nSkip} names already present`
)
console.log(`→ ${a.out}: validate with  --candidate-db ${a.out} --place-country-hard-all`)
