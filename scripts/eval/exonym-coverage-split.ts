import { readFileSync } from "node:fs"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #826 exonym-vs-coverage kill-switch probe. Before committing a candidate-gazetteer rebuild, split the
 *   non-US resolution gap into its two sub-causes so the rebuild payload is chosen on evidence:
 *
 *   - **exonym-mismatch** — the record IS in the table under a LOCAL/alt name (Warszawa, München, Praha) but
 *     the ENGLISH surface form (Warsaw, Munich, Prague) has no key. An alt-name FOLD fixes it.
 *   - **coverage-absent** — no key for the city under the right country at all. Only a COVERAGE expansion
 *     (add the rows) fixes it.
 *
 *   Pure name_key existence probe against the current canonical candidate table — NO model, NO resolver,
 *   seconds not minutes. Decision rule (#826): ≥60% exonym → alt-name fold · ≤40% → coverage expansion ·
 *   40–60% → both.
 *
 *   Usage: node scripts/eval/exonym-coverage-split.ts [--per-country 3] [--min-pop 15000] [--db <candidate.db>]
 */
import { DatabaseSync } from "node:sqlite"

import { dataRootPath } from "@mailwoman/core/utils"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"

const argv = process.argv.slice(2)
const arg = (name: string, dflt: string): string => {
	const i = argv.indexOf(`--${name}`)

	return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt
}
const PER_COUNTRY = Number(arg("per-country", "3"))
const MIN_POP = Number(arg("min-pop", "15000"))
const DB_PATH = arg("db", dataRootPath("wof", "candidate.db"))
const CITIES = dataRootPath("geonames", "cities15000.txt")

interface City {
	name: string
	ascii: string
	alt: string[]
	cc: string
	pop: number
}

const byCountry = new Map<string, City[]>()

for (const line of readFileSync(CITIES, "utf8").split("\n")) {
	const f = line.split("\t")

	if (f.length < 15) continue
	const fcode = f[7] ?? ""

	if (!fcode.startsWith("PPL")) continue
	const pop = Number(f[14])

	if (!Number.isFinite(pop) || pop < MIN_POP) continue
	const cc = f[8] ?? ""

	if (!cc || cc === "US") continue // US is the trained locale — not the gap
	const city: City = { name: f[1] ?? "", ascii: f[2] ?? "", alt: (f[3] ?? "").split(",").filter(Boolean), cc, pop }
	const bag = byCountry.get(cc) ?? []
	bag.push(city)
	byCountry.set(cc, bag)
}

const db = new DatabaseSync(DB_PATH, { readOnly: true })
const ccToID = new Map<string, number>()

for (const r of db.prepare("SELECT id, code FROM country_codes").all() as Array<{ id: number; code: string }>) {
	ccToID.set(r.code, r.id)
}
const existsProbe = db.prepare("SELECT 1 FROM candidate WHERE name_key = ? AND country_id = ? LIMIT 1")
const hasKey = (key: string, cid: number): boolean => (key ? existsProbe.get(key, cid) !== undefined : false)

let covered = 0
let exonym = 0
let coverageAbsent = 0
let noCountry = 0
let sampled = 0
const perCountry = new Map<string, { covered: number; exonym: number; coverage: number }>()

for (const [cc, cities] of byCountry) {
	const cid = ccToID.get(cc)
	const top = cities.sort((a, b) => b.pop - a.pop).slice(0, PER_COUNTRY)
	const cstat = { covered: 0, exonym: 0, coverage: 0 }

	for (const city of top) {
		sampled += 1

		if (cid === undefined) {
			noCountry += 1

			continue // the candidate table doesn't carry this country at all — coverage-absent by definition
		}
		const englishKey = normalizeLocalityForKey(city.ascii)
		const localKey = normalizeLocalityForKey(city.name)
		const altKeys = city.alt.map(normalizeLocalityForKey)

		if (hasKey(englishKey, cid)) {
			covered += 1
			cstat.covered += 1
		} else if (hasKey(localKey, cid) || altKeys.some((k) => hasKey(k, cid))) {
			exonym += 1
			cstat.exonym += 1
		} else {
			coverageAbsent += 1
			cstat.coverage += 1
		}
	}
	perCountry.set(cc, cstat)
}

// The GAP = everything the English surface form doesn't already resolve. `noCountry` is coverage-absent.
const gap = exonym + coverageAbsent + noCountry
const coverageTotal = coverageAbsent + noCountry
const exonymPct = gap > 0 ? (100 * exonym) / gap : 0
const decision =
	exonymPct >= 60
		? "alt-name FOLD (exonym dominates)"
		: exonymPct <= 40
			? "COVERAGE expansion (absence dominates)"
			: "BOTH in one rebuild (40–60% split)"

console.log(`# #826 exonym-vs-coverage split — candidate rebuild kill-switch\n`)
console.log(
	`_${DB_PATH} · cities15000 top ${PER_COUNTRY}/country, pop ≥ ${MIN_POP}, ex-US · pure name_key existence_\n`
)
console.log(`- Sampled: **${sampled}** cities across **${byCountry.size}** countries`)
console.log(
	`- English surface form already resolves (**covered**): ${covered} (${((100 * covered) / sampled).toFixed(1)}%)`
)
console.log(
	`- **The gap** (${gap}): exonym-mismatch **${exonym}** · coverage-absent **${coverageTotal}** (of which ${noCountry} whole-country-missing)`
)
console.log(`- **Exonym share of the gap: ${exonymPct.toFixed(1)}%**`)
console.log(`\n## Decision (#826 rule): **${decision}**\n`)
console.log(`## Worst exonym countries (record present under local name, English key absent)\n`)
console.log(`| Country | exonym | coverage | covered |`)
console.log(`| --- | ---: | ---: | ---: |`)
for (const [cc, s] of [...perCountry.entries()].sort((a, b) => b[1].exonym - a[1].exonym).slice(0, 20)) {
	if (s.exonym === 0) continue
	console.log(`| ${cc} | ${s.exonym} | ${s.coverage} | ${s.covered} |`)
}
db.close()
process.exit(0)
