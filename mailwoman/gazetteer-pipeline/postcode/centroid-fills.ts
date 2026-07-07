/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode-centroid fills (#240/#525), ported from the standalone `backfill-postcode-centroids.ts` /
 *   `fill-zcta-centroids.ts` mutators into BUILD steps — they now run on the STAGING db inside
 *   `buildPostcodeShard`, never against a shipped artifact (the sealed-artifact invariant).
 *
 *   Fill priority (each pass touches only rows still `(0,0)`; a placeholder never overwrites a real
 *   coordinate; all passes are idempotent):
 *
 *   1. US ONLY — Census ZCTA Gazetteer internal points (public domain), then GeoNames `US.txt` for the
 *      PO-box/unique-ZIP residual (`zcta-centroids.ts`, provenance in `centroid_source`).
 *   2. GeoNames postal (`<CC>.txt`) — the postcode's OWN centroid, string-matched (WOF ids stay the
 *      eval keys; corrects WOF mis-links like the Italian Milan→Liguria case). CC-BY 4.0 — any DB
 *      shipping these rows must attribute "GeoNames (CC-BY 4.0)".
 *   3. WOF admin parent-borrow — the parent locality's centroid from the admin gazetteer.
 *   4. GeoJSON-hierarchy ancestor fallback (county, then region) for parents the admin DB lacks
 *      (city-states like Berlin). Every coordinate still comes from our own admin DB.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"

export interface CentroidFillOptions {
	/** GeoNames postal dump dir (`<CC>.txt`). Omit to skip pass 2. */
	geonamesDir?: string
	/** The admin gazetteer to borrow parent/ancestor centroids from (ATTACHed read-only). Omit to skip passes 3–4. */
	adminPath?: string
	/** WOF repos root for the pass-4 `wof:hierarchy` read. Omit to skip pass 4. */
	reposDir?: string
	onPhase?: (phase: string, detail?: string) => void
}

export interface CentroidFillResult {
	geonamesFixed: number
	parentBorrowFixed: number
	ancestorFixed: number
	placedBefore: number
	placedAfter: number
	total: number
}

/**
 * Priority-2 fill: for every coordinate-less postcode, take its OWN centroid from the GeoNames postal file for that
 * country. A postcode on several GeoNames rows is averaged. Matched by the postcode string only — the WOF id is
 * untouched, so the eval keys stay WOF's.
 */
async function geonamesFill(db: DatabaseSync, geonamesDir: string): Promise<number> {
	// The GeoNames UPDATE matches on (country, name); the build only indexes placetype/country/parent,
	// so without this the per-postcode UPDATEs scan each country's rows (minutes on 400k+ rows). `kdb`
	// wraps `db` for the DDL; the caller owns `db`'s lifecycle, so we don't destroy it here.
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
			} else {
				acc.set(pc, { lat, lon, n: 1 })
			}
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

	for (let i = 0; i < s.length; i += 3) {
		parts.push(s.slice(i, i + 3))
	}

	return join(...parts, `${s}.geojson`)
}

/**
 * Pass-4 fallback: for postcodes still coordinate-less after the parent-borrow (their immediate parent locality is
 * absent from the admin DB — common for city-states like Berlin), borrow the finest available ANCESTOR centroid from
 * the GeoJSON hierarchy. County is preferred over region for tighter placement.
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

/** Run the fill ladder (passes 2–4) on an OPEN staging postcode DB. See the module docstring for priorities. */
export async function fillPostcodeCentroids(
	db: DatabaseSync,
	opts: CentroidFillOptions = {}
): Promise<CentroidFillResult> {
	const phase = opts.onPhase ?? (() => {})
	const placed = () =>
		(
			db.prepare(`SELECT COUNT(*) n FROM spr WHERE placetype='postalcode' AND is_current!=0 AND latitude!=0`).get() as {
				n: number
			}
		).n
	const placedBefore = placed()
	let geonamesFixed = 0
	let parentBorrowFixed = 0
	let ancestorFixed = 0

	// Pass 2: GeoNames postal — runs FIRST so the postcode's own centroid wins over the coarser parent-borrow.
	if (opts.geonamesDir && existsSync(opts.geonamesDir)) {
		phase("fill-geonames", opts.geonamesDir)
		geonamesFixed = await geonamesFill(db, opts.geonamesDir)
	}

	if (opts.adminPath && existsSync(opts.adminPath)) {
		db.exec(`ATTACH '${opts.adminPath.replace(/'/g, "''")}' AS adm`)

		try {
			// Pass 3: borrow the parent locality's centroid. A single correlated UPDATE keeps the WOF id
			// and every other column intact.
			phase("fill-parent-borrow")
			db.exec("BEGIN")
			const res = db.exec(`
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
			void res

			// Pass 4: hierarchy-ancestor fallback (needs both the admin attach and the source geojson).
			if (opts.reposDir && existsSync(opts.reposDir)) {
				phase("fill-ancestor-fallback")
				ancestorFixed = ancestorFallback(db, opts.reposDir)
			}
		} finally {
			db.exec("DETACH adm")
		}
	}
	const placedAfter = placed()
	parentBorrowFixed = placedAfter - placedBefore - geonamesFixed - ancestorFixed
	const total = (
		db.prepare(`SELECT COUNT(*) n FROM spr WHERE placetype='postalcode' AND is_current!=0`).get() as { n: number }
	).n

	return { geonamesFixed, parentBorrowFixed, ancestorFixed, placedBefore, placedAfter, total }
}
