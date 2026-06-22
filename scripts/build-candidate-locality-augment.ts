/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #743/#193 — augment a candidate gazetteer with POSTAL LOCALITIES from the Overture addresses
 *   theme. The candidate table sources its localities from Overture DIVISIONS (formal admin units),
 *   but real addresses use postal localities. This was the first hypothesis for the FI hard-filter
 *   recall gap (#194/#762) — but it proved MARGINAL: with the correct key normalizer most postal
 *   localities are already present (FI coverage 74.4%, not the 52% a naïve `.lower()` suggested),
 *   and this fold added +141 FI localities with ZERO resolve-rate lift. The real FI gap was
 *   bilingual ALT-NAMES (see build-candidate-geonames-aliases.ts). This companion stays useful
 *   where a country's gap genuinely IS missing postal localities rather than alt-names.
 *
 *   This extracts the distinct deepest-`address_levels` value per country from the per-country
 *   Overture addresses parquet (the SAME source build-eu-eval-set.ts uses), with the address
 *   centroid + bbox + an address-count population proxy, and inserts the ones not already present
 *   as `locality` candidates. Operates on a COPY (never the canonical) so the gain can be measured
 *   via `oa-resolver-eval --candidate-db <copy> --place-country-hard-all` before any rebuild. Once
 *   the lift is confirmed the same fold belongs upstream in the unified-WOF build (spr rows) so the
 *   canonical candidate rebuild carries it.
 *
 *   Usage: node --experimental-strip-types scripts/build-candidate-locality-augment.ts\
 *   --src /mnt/playpen/mailwoman-data/wof/candidate-global-intl.db\
 *   --out /mnt/playpen/mailwoman-data/wof/candidate-aug-193.db\
 *   --overture-dir /mnt/playpen/mailwoman-data/overture/2026-06-17.0\
 *   --countries FI,PL [--min-addresses 3]
 */
import { DuckDBInstance } from "@duckdb/node-api"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { copyFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

const { values: a } = parseArgs({
	options: {
		src: { type: "string", default: "/mnt/playpen/mailwoman-data/wof/candidate-global-intl.db" },
		out: { type: "string", default: "/mnt/playpen/mailwoman-data/wof/candidate-aug-193.db" },
		"overture-dir": { type: "string", default: "/mnt/playpen/mailwoman-data/overture/2026-06-17.0" },
		countries: { type: "string", default: "FI,PL" },
		"min-addresses": { type: "string", default: "3" },
	},
})
const countries = a.countries!.split(",").map((c) => c.trim().toUpperCase())
const minAddr = Number(a["min-addresses"])

// Work on a COPY — never mutate the canonical gazetteer.
copyFileSync(a.src!, a.out!)
const db = new DatabaseSync(a.out!)

// Resolve the code-dict ids the candidate rows reference.
const ccId = new Map<string, number>()
for (const r of db.prepare("SELECT id, code FROM country_codes").all() as { id: number; code: string }[])
	ccId.set(r.code, r.id)
const ptRow = db.prepare("SELECT id FROM placetype_codes WHERE placetype = 'locality'").get() as
	| { id: number }
	| undefined
if (!ptRow) throw new Error("candidate DB has no 'locality' placetype code")
const localityPt = ptRow.id

const exists = db.prepare("SELECT 1 FROM candidate WHERE name_key = ? AND country_id = ? LIMIT 1")
// Column order MUST match CANDIDATE_COLUMNS (candidate-schema.ts).
const ins = db.prepare(
	`INSERT INTO candidate (name_key, country_id, region_id, placetype_id, neg_rank, spr_id, name,
		latitude, longitude, min_lat, min_lon, max_lat, max_lon, population, is_primary)
	 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
)

const duck = await (await DuckDBInstance.create()).connect()
await duck.run("SET memory_limit='4GB'; SET threads=4;")

// Synthetic spr ids well above any real WOF/Overture id so the placeId never collides.
let sprBase = 9_500_000_000_000
let totalIns = 0
let totalSkip = 0

for (const cc of countries) {
	const cid = ccId.get(cc)
	if (cid === undefined) {
		console.error(`  ${cc}: not in candidate country_codes — skipped`)
		continue
	}
	const parquet = `${a["overture-dir"]}/addresses-${cc.toLowerCase()}.parquet`
	// Distinct postal locality (deepest address_levels, postal_city fallback) with centroid + bbox + count.
	const q = `
		WITH src AS (
			SELECT COALESCE(NULLIF(trim(postal_city), ''), address_levels[len(address_levels)].value) AS loc, lat, lon
			FROM read_parquet('${parquet}')
			WHERE lat IS NOT NULL AND lon IS NOT NULL
		)
		SELECT loc, avg(lat) AS clat, avg(lon) AS clon,
			min(lat) AS mnlat, min(lon) AS mnlon, max(lat) AS mxlat, max(lon) AS mxlon, count(*) AS n
		FROM src WHERE loc IS NOT NULL AND trim(loc) <> ''
		GROUP BY loc HAVING count(*) >= ${minAddr}`
	let rows
	try {
		rows = (await duck.runAndReadAll(q)).getRowObjects()
	} catch (e) {
		console.error(`  ${cc}: FAILED — ${(e as Error).message}`)
		continue
	}
	let nIns = 0
	let nSkip = 0
	db.exec("BEGIN")
	for (const r of rows) {
		const name = String(r.loc)
		const key = normalizeLocalityForKey(name)
		if (!key) continue
		if (exists.get(key, cid)) {
			nSkip++
			continue
		}
		const n = Number(r.n)
		const neg = -Math.log10(n + 1)
		ins.run(
			key,
			cid,
			neg,
			sprBase++,
			name,
			Number(r.clat),
			Number(r.clon),
			Number(r.mnlat),
			Number(r.mnlon),
			Number(r.mxlat),
			Number(r.mxlon),
			n
		)
		nIns++
	}
	db.exec("COMMIT")
	console.log(`  ${cc}: +${nIns} localities inserted, ${nSkip} already present (${rows.length} distinct in Overture)`)
	totalIns += nIns
	totalSkip += nSkip
}
duck.closeSync()
db.exec("ANALYZE candidate")
db.close()
console.log(
	`\n→ ${a.out}: +${totalIns} localities (${totalSkip} already present). Validate with --candidate-db ${a.out}`
)
