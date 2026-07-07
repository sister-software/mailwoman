import { DatabaseSync } from "node:sqlite"

import { dataRootPath } from "@mailwoman/core/utils"

const f = process.argv[2] || dataRootPath("address-points", "address-points-us-ca.db")
const d = new DatabaseSync(f, { readOnly: true })
const PS = (d.prepare("PRAGMA page_size").get() as { page_size: number }).page_size

console.log("DB:", f, " page_size:", PS)
console.log("\nINDEXES:")

for (const r of d.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all() as Array<{
	name: string
	sql: string | null
}>) {
	console.log("  ", r.sql || r.name)
}

const row = d
	.prepare(
		"SELECT postcode, street_norm, number, locality_norm FROM address_point WHERE postcode IS NOT NULL AND number IS NOT NULL LIMIT 1"
	)
	.get() as { postcode: string; street_norm: string; number: string; locality_norm: string }
console.log("\nSAMPLE:", JSON.stringify(row))

console.log("\nQUERY PLAN (postcode-scoped):")

for (const r of d
	.prepare(
		"EXPLAIN QUERY PLAN SELECT lat,lon,source,release FROM address_point WHERE postcode=? AND street_norm=? AND number=? LIMIT 1"
	)
	.all(row.postcode, row.street_norm, row.number) as Array<{ detail: string }>) {
	console.log("  ", r.detail)
}

// dbstat: pages backing the index used + the table. A byte-range index lookup descends the index
// B-tree (depth) + reads the matching leaf + one table row page. We report the B-tree DEPTH (≈ pages
// touched per descent) which is what byte-range actually fetches — NOT the whole index.
try {
	const idxRows = d
		.prepare("SELECT name, count(*) AS pages FROM dbstat WHERE name LIKE 'idx_ap_%' GROUP BY name")
		.all() as Array<{ name: string; pages: number }>
	console.log("\nINDEX page footprint (total, NOT per-query):")

	for (const r of idxRows) {
		console.log(`   ${r.name}: ${r.pages} pages (${((r.pages * PS) / 1e6).toFixed(1)} MB)`)
	}
} catch (e) {
	console.log("\n(dbstat unavailable:", (e as Error).message, ")")
}

// Estimate B-tree depth for idx_ap_postcode from row count + a conservative fanout.
const n = (d.prepare("SELECT count(*) c FROM address_point").get() as { c: number }).c
// SQLite interior index pages hold ~ page_size / avg_key_bytes entries; composite key (postcode,
// street_norm, number) ~ 40 bytes → fanout ~ 100. depth = ceil(log_fanout(N)).
const fanout = 100
const depth = Math.ceil(Math.log(n) / Math.log(fanout))
const pagesPerLookup = depth + 1 /* leaf already counted in depth */ + 1 /* table row page */
console.log(`\nrows: ${n.toLocaleString()}  est index B-tree depth: ${depth}  → ~${pagesPerLookup} pages/lookup`)
console.log(
	`→ est bytes per geocode point-lookup: ~${pagesPerLookup * PS} bytes (${((pagesPerLookup * PS) / 1024).toFixed(0)} KB)`
)

// timed warm lookups (lower bound; browser adds network RTT per page fetch)
let ms = 0
const N = 50

for (let i = 0; i < N; i++) {
	const t0 = process.hrtime.bigint()
	d.prepare("SELECT lat,lon FROM address_point WHERE postcode=? AND street_norm=? AND number=? LIMIT 1").get(
		row.postcode,
		row.street_norm,
		row.number
	)
	ms += Number(process.hrtime.bigint() - t0) / 1e6
}
console.log(
	`local warm lookup: ${(ms / N).toFixed(3)} ms avg (×${N}) — lower bound; byte-range adds ~RTT per page round-trip`
)
