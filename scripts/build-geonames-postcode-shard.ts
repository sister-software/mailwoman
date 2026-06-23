/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a postcode → point shard from GeoNames postal data, for countries WhosOnFirst does not
 *   cover (#193). The existing pipeline (`scripts/backfill-postcode-centroids.ts`) treats GeoNames as
 *   a COORDINATE source keyed by string onto WOF-sourced postcode *records*. That works wherever WOF
 *   ships the postcode entities (US/NL/FR/DE/IT/ES…). For PL/CZ/PT/AU and the rest of the #193 gap,
 *   WOF has zero postcode records — there's nothing to backfill onto — so GeoNames must supply the
 *   RECORD too, not just the coordinate.
 *
 *   This emits a standalone `spr` shard in the exact schema `build-candidate`'s `--postcodes` pass
 *   consumes (placetype='postalcode', real centroid + bbox), so it drops into a candidate rebuild
 *   alongside `postalcode-intl.db` with no other change:
 *
 *     build-candidate ... --postcodes postalcode-intl.db --postcodes <this shard>
 *
 *   Provenance: GeoNames postal is CC-BY 4.0 — any DB shipping these coordinates must attribute
 *   "GeoNames (CC-BY 4.0)". These records carry NO WOF id (GeoNames is the source, not just the
 *   coordinate), so they get synthetic ids in a high range (`SYNTH_ID_BASE`, well above WOF's
 *   ~907M ceiling) that can never be mistaken for — or collide with — a WOF entity id. This keeps
 *   the eval-WOF-id integrity rule intact for the WOF-sourced countries while filling the gap.
 *
 *   Separator variants: a postcode is stored under BOTH its written forms so the candidate name_key
 *   matches whichever form the parse emits — PL writes "26-300" (hyphen), CZ writes "58001" (no
 *   space) though GeoNames stores "580 01". Each distinct `fold()`-form gets its own row (same
 *   coordinate), so the lookup hits regardless of how the address spelled the code.
 *
 *   Optionally folds the shard straight into a COPY of an existing candidate gazetteer
 *   (`--fold-into <src> --fold-out <dst>`), mirroring `build-candidate` pass-4's row construction, so
 *   a demo-ready DB falls out without a full (heavy) rebuild. The shard itself is the durable artifact
 *   for the canonical rebuild; the fold is the fast path to verify + stage.
 *
 *   Usage:
 *     node --experimental-strip-types scripts/build-geonames-postcode-shard.ts \
 *       --geonames /mnt/playpen/mailwoman-data/geonames/allCountries-postal.txt \
 *       --countries PL,CZ \
 *       --out /mnt/playpen/mailwoman-data/wof/postalcode-geonames-intl.db \
 *       [--fold-into /mnt/playpen/mailwoman-data/wof/candidate-global-20h.db \
 *        --fold-out  /mnt/playpen/mailwoman-data/wof/candidate-global-20i.db]
 */

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { copyFileSync, createReadStream, existsSync } from "node:fs"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"

interface Args {
	geonames: string
	countries: string[]
	out: string
	foldInto?: string
	foldOut?: string
}

function parseArgs(): Args {
	const a = process.argv.slice(2)
	let geonames = "/mnt/playpen/mailwoman-data/geonames/allCountries-postal.txt"
	let countries = ["PL", "CZ"]
	let out = "/mnt/playpen/mailwoman-data/wof/postalcode-geonames-intl.db"
	let foldInto: string | undefined
	let foldOut: string | undefined
	for (let i = 0; i < a.length; i++) {
		if (a[i] === "--geonames" && a[i + 1]) geonames = a[++i]!
		else if (a[i] === "--countries" && a[i + 1]) countries = a[++i]!.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
		else if (a[i] === "--out" && a[i + 1]) out = a[++i]!
		else if (a[i] === "--fold-into" && a[i + 1]) foldInto = a[++i]!
		else if (a[i] === "--fold-out" && a[i + 1]) foldOut = a[++i]!
	}
	return { geonames, countries, out, foldInto, foldOut }
}

/** Synthetic id base — above WOF's ~907M ceiling, so these GeoNames-sourced records never collide with a WOF id. */
const SYNTH_ID_BASE = 8_000_000_000

/** One postcode's accumulated GeoNames points (one row per place sharing the code). */
interface PostcodeAcc {
	cc: string
	pc: string
	sumLat: number
	sumLon: number
	n: number
	minLat: number
	minLon: number
	maxLat: number
	maxLon: number
}

/** Stream the GeoNames postal TSV, accumulating centroid + bbox per (country, postcode). */
async function readGeonames(file: string, want: Set<string>): Promise<Map<string, PostcodeAcc>> {
	const acc = new Map<string, PostcodeAcc>()
	const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })
	// TSV cols: 0=country 1=postcode 2=place 3..8=admin 9=lat 10=lon 11=accuracy
	for await (const line of rl) {
		if (!line) continue
		const f = line.split("\t")
		const cc = f[0]
		if (!cc || !want.has(cc)) continue
		const pc = f[1]
		const lat = Number(f[9])
		const lon = Number(f[10])
		if (!pc || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue
		const key = `${cc}\t${pc}`
		const cur = acc.get(key)
		if (cur) {
			cur.sumLat += lat
			cur.sumLon += lon
			cur.n++
			if (lat < cur.minLat) cur.minLat = lat
			if (lat > cur.maxLat) cur.maxLat = lat
			if (lon < cur.minLon) cur.minLon = lon
			if (lon > cur.maxLon) cur.maxLon = lon
		} else {
			acc.set(key, { cc, pc, sumLat: lat, sumLon: lon, n: 1, minLat: lat, minLon: lon, maxLat: lat, maxLon: lon })
		}
	}
	return acc
}

