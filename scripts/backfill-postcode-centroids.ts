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

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

interface Args {
	dbPath: string
	adminPath: string
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	let dbPath: string | undefined
	let adminPath = "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--db" && args[i + 1]) dbPath = args[++i]
		else if (args[i] === "--admin" && args[i + 1]) adminPath = args[++i]!
	}
	if (!dbPath) {
		console.error(
			"Usage: node scripts/backfill-postcode-centroids.ts --db <postalcode.db> [--admin <admin-global-priority.db>]"
		)
		process.exit(1)
	}
	return { dbPath, adminPath }
}

function main(): void {
	const { dbPath, adminPath } = parseArgs()
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

	console.error(`Backfilled centroids: ${before.n} → ${after.n} placed (+${after.n - before.n}) of ${total.n} total`)
	for (const r of byCountry) {
		const pct = r.total ? ((100 * r.placed) / r.total).toFixed(0) : "0"
		console.error(`  ${r.country}: ${r.placed}/${r.total} placed (${pct}%)`)
	}
}

main()
