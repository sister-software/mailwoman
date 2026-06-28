#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Verify the FTS5 weighted-column fix (bm25(place_search, 10.0, 1.0)) ranks famous places above
 *   same-name impostors. Targeted at wof-hot.db (the slim browser-resolver artifact).
 *
 *   Usage: node resolver-wof-sqlite/spike/verify-weights.mjs /path/to/wof-hot.db
 */

import { DatabaseSync } from "node:sqlite"

const dbPath = process.argv[2]

if (!dbPath) {
	console.error("Usage: verify-weights.mjs <wof-hot.db>")
	process.exit(1)
}

const db = new DatabaseSync(dbPath, { readOnly: true })

function query(match, placetype) {
	const sql = placetype
		? `SELECT spr.name, spr.placetype, bm25(place_search, 10.0, 1.0) AS rank
		   FROM place_search
		   JOIN spr ON spr.id = place_search.wof_id
		   WHERE place_search MATCH ? AND spr.placetype = ?
		   ORDER BY rank ASC LIMIT 3`
		: `SELECT spr.name, spr.placetype, bm25(place_search, 10.0, 1.0) AS rank
		   FROM place_search
		   JOIN spr ON spr.id = place_search.wof_id
		   WHERE place_search MATCH ?
		   ORDER BY rank ASC LIMIT 3`

	return db.prepare(sql).all(...(placetype ? [match, placetype] : [match]))
}

let pass = 0
let fail = 0

function check(label, rows, predicate) {
	const top = rows[0]
	const ok = top && predicate(top)

	if (ok) {
		console.log(`✓ ${label}`)
		console.log(`    top: ${top.name} (${top.placetype}) rank=${top.rank.toFixed(2)}`)
		pass++
	} else {
		console.log(`✗ ${label}`)
		console.log(`    got top: ${top ? `${top.name} (${top.placetype}) rank=${top.rank.toFixed(2)}` : "<no rows>"}`)
		console.log(`    rows: ${JSON.stringify(rows, null, 2)}`)
		fail++
	}
}

console.log("--- FTS5 weighted-column verification ---\n")

// Q1: "new york" should top-rank New York (the city, NOT West New York)
check(`Q1: "new york" → top is "New York"`, query('"new york"', "locality"), (r) => r.name === "New York")

// Q2: "springfield" — top should be a real Springfield (population proxy: must not be a tiny one)
const springfields = query('"springfield"', "locality")
check(`Q2: "springfield" → top is a major Springfield (not random tiny one)`, springfields, (r) =>
	["Springfield"].includes(r.name)
)

// Q3: "big apple" → NYC via alt_names
check(`Q3: "big apple" → top is "New York"`, query('"big apple"'), (r) => r.name === "New York")

// Q4: 纽约 → NYC via Chinese alt_names. unicode61 + remove_diacritics 2 handles CJK.
check(`Q4: "纽约" → top is "New York"`, query('"纽约"'), (r) => r.name === "New York")

console.log(`\n--- ${pass} pass, ${fail} fail ---`)
process.exit(fail === 0 ? 0 : 1)