/** The distinct written forms of a postcode that should resolve: the raw form + a separator-stripped form. */
function nameVariants(pc: string): string[] {
	const stripped = pc.replace(/[\s-]/g, "")
	const variants = [pc]
	if (stripped && stripped !== pc) variants.push(stripped)
	// Dedup by fold() — two forms that normalize identically need only one row.
	const seen = new Set<string>()
	return variants.filter((v) => {
		const k = normalizeLocalityForKey(v)
		if (seen.has(k)) return false
		seen.add(k)
		return true
	})
}

const SPR_COLUMNS = [
	"id", "parent_id", "name", "placetype", "country", "latitude", "longitude",
	"min_latitude", "min_longitude", "max_latitude", "max_longitude",
	"is_current", "is_deprecated", "is_ceased", "is_superseded", "is_superseding", "lastmodified",
] as const

async function buildShard(acc: Map<string, PostcodeAcc>, outPath: string): Promise<number> {
	if (existsSync(outPath)) {
		console.error(`out exists, overwriting: ${outPath}`)
	}
	const db = new DatabaseSync(outPath)
	const kdb = new DatabaseClient({ database: db })
	// Schema mirrors postalcode-intl.db's `spr` exactly — a drop-in `--postcodes` input for build-candidate.
	await kdb.schema
		.createTable("spr")
		.ifNotExists()
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("parent_id", "integer", (c) => c.notNull().defaultTo(-1))
		.addColumn("name", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("placetype", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("country", "text", (c) => c.notNull().defaultTo(""))
		.addColumn("latitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("longitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("min_latitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("min_longitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("max_latitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("max_longitude", "real", (c) => c.notNull().defaultTo(0))
		.addColumn("is_current", "integer", (c) => c.notNull().defaultTo(1))
		.addColumn("is_deprecated", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("is_ceased", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("is_superseded", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("is_superseding", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("lastmodified", "integer", (c) => c.notNull().defaultTo(0))
		.execute()

	// Hot bulk write — positional prepared statement (the leave-as-raw fast path), columns from SPR_COLUMNS.
	const ins = db.prepare(`INSERT INTO spr (${SPR_COLUMNS.join(", ")}) VALUES (${SPR_COLUMNS.map(() => "?").join(", ")})`)
	let id = SYNTH_ID_BASE
	let rows = 0
	db.exec("BEGIN")
	for (const a of acc.values()) {
		const lat = a.sumLat / a.n
		const lon = a.sumLon / a.n
		for (const name of nameVariants(a.pc)) {
			ins.run(
				++id, -1, name, "postalcode", a.cc, lat, lon,
				a.minLat, a.minLon, a.maxLat, a.maxLon,
				1, 0, 0, 0, 0, 0
			)
			rows++
		}
	}
	db.exec("COMMIT")
	db.close()
	return rows
}

/**
 * Fold the freshly-built shard into a COPY of an existing candidate gazetteer, mirroring
 * `build-candidate` pass-4's row construction (placetype_id=9, region_id=0, neg_rank=0, is_primary=1,
 * bbox falls back to the centroid). The fast path to a demo-ready DB without a full rebuild.
 */
async function foldIntoCandidate(shardPath: string, srcPath: string, dstPath: string): Promise<number> {
	copyFileSync(srcPath, dstPath)
	const out = new DatabaseSync(dstPath)
	const shard = new DatabaseSync(shardPath, { readOnly: true })

	const ptRow = out.prepare("SELECT id FROM placetype_codes WHERE placetype='postalcode'").get() as { id: number } | undefined
	if (!ptRow) throw new Error("candidate DB has no 'postalcode' placetype_code")
	const pcPtid = ptRow.id

	// country code → id, inserting any code the candidate DB doesn't already carry.
	const ccCache = new Map<string, number>()
	const getCc = out.prepare("SELECT id FROM country_codes WHERE code=?")
	const maxCc = out.prepare("SELECT COALESCE(MAX(id),0) m FROM country_codes").get() as { m: number }
	let nextCc = maxCc.m + 1
	const insCc = out.prepare("INSERT INTO country_codes (id, code) VALUES (?, ?)")
	const ccId = (code: string): number => {
		let id = ccCache.get(code)
		if (id !== undefined) return id
		const r = getCc.get(code) as { id: number } | undefined
		if (r) {
			ccCache.set(code, r.id)
			return r.id
		}
		id = nextCc++
		insCc.run(id, code)
		ccCache.set(code, id)
		return id
	}

	const ins = out.prepare(
		"INSERT OR IGNORE INTO candidate (name_key, country_id, region_id, placetype_id, neg_rank, spr_id, name, latitude, longitude, min_lat, min_lon, max_lat, max_lon, population, is_primary) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)
	let n = 0
	out.exec("BEGIN")
	for (const r of shard
		.prepare(
			"SELECT id, name, country, latitude, longitude, min_latitude AS mnlat, min_longitude AS mnlon, max_latitude AS mxlat, max_longitude AS mxlon " +
				"FROM spr WHERE placetype='postalcode' AND latitude != 0 AND longitude != 0"
		)
		.iterate()) {
		const name = String(r.name ?? "")
		const key = normalizeLocalityForKey(name)
		if (!key) continue
		const lat = r.latitude as number
		const lon = r.longitude as number
		ins.run(
			key, ccId(r.country as string), 0, pcPtid, 0, Number(r.id), name, lat, lon,
			(r.mnlat as number) || lat, (r.mnlon as number) || lon, (r.mxlat as number) || lat, (r.mxlon as number) || lon,
			0, 1
		)
		n++
	}
	out.exec("COMMIT")
	// Re-cluster the WITHOUT ROWID B-tree contiguously after the mid-tree inserts.
	out.exec("VACUUM")
	shard.close()
	out.close()
	return n
}

async function main(): Promise<void> {
	const { geonames, countries, out, foldInto, foldOut } = parseArgs()
	if (!existsSync(geonames)) {
		console.error(`Missing GeoNames file: ${geonames}`)
		process.exit(1)
	}
	console.error(`Reading GeoNames postal for ${countries.join(", ")} from ${geonames} …`)
	const acc = await readGeonames(geonames, new Set(countries))
	const byCc = new Map<string, number>()
	for (const a of acc.values()) byCc.set(a.cc, (byCc.get(a.cc) ?? 0) + 1)
	console.error(`  unique postcodes: ${[...byCc].map(([c, n]) => `${c}=${n}`).join(" ")}  (total ${acc.size})`)

	const rows = await buildShard(acc, out)
	console.error(`Wrote ${rows} spr rows (both separator variants) → ${out}`)

	if (foldInto && foldOut) {
		if (!existsSync(foldInto)) {
			console.error(`Missing --fold-into candidate DB: ${foldInto}`)
			process.exit(1)
		}
		console.error(`Folding shard into a copy of ${foldInto} → ${foldOut} (VACUUM after) …`)
		const n = await foldIntoCandidate(out, foldInto, foldOut)
		console.error(`Inserted ${n} postcode candidate rows → ${foldOut}`)
	} else {
		console.error(`(no --fold-into/--fold-out: shard only — feed it to build-candidate via --postcodes for the canonical rebuild)`)
	}
}

await main()
