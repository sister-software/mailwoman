/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #936 option 3 data bridge — stamp `names.official` onto a COPY of the live admin DB from a
 *   pairs file, until the next full `build-unified-wof` rebuild carries the #940 ingest bit
 *   natively. Same build-on-copy idiom as `augment-admin-overture.ts` (the operator-validated
 *   alternative to a full rebuild — see the 2026-06-20 night postmortem): the shipped DB is never
 *   touched; the output is a NEW artifact that must pass its gate battery before any swap.
 *
 *   Pairs come from the #936 risk probe
 *   (`scripts/diagnostic/exonym-official-collision-probe.ts --emit-pairs`): one JSON line per
 *   `{id, name}` where `name` is a LOWERCASED official-language, preferred-form, non-historic
 *   alias of place `id` (cut A officialness, name-level historic exclusion — the reviewed rule).
 *   Matching against the DB's original-case rows happens here in JS because SQLite's NOCASE
 *   collation folds ASCII only ("åbo" would never match "Åbo" in SQL).
 *
 *   Usage: node scripts/augment-admin-official-names.ts \
 *     --in  $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db \
 *     --out $MAILWOMAN_DATA_ROOT/wof/admin-global-priority-official.db \
 *     --pairs <pairs.jsonl>
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"

const { values: a } = parseArgs({
	options: {
		in: { type: "string", default: String(dataRootPath("wof", "admin-global-priority.db")) },
		out: { type: "string", default: String(dataRootPath("wof", "admin-global-priority-official.db")) },
		pairs: { type: "string" },
	},
})

const input = a.in!
const output = a.out!
const pairsPath = a.pairs

if (!pairsPath || !existsSync(pairsPath)) {
	console.error("--pairs <pairs.jsonl> required (from the #936 probe's --emit-pairs)")
	process.exit(1)
}

if (input === output) {
	console.error("refusing to write over the input — pick a distinct --out (build-on-copy, never in place)")
	process.exit(1)
}

if (!existsSync(input)) {
	console.error(`input DB not found: ${input}`)
	process.exit(1)
}

const pairs = readFileSync(pairsPath, "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l) as { id: number; name: string })

console.error(`official-name augment → ${output}`)
console.error(`  source (read via copy, never mutated): ${input}`)
console.error(`  pairs: ${pairs.length.toLocaleString()} from ${pairsPath}`)

copyFileSync(input, output)
const db = new DatabaseSync(output)

// Idempotent column add — the next full rebuild ships the column natively via createUnifiedSchema.
const hasColumn = (db.prepare(`PRAGMA table_info(names)`).all() as Array<{ name: string }>).some(
	(c) => c.name === "official"
)

if (!hasColumn) db.exec(`ALTER TABLE names ADD COLUMN official INTEGER NOT NULL DEFAULT 0`)

const selectNames = db.prepare(`SELECT rowid, name FROM names WHERE id = ?`)
const stamp = db.prepare(`UPDATE names SET official = 1 WHERE rowid = ?`)

// Group pairs by id so each place's names are fetched once.
const byID = new Map<number, Set<string>>()

for (const p of pairs) {
	let set = byID.get(p.id)

	if (!set) byID.set(p.id, (set = new Set()))
	set.add(p.name)
}

let stamped = 0
let missed = 0

db.exec("BEGIN")

for (const [id, wanted] of byID) {
	const rows = selectNames.all(id) as Array<{ rowid: number; name: string }>
	let hit = false

	for (const r of rows) {
		if (wanted.has(r.name.toLowerCase().trim())) {
			stamp.run(r.rowid)
			stamped++
			hit = true
		}
	}

	if (!hit) missed++
}
db.exec("COMMIT")
db.exec("ANALYZE")

const integrity = db.prepare(`PRAGMA quick_check`).get() as { quick_check: string }

console.error(`  stamped ${stamped.toLocaleString()} name rows official=1 (${missed} places had no matching row)`)
console.error(`  quick_check: ${integrity.quick_check}`)
db.close()

if (integrity.quick_check !== "ok") process.exit(1)
