/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Backfill postcode centroids for the postcode-anchor pipeline (#240).
 *
 *   The `whosonfirst-data-postalcode-<cc>` repos vary in quality. US and ~22% of FR records carry
 *   their own `geom:latitude/longitude`; the rest ship as coordinate-less stubs (DE leans on its
 *   admin parent; ES/IT are orphan-heavy with no usable parent at all). A postcode with no centroid
 *   is useless as a geographic anchor, so this pass fills coordinates from, in priority order:
 *
 *   1. The postcode record's own `geom:latitude/longitude` (from the build — US/NL/FR), most
 *        authoritative;
 *   2. **GeoNames postal** (`--geonames <dir>`): the postcode's OWN centroid, matched by string. This is
 *        the cleanest fill for ES/IT and ~half of DE, and it corrects WOF's mis-linked Italian
 *        parents;
 *   3. The WOF admin parent-borrow (`--admin`, `--repos`): a coarse "which city/region" approximation,
 *        last resort for postcodes GeoNames does not cover.
 *
 *   Source/integrity note: WOF ids stay canonical and the eval keys — GeoNames only supplies a
 *   COORDINATE keyed by the postcode string, never an entity id, so the eval-WOF-id integrity
 *   behind the custom-WOF rule is preserved (delegated-authority consult, 2026-06-03). GeoNames is
 *   CC-BY 4.0: any DB that ships GeoNames-sourced coordinates must attribute "GeoNames (CC-BY
 *   4.0)". Files: download.geonames.org/ export/zip/<CC>.zip → `<CC>.txt`. Postcodes neither
 *   GeoNames nor WOF can place keep latitude=0 (membership only).
 *
 *   Usage: node --experimental-strip-types scripts/backfill-postcode-centroids.ts\
 *   --db /mnt/playpen/mailwoman-data/wof/postalcode-intl.db\
 *   --geonames /mnt/playpen/mailwoman-data/geonames\
 *   --admin /mnt/playpen/mailwoman-data/wof/admin-global-priority.db --repos
 *   /mnt/playpen/mailwoman-data/wof/repos
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"

interface Args {
	dbPath: string
	adminPath: string
	reposDir?: string
	geonamesDir?: string
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	let dbPath: string | undefined
	let adminPath = "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
	let reposDir: string | undefined
	let geonamesDir: string | undefined

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--db" && args[i + 1]) dbPath = args[++i]
		else if (args[i] === "--admin" && args[i + 1]) adminPath = args[++i]!
		else if (args[i] === "--repos" && args[i + 1]) reposDir = args[++i]!
		else if (args[i] === "--geonames" && args[i + 1]) geonamesDir = args[++i]!
	}

	if (!dbPath) {
		console.error(
			"Usage: node scripts/backfill-postcode-centroids.ts --db <postalcode.db> [--geonames <dir>] [--admin <admin-global-priority.db>] [--repos <wof-repos-dir>]"
		)
		process.exit(1)
	}

	return { dbPath, adminPath, reposDir, geonamesDir }
}

/**
 * Priority-2 fill: for every coordinate-less postcode, take its OWN centroid from the GeoNames postal file for that
 * country (`<geonamesDir>/<CC>.txt`, the GeoNames `zip` dump). A postcode that appears on several GeoNames rows (one
 * per place sharing the code) is averaged into a single centroid. Matched by the postcode string only — the WOF id is
 * untouched, so the eval keys stay WOF's.
 */
