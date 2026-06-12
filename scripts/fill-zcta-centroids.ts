/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI for the Census ZCTA + GeoNames centroid fills (#525) — fills `(0,0)`-placeholder US postcode
 *   rows in `postalcode-us.db` in two passes:
 *
 *   1. ZCTA pass (`--zcta`): Census 2024 ZCTA Gazetteer internal-point centroids (public domain). Covers
 *        most standard delivery ZIPs. Provenance tag: `census-zcta-2024`.
 *   2. GeoNames pass (`--geonames`): GeoNames US postal file (CC-BY 4.0). Covers some PO-box and unique
 *        ZIPs absent from ZCTA. Run AFTER the ZCTA pass so it only touches the residual. Provenance
 *        tag: `geonames-us`. Any DB shipping these rows must attribute "GeoNames (CC-BY 4.0)".
 *
 *   Both passes are idempotent and never overwrite a real coordinate. Logic + contract tests live in
 *   `scripts/zcta-centroids.ts`. Run after any rebuild of the US postcode shard (recorded as a
 *   `post_build` step in `scripts/wof-build-manifest.json`).
 *
 *   Usage: node --experimental-strip-types scripts/fill-zcta-centroids.ts\
 *   [--db /mnt/playpen/mailwoman-data/wof/postalcode-us.db]\
 *   [--zcta /mnt/playpen/mailwoman-data/census/2024_Gaz_zcta_national.txt]\
 *   [--geonames /mnt/playpen/mailwoman-data/geonames/US.txt]
 */

import { existsSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import {
	fillGeonamesPlaceholders,
	fillPlaceholderCentroids,
	parseGeonamesCentroids,
	parseZctaCentroids,
} from "./zcta-centroids.ts"

function main(): void {
	const args = process.argv.slice(2)
	let dbPath = "/mnt/playpen/mailwoman-data/wof/postalcode-us.db"
	let zctaPath = "/mnt/playpen/mailwoman-data/census/2024_Gaz_zcta_national.txt"
	let geonamesPath: string | undefined
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--db" && args[i + 1]) dbPath = args[++i]!
		else if (args[i] === "--zcta" && args[i + 1]) zctaPath = args[++i]!
		else if (args[i] === "--geonames" && args[i + 1]) geonamesPath = args[++i]!
	}

	if (!existsSync(dbPath)) {
		console.error(`Missing DB: ${dbPath}`)
		process.exit(1)
	}
	if (!existsSync(zctaPath)) {
		console.error(`Missing ZCTA file: ${zctaPath}`)
		process.exit(1)
	}
	if (geonamesPath && !existsSync(geonamesPath)) {
		console.error(`Missing GeoNames file: ${geonamesPath}`)
		process.exit(1)
	}

	const db = new DatabaseSync(dbPath)
	const count = (where: string): number =>
		(
			db.prepare(`SELECT COUNT(*) n FROM spr WHERE placetype='postalcode' AND is_current!=0 AND ${where}`).get() as {
				n: number
			}
		).n

	const total = count("country='US'")
	const beforeAll = count("country='US' AND latitude=0 AND longitude=0")

	// Pass 1: Census ZCTA fill.
	const zcta = parseZctaCentroids(readFileSync(zctaPath, "utf8"))
	const zctaBefore = count("country='US' AND latitude=0 AND longitude=0")
	const zctaFilled = fillPlaceholderCentroids(db, zcta)
	const zctaAfter = count("country='US' AND latitude=0 AND longitude=0")

	const pct = (n: number) => ((100 * n) / total).toFixed(1)
	console.error(
		`ZCTA pass: ${zcta.size.toLocaleString()} ZCTAs parsed; filled ${zctaFilled.toLocaleString()} rows ` +
			`(${pct(zctaBefore)}% → ${pct(zctaAfter)}% placeholder)`
	)

	// Pass 2: GeoNames fill (residual PO-box/unique ZIPs only — runs only on lat=0 rows).
	let geoFilled = 0
	if (geonamesPath) {
		const geonames = parseGeonamesCentroids(readFileSync(geonamesPath, "utf8"))
		const geoBefore = count("country='US' AND latitude=0 AND longitude=0")
		geoFilled = fillGeonamesPlaceholders(db, geonames)
		const geoAfter = count("country='US' AND latitude=0 AND longitude=0")
		console.error(
			`GeoNames pass: ${geonames.size.toLocaleString()} postcodes parsed; filled ${geoFilled.toLocaleString()} rows ` +
				`(${pct(geoBefore)}% → ${pct(geoAfter)}% placeholder). ` +
				`Attribution required: "GeoNames (CC-BY 4.0)".`
		)
	}

	const afterAll = count("country='US' AND latitude=0 AND longitude=0")
	db.close()

	console.error(
		`${dbPath}: total filled ${(zctaFilled + geoFilled).toLocaleString()} rows across both passes; ` +
			`placeholder rate ${pct(beforeAll)}% → ${pct(afterAll)}% of ${total.toLocaleString()} US postcodes. ` +
			`Residual = no ZCTA and no GeoNames entry (PO-box/unique ZIPs not in either source).`
	)
}

main()
