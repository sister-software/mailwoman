/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Board rows per country that can fail, beside the country's gazetteer share.
 *
 *   A row's `status` decides whether it checks or tracks. `pass` fails the run when its answer moves;
 *   `improvement_target` records a known-wrong answer and fails nothing. A single row count conflates them, so a
 *   country whose board is entirely trackers reports the same coverage as one that can go red.
 *
 *   The gazetteer share is the denominator: two checking rows is a different claim for India's 1,113,550 places
 *   than for a country holding a few thousand.
 *
 *   The loader walks two-letter directories only, so `generalization/` — parked passes — is outside every number
 *   here, which is the scope a gauntlet run sees.
 *
 *   Usage:
 *     node packages/mailwoman/lib/dev-tools/board-coverage-census.run.ts
 *     node packages/mailwoman/lib/dev-tools/board-coverage-census.run.ts --floor 6 --json <path>
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { renderMarkdownTable } from "@mailwoman/core/strings/markdown-table"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"

const { values: args } = parseArguments({
	options: {
		gazetteer: { type: "string" },
		floor: { type: "string" },
		json: { type: "string" },
	},
	strict: false,
})

/**
 * Checking rows a country is expected to hold. Not a threshold this census enforces — it prints which countries sit
 * under it so a floor can be argued from the list rather than asserted at one.
 */
const FLOOR = Number(args.floor ?? 6)

interface CountryCoverage {
	country: string
	rows: number
	checking: number
	tracking: number
	knownFail: number
	places: number | null
}

const cases = await loadRegressionCases()

const byCountry = new Map<string, CountryCoverage>()

for (const c of cases) {
	const cc = (c.country ?? "??").toUpperCase()
	let row = byCountry.get(cc)

	if (!row) {
		byCountry.set(cc, (row = { country: cc, rows: 0, checking: 0, tracking: 0, knownFail: 0, places: null }))
	}

	row.rows++

	if (c.status === "pass") {
		row.checking++
	} else if (c.status === "improvement_target") {
		row.tracking++
	} else {
		row.knownFail++
	}
}

/**
 * `spr` rows per country, or null everywhere when no gazetteer is readable. A missing artifact leaves the column
 * UNMEASURED rather than zero — a zero would read as "this country has no places", which is a finding and not what a
 * missing file says.
 */
const gazetteerPath = String(args.gazetteer ?? dataRootPath("wof", "admin-global-priority.db"))

if (await pathExists(gazetteerPath)) {
	using db = new DatabaseClient<WOFDatabase>(gazetteerPath, { readOnly: true })

	for (const row of db.prepare("SELECT country, COUNT(*) AS n FROM spr GROUP BY country").all() as Array<{
		country: string
		n: number
	}>) {
		const entry = byCountry.get((row.country ?? "").toUpperCase())

		if (entry) {
			entry.places = row.n
		}
	}
} else {
	console.error(`gazetteer ${gazetteerPath} not readable — the places column reads UNMEASURED, not zero`)
}

const all = [...byCountry.values()].toSorted((a, b) => b.checking - a.checking || a.country.localeCompare(b.country))

const totals = { rows: 0, checking: 0, tracking: 0, knownFail: 0 }

for (const r of all) {
	totals.rows += r.rows
	totals.checking += r.checking
	totals.tracking += r.tracking
	totals.knownFail += r.knownFail
}

const share = (n: number) => (totals.rows === 0 ? "unmeasured" : `${((n / totals.rows) * 100).toFixed(1)}%`)

console.log(`board rows the loader reads:  ${totals.rows.toLocaleString()} across ${all.length} countries`)
console.log(`  status pass — CHECKS:       ${totals.checking.toLocaleString()} (${share(totals.checking)})`)
console.log(`  improvement_target — TRACKS:${totals.tracking.toLocaleString().padStart(5)} (${share(totals.tracking)})`)
console.log(`  known_fail:                 ${totals.knownFail.toLocaleString()}`)

const thin = all.filter((r) => r.checking < FLOOR)

console.log(`\ncountries holding fewer than ${FLOOR} checking rows: ${thin.length} of ${all.length}`)
console.log(`  holding NONE: ${all.filter((r) => r.checking === 0).length}`)

const table = (header: readonly string[], rows: ReadonlyArray<readonly string[]>): string =>
	renderMarkdownTable(header, rows).join("\n")

console.log(`\nevery country, by checking rows:\n`)
console.log(
	table(
		["country", "rows", "checking", "tracking", "places", "places per checking row"],
		all.map((r) => [
			r.country,
			r.rows.toLocaleString(),
			String(r.checking),
			String(r.tracking),
			r.places === null ? "unmeasured" : r.places.toLocaleString(),
			r.places === null
				? "unmeasured"
				: r.checking === 0
					? "no checking row"
					: Math.round(r.places / r.checking).toLocaleString(),
		])
	)
)

console.log(`\nthin boards ranked by gazetteer share — where a checking row provides the most:\n`)
console.log(
	table(
		["country", "checking", "places"],
		thin
			.filter((r) => r.places !== null)
			.toSorted((a, b) => (b.places ?? 0) - (a.places ?? 0))
			.slice(0, 20)
			.map((r) => [r.country, String(r.checking), (r.places ?? 0).toLocaleString()])
	)
)

if (args.json) {
	await writeLocalTextFile(prettyJSON({ totals, floor: FLOOR, countries: all }), String(args.json))

	console.log(`\njson → ${args.json}`)
}
