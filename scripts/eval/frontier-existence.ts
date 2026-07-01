#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #826 KILL-SWITCH PROBE — the cheap (no-ONNX, no-geocode) existence check that decides the B payload
 *   before committing the night to a gazetteer rebuild. The 2026-06-26 frontier diagnostic
 *   (`docs/articles/evals/2026-06-26-frontier-gap.md`) marked 97 countries "residual" — but it ran
 *   admin-only (`MAILWOMAN_CANDIDATE_DB` unset) AND predates the 2026-06-27 GeoNames-alias fold
 *   (`candidate-global-geonames.db`). So its residual conflates three very different causes. This probe
 *   asks the RIGHT question directly against the canonical candidate table: for each frontier country's
 *   top-K cities, is the city REACHABLE by the resolver under SOME surface form?
 *
 *   Reachability uses the resolver's own `normalizeLocalityForKey` (plain NFKD fold) against the stored
 *   `name_key` column — the exact key the candidate lookup probes. For each geonames city we fold the
 *   primary name, the ascii name, AND every alternatename, and ask whether ANY of those keys has a row
 *   for that country. That tells us, per city:
 *
 *   - reachable via the ENGLISH/ascii surface form        → already covered, English-reachable
 *   - reachable ONLY via a non-ascii alternatename        → exonym already folded (no B work needed)
 *   - NOT reachable, but the country HAS candidate rows    → city-level coverage gap (add the city)
 *   - country has ZERO candidate rows                      → country-level coverage absence (the real gap)
 *
 *   Bucketed per country → the B-payload decision: alt-name fold (if exonym-only dominates), coverage
 *   expansion (if absence dominates), or "already covered" (if the fold is done — redirect the night).
 *
 *   Run: node scripts/eval/frontier-existence.ts [--per-country 3] [--min-pop 50000] [--out <md>]
 *   Reads $MAILWOMAN_CANDIDATE_DB or the canonical `<data-root>/wof/candidate.db` symlink.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { ISO2_TO_NAME } from "@mailwoman/codex/country"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"

import { arg } from "../lib/cli-args.ts"

const PER_COUNTRY = Number(arg("per-country", "3"))
const MIN_POP = Number(arg("min-pop", "50000"))
const OUT = arg("out", "")
const CITIES = `${mailwomanDataRoot()}/geonames/cities15000.txt`
const DB_PATH =
	process.env["MAILWOMAN_CANDIDATE_DB"] && existsSync(process.env["MAILWOMAN_CANDIDATE_DB"])
		? process.env["MAILWOMAN_CANDIDATE_DB"]!
		: `${mailwomanDataRoot()}/wof/candidate.db`

if (!existsSync(DB_PATH)) {
	console.error(`candidate DB not found: ${DB_PATH} (set $MAILWOMAN_CANDIDATE_DB)`)
	process.exit(1)
}

interface City {
	name: string
	ascii: string
	alts: string[]
	cc: string
	pop: number
}

// --- city sample: top-K by population per country ---
const byCountry = new Map<string, City[]>()

for (const line of readFileSync(CITIES, "utf8").split("\n")) {
	if (!line) continue
	const f = line.split("\t")
	const name = f[1]
	const ascii = f[2] ?? ""
	const alts = (f[3] ?? "").split(",").filter(Boolean)
	const cc = f[8]
	const pop = Number(f[14])

	if (!name || !cc || pop < MIN_POP) continue

	if (!byCountry.has(cc)) byCountry.set(cc, [])
	byCountry.get(cc)!.push({ name, ascii, alts, cc, pop })
}

// --- canonical candidate DB (read-only) ---
const db = new DatabaseSync(DB_PATH, { readOnly: true })
const codeToID = new Map<string, number>()

for (const r of db.prepare("SELECT id, code FROM country_codes").all() as Array<{ id: number; code: string }>) {
	codeToID.set(r.code, r.id)
}
const rowsByCountry = new Map<number, number>()

for (const r of db.prepare("SELECT country_id, COUNT(*) n FROM candidate GROUP BY country_id").all() as Array<{
	country_id: number
	n: number
}>) {
	rowsByCountry.set(r.country_id, r.n)
}
const hasKey = db.prepare("SELECT 1 FROM candidate WHERE country_id = ? AND name_key = ? LIMIT 1")
const keyReachable = (countryID: number, key: string): boolean =>
	key.length > 0 && hasKey.get(countryID, key) !== undefined

type Bucket = "english" | "exonym" | "city_absent" | "country_absent"
interface CountryResult {
	cc: string
	name: string
	rows: number
	cities: number
	english: number
	exonym: number
	cityAbsent: number
	countryAbsent: number
}

const results: CountryResult[] = []

