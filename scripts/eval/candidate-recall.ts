/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Candidate-table locality-recall harness. The browser demo resolves admin names against the
 *   FTS-free candidate gazetteer (build-candidate.ts), which keys on the EXACT shared-normalized
 *   name — so unlike the node FTS resolver it can't token-flex a surface variant. This measures how
 *   often a held-out OA locality name resolves to a candidate row in its own country, and buckets
 *   the misses so we can tell a missing-alias gap (enrichable) from an edit-distance variant
 *   (#531).
 *
 *   Usage: node --experimental-strip-types scripts/eval/candidate-recall.ts\
 *   --db $MAILWOMAN_DATA_ROOT/wof/candidate-global-intl.db\
 *   --eval '/tmp/reg/eu-eval-*.jsonl' [--sample 15]
 */
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { DatabaseSync } from "node:sqlite"
import { normalizeLocalityForKey, stripLocalityQualifier } from "../../resolver-wof-sqlite/street-normalize.ts"

const { values: a } = parseArgs({
	options: {
		db: { type: "string" },
		eval: { type: "string" }, // glob or comma list
		sample: { type: "string", default: "12" },
		"strip-fallback": { type: "boolean", default: false },
	},
})
if (!a.db || !a.eval) {
	console.error("--db and --eval are required")
	process.exit(1)
}
const STRIP = a["strip-fallback"] // measure the query-side {@link stripLocalityQualifier} fallback recovery

const files = a.eval.includes("*")
	? execSync(`ls ${a.eval}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean)
	: a.eval.split(",")

const db = new DatabaseSync(a.db, { readOnly: true })
const ADMIN_PT = ["locality", "localadmin", "region", "county", "borough", "macrohood", "neighbourhood"]
const ptList = ADMIN_PT.map((p) => `'${p}'`).join(",")
// in-country locality-ish hit for a name_key
const hitInCountry = db.prepare(
	`SELECT 1 FROM candidate c JOIN country_codes cc ON cc.id=c.country_id JOIN placetype_codes pc ON pc.id=c.placetype_id
	 WHERE c.name_key=? AND cc.code=? AND pc.placetype IN (${ptList}) LIMIT 1`
)
// does the key exist at all (any country / any placetype)?
const keyExistsAnywhere = db.prepare(`SELECT 1 FROM candidate WHERE name_key=? LIMIT 1`)

interface CountryStat {
	n: number
	hit: number
	missAbsent: number // name_key not in the table at all → missing alias / edit-distance variant
	missElsewhere: number // key exists but not as an in-country locality → country/placetype mismatch
	recovered: number // a MISS that a stripped-qualifier retry would have resolved (--strip-fallback)
	misses: Array<{ raw: string; key: string; absent: boolean }>
}
const stats = new Map<string, CountryStat>()
const sampleN = Number(a.sample)

for (const file of files) {
	for (const line of readFileSync(file, "utf8").trim().split("\n")) {
		if (!line) continue
		const row = JSON.parse(line) as {
			expected?: { locality?: string }
			source?: string
		}
		const loc = row.expected?.locality
		const country = (row.source?.split(":")[1] ?? "").toUpperCase()
		if (!loc || !country) continue
		const st = stats.get(country) ?? { n: 0, hit: 0, missAbsent: 0, missElsewhere: 0, recovered: 0, misses: [] }
		st.n++
		const key = normalizeLocalityForKey(loc)
		if (key && hitInCountry.get(key, country)) {
			st.hit++
		} else {
			const absent = !key || !keyExistsAnywhere.get(key)
			if (absent) st.missAbsent++
			else st.missElsewhere++
			// strip-fallback: would a qualifier-stripped retry resolve this miss in-country?
			if (STRIP) {
				const stripped = normalizeLocalityForKey(stripLocalityQualifier(loc))
				if (stripped && stripped !== key && hitInCountry.get(stripped, country)) st.recovered++
			}
			if (st.misses.length < sampleN) st.misses.push({ raw: loc, key, absent })
		}
		stats.set(country, st)
	}
}

let tot = 0,
	totHit = 0,
	totAbsent = 0,
	totElse = 0,
	totRecov = 0
const countries = [...stats.keys()].sort()
console.log(`\ncandidate-table locality recall (db: ${a.db})${STRIP ? " [+strip-fallback]" : ""}\n`)
console.log(`country  n      recall   miss:absent  miss:wrong-country/pt${STRIP ? "  strip-recov  recall+strip" : ""}`)
for (const c of countries) {
	const s = stats.get(c)!
	tot += s.n
	totHit += s.hit
	totAbsent += s.missAbsent
	totElse += s.missElsewhere
	totRecov += s.recovered
	const r = ((100 * s.hit) / s.n).toFixed(1)
	const strip = STRIP
		? `   ${String(s.recovered).padStart(6)}      ${(((100 * (s.hit + s.recovered)) / s.n).toFixed(1) + "%").padStart(7)}`
		: ""
	console.log(
		`${c.padEnd(8)} ${String(s.n).padEnd(6)} ${r.padStart(5)}%   ${String(s.missAbsent).padStart(6)}       ${String(s.missElsewhere).padStart(6)}${strip}`
	)
}
const totStrip = STRIP
	? `   ${String(totRecov).padStart(6)}      ${(((100 * (totHit + totRecov)) / tot).toFixed(1) + "%").padStart(7)}`
	: ""
console.log(
	`\nTOTAL    ${String(tot).padEnd(6)} ${((100 * totHit) / tot).toFixed(1).padStart(5)}%   ${String(totAbsent).padStart(6)}       ${String(totElse).padStart(6)}${totStrip}`
)
console.log(
	`\nmiss buckets: absent=${totAbsent} (name not in table — missing alias / edit-distance), wrong-country-or-pt=${totElse}` +
		(STRIP ? `; strip-fallback recovers ${totRecov} (+${((100 * totRecov) / tot).toFixed(1)}pp recall)` : "") +
		`\n`
)

console.log("=== sample misses (raw → normalized key; ABSENT = key not in table at all) ===")
for (const c of countries) {
	const s = stats.get(c)!
	if (!s.misses.length) continue
	console.log(`\n[${c}]`)
	for (const m of s.misses)
		console.log(`  ${m.absent ? "ABSENT " : "elsewhr"}  ${JSON.stringify(m.raw)} → ${JSON.stringify(m.key)}`)
}
db.close()
