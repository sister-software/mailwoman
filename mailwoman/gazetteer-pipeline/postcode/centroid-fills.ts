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
import { CSVSpliterator, Delimiters } from "spliterator"

export interface CentroidFillOptions {
	/**
	 * GeoNames postal dump dir (`<CC>.txt`). Omit to skip pass 2.
	 */
	geonamesDir?: string
	/**
	 * The admin gazetteer to borrow parent/ancestor centroids from (ATTACHed read-only). Omit to skip passes 3–4.
	 */
	adminPath?: string
	/**
	 * WOF repos root for the pass-4 `wof:hierarchy` read. Omit to skip pass 4.
	 */
	reposDir?: string
	onPhase?: (phase: string, detail?: string) => void
}

export interface CentroidFillResult {
	geonamesFixed: number
	/**
	 * Delivery-city name rows written from GeoNames postal. Zero means the shard's postcodes are nameless — the state
	 * `postalcode-us.db` shipped in.
	 */
	geonamesNames: number
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
/**
 * GeoNames files a US territory under its OWN ISO code — Puerto Rico as `PR`, Guam as `GU` — while the WOF postcode
 * repo files all of them as `US`. Reading only `US` rows therefore leaves every territory postcode unnamed and
 * unplaced: 149 of them, verified against the 2024 Census ZCTA gazetteer, which is the entire set of five-digit ZIPs
 * ZCTA lists and GeoNames appears to miss. GeoNames misses no mainland ZIP at all.
 */
const GEONAMES_COUNTRY_ALIASES: Readonly<Record<string, readonly string[]>> = {
	US: ["US", "PR", "VI", "GU", "MP", "AS"],
}

/**
 * One postcode's accumulated GeoNames evidence: the mean of its centroids, and every distinct place name it appears
 * under. A postcode legitimately carries several names — those are its delivery-city aliases, which is the point.
 */
interface GeonamesPostcode {
	lat: number
	lon: number
	n: number
	names: Set<string>
}

/**
 * Read a country's GeoNames postal rows.
 *
 * Prefers the per-country `<CC>.txt` dump and falls back to scanning the combined `allCountries-postal.txt`, because
 * the two layouts have different coverage on disk: the per-country directory is populated for the locales fetched one
 * at a time, and the combined file is the one that carries the US. Without the fallback the US pass finds no file,
 * `existsSync` short-circuits, and the whole thing silently no-ops — which is why `postalcode-us.db` shipped with
 * 42,318 postcodes and an empty `names` table.
 */
const geonamesCache = new Map<string, Map<string, GeonamesPostcode>>()

async function readGeonamesPostal(geonamesDir: string, country: string): Promise<Map<string, GeonamesPostcode>> {
	// The centroid pass and the name pass ask for the same country, and the combined dump is 140 MB.
	const cached = geonamesCache.get(`${geonamesDir}\u0000${country}`)

	if (cached) return cached

	const wanted = new Set(GEONAMES_COUNTRY_ALIASES[country] ?? [country])
	const perCountry = join(geonamesDir, `${country}.txt`)
	const combined = join(geonamesDir, "..", "geonames", "allCountries-postal.txt")
	const source = existsSync(perCountry) ? perCountry : combined
	const acc = new Map<string, GeonamesPostcode>()

	if (!existsSync(source)) return acc

	// Streamed, because `source` is a per-country dump of ~1 MB OR the 140 MB combined file, and only
	// the caller knows which. Reading it whole would hold the entire file as one string plus a string
	// per line — the combined dump is 1.5 M lines.
	//
	// Columns: country, postcode, place, admin1..3 (name + code pairs), latitude, longitude, accuracy.
	// Headerless, and quote handling stays OFF: GeoNames does not quote, and a bare `"` inside a place
	// name would otherwise swallow the rest of the file.
	for await (const cells of CSVSpliterator.fromAsync(source, {
		columnDelimiter: Delimiters.Tab,
		header: false,
		enableQuoteHandling: false,
	})) {
		if (!wanted.has(cells[0] ?? "")) continue

		const pc = cells[1]
		const place = (cells[2] ?? "").trim()
		const lat = Number(cells[9])
		const lon = Number(cells[10])

		if (!pc || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue

		const cur = acc.get(pc)

		if (cur) {
			cur.lat += lat
			cur.lon += lon

			cur.n++

			if (place) {
				cur.names.add(place)
			}
		} else {
			acc.set(pc, { lat, lon, n: 1, names: new Set(place ? [place] : []) })
		}
	}

	geonamesCache.set(`${geonamesDir}\u0000${country}`, acc)

	return acc
}

/**
 * Attach each postcode's GeoNames delivery-city name(s) to the shard's `names` table.
 *
 * Separate from the centroid pass because the two select different rows: a centroid is only wanted where one is
 * MISSING, while a name is wanted on every postcode — 11201 has had a Census ZCTA coordinate all along and no name at
 * all. Rows are the USPS delivery city, which is frequently not the geographic locality (11201 is Brooklyn, inside the
 * locality New York), and for Queens is a neighbourhood name rather than the borough (Astoria, Flushing, Jamaica).
 *
 * Shipping these rows obliges the "GeoNames (CC-BY 4.0)" attribution the sibling modules already carry.
 */
async function geonamesNameFill(db: DatabaseSync, geonamesDir: string): Promise<number> {
	const countries = (
		db.prepare(`SELECT DISTINCT country FROM spr WHERE placetype='postalcode' AND is_current!=0`).all() as Array<{
			country: string
		}>
	).map((r) => r.country)

	const select = db.prepare(
		`SELECT id, name FROM spr WHERE country=? AND placetype='postalcode' AND is_current!=0 AND name=?`
	)

	// `official` stays 0: a delivery city is what the postal system calls the place, not an official
	// name of it, and the #936 name-exact tier reads that bit.
	const insert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, privateuse, official, lastmodified)
		 VALUES (?, ?, 'postalcode', ?, '', '', 0, 0)`
	)

	let inserted = 0

	for (const cc of countries) {
		const acc = await readGeonamesPostal(geonamesDir, cc)

		if (!acc.size) continue

		db.exec("BEGIN")

		for (const [pc, entry] of acc) {
			if (!entry.names.size) continue

			const row = select.get(cc, pc) as { id: number } | undefined

			if (!row) continue

			for (const place of entry.names) {
				insert.run(row.id, place, cc)

				inserted++
			}
		}

		db.exec("COMMIT")
	}

	return inserted
}

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
		const acc = await readGeonamesPostal(geonamesDir, cc)

		if (!acc.size) continue

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

/**
 * WOF id → repo-relative GeoJSON path: chunk the id into groups of 3, then `<id>.geojson`.
 */
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

/**
 * Run the fill ladder (passes 2–4) on an OPEN staging postcode DB. See the module docstring for priorities.
 */
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
	let geonamesNames = 0
	let ancestorFixed = 0

	// Pass 2: GeoNames postal — runs FIRST so the postcode's own centroid wins over the coarser parent-borrow.
	if (opts.geonamesDir && existsSync(opts.geonamesDir)) {
		phase("fill-geonames", opts.geonamesDir)
		geonamesFixed = await geonamesFill(db, opts.geonamesDir)

		phase("name-geonames", "delivery-city names")
		geonamesNames = await geonamesNameFill(db, opts.geonamesDir)
	}

	if (opts.adminPath && existsSync(opts.adminPath)) {
		db.exec(`ATTACH '${opts.adminPath.replaceAll("'", "''")}' AS adm`)

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
	const parentBorrowFixed = placedAfter - placedBefore - geonamesFixed - ancestorFixed

	const total = (
		db.prepare(`SELECT COUNT(*) n FROM spr WHERE placetype='postalcode' AND is_current!=0`).get() as { n: number }
	).n

	return { geonamesFixed, geonamesNames, parentBorrowFixed, ancestorFixed, placedBefore, placedAfter, total }
}
