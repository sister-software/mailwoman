/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerate a COMPLETE situs attribution manifest from the address-point shards on disk. The
 *   national build driver (`build-national-situs.mjs`) only records the states it built in a given
 *   run, so after incremental / resumed builds its `ATTRIBUTION.json` undercounts. This reads every
 *   `address-points-us-*.db` in the directory and aggregates the per-row `source`
 *   (`overture:<dataset>`) provenance into a full ledger — the document we owe consumers for the
 *   OpenAddresses attribution obligation (NAD is US public domain; the named OA sources want
 *   credit).
 *
 *   Usage: node scripts/situs-attribution-manifest.mjs [--out-dir <path>] [--release <tag>]
 */

import { readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
	options: {
		"out-dir": { type: "string", default: "/mnt/playpen/mailwoman-data/address-points" },
		release: { type: "string", default: "2026-05-20.0" },
	},
})

const outDir = args["out-dir"]
// Canonical per-state shards only: address-points-us-<2-letter-slug>.db. Excludes county-scoped dev
// artifacts (e.g. address-points-us-il-cook.db) that overlap a state shard and the CLI never selects.
const shardFiles = readdirSync(outDir)
	.filter((f) => /^address-points-us-[a-z]{2}\.db$/.test(f))
	.sort()

const manifest = {
	release: args.release,
	regeneratedFromShards: shardFiles.length,
	totalPoints: 0,
	datasetTotals: {},
	states: {},
}

for (const file of shardFiles) {
	const slug = file.replace(/^address-points-us-/, "").replace(/\.db$/, "")
	let db
	try {
		db = new DatabaseSync(path.join(outDir, file), { readOnly: true })
	} catch {
		manifest.states[slug] = { ok: false, error: "unreadable" }
		continue
	}
	try {
		const rows = db.prepare("SELECT source, count(*) AS n FROM address_point GROUP BY source").all()
		const datasets = {}
		let points = 0
		for (const { source, n } of rows) {
			const ds = String(source).replace(/^overture:/, "")
			datasets[ds] = Number(n)
			manifest.datasetTotals[ds] = (manifest.datasetTotals[ds] ?? 0) + Number(n)
			points += Number(n)
		}
		manifest.states[slug] = { ok: true, points, datasets }
		manifest.totalPoints += points
		console.log(`${slug.padEnd(8)} ${points.toLocaleString().padStart(12)} points · ${rows.length} sources`)
	} finally {
		db.close()
	}
}

// Sort datasetTotals descending for readability.
manifest.datasetTotals = Object.fromEntries(Object.entries(manifest.datasetTotals).sort((a, b) => b[1] - a[1]))

writeFileSync(path.join(outDir, "ATTRIBUTION.json"), JSON.stringify(manifest, null, 2))
console.log(`\n${shardFiles.length} shards · ${manifest.totalPoints.toLocaleString()} total points`)
const top = Object.entries(manifest.datasetTotals).slice(0, 6)
console.log(`top sources:`)
for (const [ds, n] of top) console.log(`  ${ds.padEnd(40)} ${n.toLocaleString()}`)
console.log(`→ ${path.join(outDir, "ATTRIBUTION.json")}`)
