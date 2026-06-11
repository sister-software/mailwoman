/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI for the Census ZCTA centroid fill (#525) — fills `(0,0)`-placeholder US postcode rows in
 *   `postalcode-us.db` from the ZCTA Gazetteer file, with per-row provenance in `centroid_source`.
 *   Logic + contract tests live in `scripts/zcta-centroids.ts`. Run after any rebuild of the US
 *   postcode shard (recorded as a `post_build` step in `scripts/wof-build-manifest.json`);
 *   idempotent, never overwrites a real coordinate.
 *
 *   Usage: node --experimental-strip-types scripts/fill-zcta-centroids.ts\
 *   [--db /mnt/playpen/mailwoman-data/wof/postalcode-us.db]\
 *   [--zcta /mnt/playpen/mailwoman-data/census/2024_Gaz_zcta_national.txt]
 */

import { existsSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { fillPlaceholderCentroids, parseZctaCentroids } from "./zcta-centroids.ts"

function main(): void {
	const args = process.argv.slice(2)
	let dbPath = "/mnt/playpen/mailwoman-data/wof/postalcode-us.db"
	let zctaPath = "/mnt/playpen/mailwoman-data/census/2024_Gaz_zcta_national.txt"
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--db" && args[i + 1]) dbPath = args[++i]!
		else if (args[i] === "--zcta" && args[i + 1]) zctaPath = args[++i]!
	}
	for (const p of [dbPath, zctaPath]) {
		if (!existsSync(p)) {
			console.error(`Missing file: ${p}`)
			process.exit(1)
		}
	}

	const zcta = parseZctaCentroids(readFileSync(zctaPath, "utf8"))
	const db = new DatabaseSync(dbPath)
	const count = (where: string): number =>
		(
			db.prepare(`SELECT COUNT(*) n FROM spr WHERE placetype='postalcode' AND is_current!=0 AND ${where}`).get() as {
				n: number
			}
		).n

	const total = count("country='US'")
	const before = count("country='US' AND latitude=0 AND longitude=0")
	const filled = fillPlaceholderCentroids(db, zcta)
	const after = count("country='US' AND latitude=0 AND longitude=0")
	db.close()

	const pct = (n: number) => ((100 * n) / total).toFixed(1)
	console.error(
		`${dbPath}: ${zcta.size.toLocaleString()} ZCTAs; filled ${filled.toLocaleString()} of ${before.toLocaleString()} placeholders ` +
			`(${pct(before)}% → ${pct(after)}% of ${total.toLocaleString()} US postcodes; residual = no ZCTA, mostly PO-box/unique ZIPs)`
	)
}

main()