for (const [cc, cities] of byCountry) {
	if (cc === "US") continue // the non-US gap is the target; US strategy is untouched
	const countryName = ISO2_TO_NAME.get(cc) ?? cc
	cities.sort((a, b) => b.pop - a.pop)
	const top = cities.slice(0, PER_COUNTRY)
	const countryID = codeToID.get(cc)
	const rows = countryID == null ? 0 : (rowsByCountry.get(countryID) ?? 0)
	const res: CountryResult = {
		cc,
		name: countryName,
		rows,
		cities: top.length,
		english: 0,
		exonym: 0,
		cityAbsent: 0,
		countryAbsent: 0,
	}

	for (const c of top) {
		let bucket: Bucket

		if (countryID == null || rows === 0) {
			bucket = "country_absent"
		} else {
			const englishKeys = [normalizeLocalityForKey(c.name), normalizeLocalityForKey(c.ascii)]
			const englishReachable = englishKeys.some((k) => keyReachable(countryID, k))

			if (englishReachable) {
				bucket = "english"
			} else {
				const altReachable = c.alts.some((a) => keyReachable(countryID, normalizeLocalityForKey(a)))
				bucket = altReachable ? "exonym" : "city_absent"
			}
		}

		if (bucket === "english") res.english++
		else if (bucket === "exonym") res.exonym++
		else if (bucket === "city_absent") res.cityAbsent++
		else res.countryAbsent++
	}
	results.push(res)
}
db.close()

// --- aggregate ---
results.sort((a, b) => a.rows - b.rows || a.cc.localeCompare(b.cc))
const sum = (k: "english" | "exonym" | "cityAbsent" | "countryAbsent"): number => results.reduce((s, r) => s + r[k], 0)
const totalCities = results.reduce((s, r) => s + r.cities, 0)
const zeroCoverage = results.filter((r) => r.rows === 0)
const reachableCountries = results.filter((r) => r.english + r.exonym === r.cities && r.cities > 0)
const exonymOnlyCountries = results.filter((r) => r.exonym > 0 && r.english < r.cities)

const pct = (a: number): string => ((a / totalCities) * 100).toFixed(1)

const L: string[] = []
L.push("# #826 kill-switch existence probe — candidate-DB reachability by country")
L.push("")
L.push(`_DB: \`${DB_PATH}\`. geonames cities15000, top ${PER_COUNTRY}/country (pop ≥ ${MIN_POP}), US excluded._`)
L.push(`_Reachable = the resolver's \`normalizeLocalityForKey\` fold of the city's name / ascii / any`)
L.push(`alternatename matches a stored \`name_key\` for that country (the exact lookup key). No geocode._`)
L.push("")
L.push(`- Cities probed: **${totalCities}** across **${results.length}** non-US countries`)
L.push(
	`- City buckets: **${sum("english")}** english-reachable (${pct(sum("english"))}%) · **${sum("exonym")}** exonym-only-reachable (${pct(sum("exonym"))}%) · **${sum("cityAbsent")}** city-absent (${pct(sum("cityAbsent"))}%) · **${sum("countryAbsent")}** in a zero-coverage country (${pct(sum("countryAbsent"))}%)`
)
L.push(`- **${zeroCoverage.length}** countries have ZERO candidate rows (pure coverage absence)`)
L.push(`- **${exonymOnlyCountries.length}** countries rely on an exonym/alt-name for at least one top city`)
L.push("")
L.push(`## Payload signal`)
L.push("")
L.push(`The alt-name FOLD is already in the canonical DB (geonames alternatenames are indexed as name_key rows).`)
L.push(
	`So the lever is **coverage**: \`country-absent\` (${pct(sum("countryAbsent"))}%) + \`city-absent\` (${pct(sum("cityAbsent"))}%) is the addressable gap; \`exonym-only\` (${pct(sum("exonym"))}%) is the residual the fold genuinely buys.`
)
L.push("")
L.push(`## Zero-coverage countries (the coverage-expansion target)`)
L.push("")
L.push("| Country | ISO2 | top cities probed |")
L.push("| --- | --- | ---: |")

for (const r of zeroCoverage) L.push(`| ${r.name} | ${r.cc} | ${r.cities} |`)
L.push("")
L.push(`## Countries with rows but a missing top city (city-level gap)`)
L.push("")
L.push("| Country | ISO2 | rows | english | exonym | city-absent |")
L.push("| --- | --- | ---: | ---: | ---: | ---: |")

for (const r of results.filter((r) => r.rows > 0 && r.cityAbsent > 0)) {
	L.push(`| ${r.name} | ${r.cc} | ${r.rows} | ${r.english} | ${r.exonym} | ${r.cityAbsent} |`)
}
L.push("")
L.push(`## Exonym-only reliance (where the fold is load-bearing)`)
L.push("")
L.push("| Country | ISO2 | rows | english | exonym |")
L.push("| --- | --- | ---: | ---: | ---: |")

for (const r of exonymOnlyCountries.filter((r) => r.rows > 0)) {
	L.push(`| ${r.name} | ${r.cc} | ${r.rows} | ${r.english} | ${r.exonym} |`)
}

const report = L.join("\n")
console.log(report.split("\n").slice(0, 18).join("\n"))
console.log("…")

if (OUT) {
	writeFileSync(OUT, `${report}\n`)
	console.error(`[frontier-existence] wrote ${OUT}`)
}
