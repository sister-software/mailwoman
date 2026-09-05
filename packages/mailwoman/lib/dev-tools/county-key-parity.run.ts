/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file County-key parity between the TIGER interpolation extracts and WOF's county ancestry, per US state (#2129).
 *
 *   A county-scoped join from a WOF county ancestor into a TIGER county-keyed extract reads "no data" wherever the two
 *   registers disagree about what a county is, and that absence is indistinguishable from "not there". This measures
 *   the cheap half of the check the issue asks for: for every state extract under `$MAILWOMAN_DATA_ROOT/interpolation`,
 *   the count of distinct `county_fips` values against the count of WOF `county` records whose region ancestor is that
 *   state. Equal counts do not prove the keys correspond; unequal counts prove they cannot.
 *
 *   Measured 2026-09-05 over 51 extracts: two mismatches — Connecticut (9 planning-region codes 09110–09190 in TIGER
 *   2023 against WOF's 8 historical counties) and Alaska (30 against 29, the 2019 Valdez-Cordova split).
 *
 *   Usage: node packages/mailwoman/lib/dev-tools/county-key-parity.run.ts [--candidate <candidate.db>]
 *   [--interpolation <dir>] [--json <out>]
 */

import { US_STATE_BY_ABBREVIATION, type USStateAbbreviation } from "@mailwoman/codex/us/state"
import { dataRootPath } from "@mailwoman/core/data-root"
import { readDirectory } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"

interface StateParity {
	state: string
	name: string
	tigerCountyKeys: number
	wofCounties: number | null
	match: boolean | null
	tigerKeys: string[]
}

const EXTRACT_NAME = /^interpolation-us-([a-z]{2})\.db$/u

/**
 * WOF county counts per state, from the candidate register's ancestry: a `county` whose `region` ancestor is the state.
 */
function wofCountiesByState(candidatePath: string): Map<string, number> {
	using cand = new DatabaseClient<never>(candidatePath, { readOnly: true })

	const rows = cand
		.prepare(
			`select a.parent_name state, count(distinct c.spr_id) n
			 from candidate c
			 join placetype_codes pt on pt.id = c.placetype_id
			 join country_codes cc on cc.id = c.country_id
			 join candidate_ancestor a on a.spr_id = c.spr_id
			 join placetype_codes ppt on ppt.id = a.parent_placetype_id
			 where cc.code = 'US' and pt.placetype = 'county' and ppt.placetype = 'region'
			 group by a.parent_name`
		)
		.all() as Array<{ state: string; n: number }>

	return new Map(rows.map((row) => [row.state, row.n]))
}

export async function countyKeyParity(candidatePath: string, interpolationDir: string): Promise<StateParity[]> {
	const wof = wofCountiesByState(candidatePath)
	const files = (await readDirectory(interpolationDir)).filter((file) => EXTRACT_NAME.test(file)).toSorted()
	const report: StateParity[] = []

	for (const file of files) {
		const state = EXTRACT_NAME.exec(file)![1]!.toUpperCase() as USStateAbbreviation
		const name = US_STATE_BY_ABBREVIATION[state] ?? state
		using db = new DatabaseClient<never>(join(interpolationDir, file), { readOnly: true })

		const tigerKeys = (
			db.prepare("select distinct county_fips from street_segment order by county_fips").all() as Array<{
				county_fips: string
			}>
		).map((row) => row.county_fips)

		const wofCounties = wof.get(name) ?? null

		report.push({
			state,
			name,
			tigerCountyKeys: tigerKeys.length,
			wofCounties,
			match: wofCounties === null ? null : wofCounties === tigerKeys.length,
			tigerKeys,
		})
	}

	return report
}

async function main(): Promise<void> {
	const { values } = parseArguments({
		options: {
			candidate: { type: "string" },
			interpolation: { type: "string" },
			json: { type: "string" },
		},
	})

	const candidatePath = values.candidate ?? String(dataRootPath("wof", "candidate.db"))
	const interpolationDir = values.interpolation ?? String(dataRootPath("interpolation"))
	const report = await countyKeyParity(candidatePath, interpolationDir)
	const mismatches = report.filter((row) => row.match === false)

	for (const row of mismatches) {
		console.log(
			`${row.state} (${row.name}): TIGER county_fips distinct=${row.tigerCountyKeys}  WOF counties=${row.wofCounties}  keys=${row.tigerKeys.join(",")}`
		)
	}

	console.log(
		`states compared: ${report.length}; mismatching: ${mismatches.length}; unmeasured (no WOF count): ${report.filter((row) => row.match === null).length}`
	)

	if (values.json) {
		await writeLocalJSONFile(report, values.json)
	}
}

runIfScript(import.meta, main)
