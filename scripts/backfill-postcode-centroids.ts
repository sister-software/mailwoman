/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Backfill postcode centroids from the admin hierarchy (postcode-anchor pipeline, #240).
 *
 *   The `whosonfirst-data-postalcode-<cc>` repos vary in quality. US and ~22% of FR postcode records
 *   carry their own `geom:latitude/longitude`; the rest (most of DE, much of FR) ship as
 *   coordinate-less stubs that only carry a `wof:parent_id` into the admin hierarchy. A postcode
 *   with no centroid is useless as a geographic anchor, so this pass borrows the centroid (and a
 *   point bbox) from the postcode's parent locality in the admin gazetteer — a coarse "which city"
 *   placement, which is exactly what the anchor needs.
 *
 *   This is the operator-mandated "extend the custom WOF build" path: every coordinate comes from our
 *   own WOF admin DB, never a prebuilt third-party dump. Postcodes whose parent is absent from the
 *   admin DB (e.g. IT/ES, whose admin repos we have not yet cloned) keep latitude=0 — the anchor
 *   still counts them for country membership but reports no centroid until their admin repos are
 *   built.
 *
 *   Usage: node --experimental-strip-types scripts/backfill-postcode-centroids.ts\
 *   --db /mnt/playpen/mailwoman-data/wof/postalcode-intl.db\
 *   --admin /mnt/playpen/mailwoman-data/wof/admin-global-priority.db
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

interface Args {
	dbPath: string
	adminPath: string
	reposDir?: string
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	let dbPath: string | undefined
	let adminPath = "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
	let reposDir: string | undefined
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--db" && args[i + 1]) dbPath = args[++i]
		else if (args[i] === "--admin" && args[i + 1]) adminPath = args[++i]!
		else if (args[i] === "--repos" && args[i + 1]) reposDir = args[++i]!
	}
	if (!dbPath) {
		console.error(
			"Usage: node scripts/backfill-postcode-centroids.ts --db <postalcode.db> [--admin <admin-global-priority.db>] [--repos <wof-repos-dir>]"
		)
		process.exit(1)
	}
	return { dbPath, adminPath, reposDir }
}

/** WOF id → repo-relative GeoJSON path: chunk the id into groups of 3, then `<id>.geojson`. */
function wofIdPath(id: number): string {
	const s = String(id)
	const parts: string[] = []
	for (let i = 0; i < s.length; i += 3) parts.push(s.slice(i, i + 3))
	return join(...parts, `${s}.geojson`)
}

/**
 * Second-pass fallback: for postcodes still coordinate-less after the parent-borrow (their
 * immediate parent locality is absent from the admin DB — common for city-states like Berlin, whose
 * locality node we never imported), borrow the finest available ANCESTOR centroid from the GeoJSON
 * hierarchy. County is preferred over region for tighter placement. Every coordinate still comes
 * from our own admin DB.
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
		const file = join(reposDir, `whosonfirst-data-postalcode-${row.country.toLowerCase()}`, "data", wofIdPath(row.id))
		let hierarchy: Record<string, number> | undefined
		try {
			hierarchy = JSON.parse(readFileSync(file, "utf8")).properties?.["wof:hierarchy"]?.[0]
		} catch {
			continue // file missing or unreadable — leave unplaced
		}
		if (!hierarchy) continue

		// Finest-available ancestor: county, then region.
		for (const key of ["county_id", "region_id"] as const) {
			const ancestorId = hierarchy[key]
			if (!ancestorId) continue
			const c = adminCentroid.get(ancestorId) as { lat: number; lon: number } | undefined
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

function main(): void {
	const { dbPath, adminPath, reposDir } = parseArgs()
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

	// Borrow the parent locality's centroid (and a point bbox at that centroid) for every coordinate-less
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
			(reposDir ? ` (${ancestorFixed} via county/region ancestor fallback)` : "")
	)
	for (const r of byCountry) {
		const pct = r.total ? ((100 * r.placed) / r.total).toFixed(0) : "0"
		console.error(`  ${r.country}: ${r.placed}/${r.total} placed (${pct}%)`)
	}
}

main()