async function geonamesFill(db: DatabaseSync, geonamesDir: string): Promise<number> {
	// The GeoNames UPDATE matches on (country, name); the build only indexes placetype/country/parent,
	// so without this the per-postcode UPDATEs scan each country's rows (minutes on 400k+ rows). `kdb`
	// wraps `db` for the DDL; main() owns `db`'s lifecycle, so we don't destroy it here.
	const kdb = new DatabaseClient({ database: db })
	await kdb.schema.createIndex("spr_by_country_name").ifNotExists().on("spr").columns(["country", "name"]).execute()

	const countries = (
		db
			.prepare(`SELECT DISTINCT country FROM spr WHERE placetype='postalcode' AND is_current!=0 AND latitude=0`)
			.all() as Array<{ country: string }>
	).map((r) => r.country)

	const update = db.prepare(
		`UPDATE spr SET latitude=?, longitude=?, min_latitude=?, max_latitude=?, min_longitude=?, max_longitude=?
		 WHERE country=? AND placetype='postalcode' AND is_current!=0 AND latitude=0 AND name=?`
	)

	let fixed = 0

	for (const cc of countries) {
		const file = join(geonamesDir, `${cc}.txt`)

		if (!existsSync(file)) continue

		// Build postcode → mean(lat,lon) from the TSV (cols: country, postcode, place, ...adm..., lat, lon, acc).
		const acc = new Map<string, { lat: number; lon: number; n: number }>()

		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line) continue
			const f = line.split("\t")
			const pc = f[1]
			const lat = Number(f[9])
			const lon = Number(f[10])

			if (!pc || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue
			const cur = acc.get(pc)

			if (cur) {
				cur.lat += lat
				cur.lon += lon
				cur.n++
			} else acc.set(pc, { lat, lon, n: 1 })
		}

		db.exec("BEGIN")

		for (const [pc, s] of acc) {
			const lat = s.lat / s.n
			const lon = s.lon / s.n
			const res = update.run(lat, lon, lat, lat, lon, lon, cc, pc)
			fixed += Number(res.changes)
		}
		db.exec("COMMIT")
	}

	return fixed
}

/** WOF id → repo-relative GeoJSON path: chunk the id into groups of 3, then `<id>.geojson`. */
function wofIDPath(id: number): string {
	const s = String(id)
	const parts: string[] = []

	for (let i = 0; i < s.length; i += 3) parts.push(s.slice(i, i + 3))

	return join(...parts, `${s}.geojson`)
}

/**
 * Second-pass fallback: for postcodes still coordinate-less after the parent-borrow (their immediate parent locality is
 * absent from the admin DB — common for city-states like Berlin, whose locality node we never imported), borrow the
 * finest available ANCESTOR centroid from the GeoJSON hierarchy. County is preferred over region for tighter placement.
 * Every coordinate still comes from our own admin DB.
 */
function ancestorFallback(db: DatabaseSync, reposDir: string): number {
	const unplaced = db
		.prepare(`SELECT id, country FROM spr WHERE placetype='postalcode' AND is_current!=0 AND latitude=0 AND id>0`)
		.all() as Array<{ id: number; country: string }>

	const adminCentroid = db.prepare(
		`SELECT latitude AS lat, longitude AS lon FROM adm.spr WHERE id=? AND latitude!=0 AND longitude!=0 LIMIT 1`
	)
	const update = db.prepare(
		`UPDATE spr SET latitude=?, longitude=?, min_latitude=?, max_latitude=?, min_longitude=?, max_longitude=? WHERE id=?`
	)

	let fixed = 0
	db.exec("BEGIN")

	for (const row of unplaced) {
		const file = join(reposDir, `whosonfirst-data-postalcode-${row.country.toLowerCase()}`, "data", wofIDPath(row.id))
		let hierarchy: Record<string, number> | undefined

		try {
			hierarchy = JSON.parse(readFileSync(file, "utf8")).properties?.["wof:hierarchy"]?.[0]
		} catch {
			continue // file missing or unreadable — leave unplaced
		}

		if (!hierarchy) continue

		// Finest-available ancestor: county, then region.
		for (const key of ["county_id", "region_id"] as const) {
			const ancestorID = hierarchy[key]

			if (!ancestorID) continue
			const c = adminCentroid.get(ancestorID) as { lat: number; lon: number } | undefined

			if (c) {
				update.run(c.lat, c.lon, c.lat, c.lat, c.lon, c.lon, row.id)
				fixed++
				break
			}
		}
	}
	db.exec("COMMIT")

	return fixed
}

async function main(): Promise<void> {
	const { dbPath, adminPath, reposDir, geonamesDir } = parseArgs()

	for (const p of [dbPath, adminPath]) {
		if (!existsSync(p)) {
			console.error(`Missing DB: ${p}`)
			process.exit(1)
		}
	}

	const db = new DatabaseSync(dbPath)
	db.exec(`ATTACH '${adminPath.replace(/'/g, "''")}' AS adm`)

	const before = db
		.prepare(`SELECT COUNT(*) n FROM spr WHERE placetype='postalcode' AND is_current!=0 AND latitude!=0`)
		.get() as { n: number }

	// Priority 2: GeoNames postal (the postcode's own centroid). Runs FIRST so it wins over the coarser
	// WOF parent-borrow below, and so it overrides any WOF mis-link (e.g. the Italian Milan→Liguria case).
	let geonamesFixed = 0

	if (geonamesDir) {
		if (!existsSync(geonamesDir)) console.error(`Missing geonames dir, skipping: ${geonamesDir}`)
		else geonamesFixed = await geonamesFill(db, geonamesDir)
	}

	// Priority 3: borrow the parent locality's centroid for every coordinate-less postcode whose parent
	// postcode whose parent exists in the admin DB with real coords. `INSERT OR REPLACE` is avoided —
	// a single correlated UPDATE keeps the WOF id and every other column intact.
	db.exec("BEGIN")
	db.exec(`
		UPDATE spr
		SET latitude = (SELECT a.latitude FROM adm.spr a WHERE a.id = spr.parent_id),
		    longitude = (SELECT a.longitude FROM adm.spr a WHERE a.id = spr.parent_id),
		    min_latitude = (SELECT a.latitude FROM adm.spr a WHERE a.id = spr.parent_id),
		    max_latitude = (SELECT a.latitude FROM adm.spr a WHERE a.id = spr.parent_id),
		    min_longitude = (SELECT a.longitude FROM adm.spr a WHERE a.id = spr.parent_id),
		    max_longitude = (SELECT a.longitude FROM adm.spr a WHERE a.id = spr.parent_id)
		WHERE placetype = 'postalcode'
		  AND is_current != 0
		  AND latitude = 0
		  AND parent_id > 0
		  AND EXISTS (
		      SELECT 1 FROM adm.spr a
		      WHERE a.id = spr.parent_id AND a.latitude != 0 AND a.longitude != 0
		  )
	`)
	db.exec("COMMIT")

	let ancestorFixed = 0

	if (reposDir) {
		if (!existsSync(reposDir)) {
			console.error(`Missing repos dir, skipping ancestor fallback: ${reposDir}`)
		} else {
			ancestorFixed = ancestorFallback(db, reposDir)
		}
	}

	const after = db
		.prepare(`SELECT COUNT(*) n FROM spr WHERE placetype='postalcode' AND is_current!=0 AND latitude!=0`)
		.get() as { n: number }
	const total = db.prepare(`SELECT COUNT(*) n FROM spr WHERE placetype='postalcode' AND is_current!=0`).get() as {
		n: number
	}

	const byCountry = db
		.prepare(
			`SELECT country,
			        COUNT(*) total,
			        SUM(latitude!=0) placed
			 FROM spr WHERE placetype='postalcode' AND is_current!=0
			 GROUP BY country ORDER BY total DESC`
		)
		.all() as Array<{ country: string; total: number; placed: number }>

	db.close()

	console.error(
		`Backfilled centroids: ${before.n} → ${after.n} placed (+${after.n - before.n}) of ${total.n} total` +
			(geonamesDir ? ` [${geonamesFixed} via GeoNames]` : "") +
			(reposDir ? ` [${ancestorFixed} via county/region ancestor fallback]` : "")
	)

	for (const r of byCountry) {
		const pct = r.total ? ((100 * r.placed) / r.total).toFixed(0) : "0"
		console.error(`  ${r.country}: ${r.placed}/${r.total} placed (${pct}%)`)
	}
}

await main()
