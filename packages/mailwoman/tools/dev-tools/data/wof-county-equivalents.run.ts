// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes a `county` record into the `mailwoman` US WOF fork for each county equivalent of
 *   one state that the fork holds no record of, as the union of the fork's town records.
 *
 *   The library is `@mailwoman/gazetteer/tools/pipeline/us/county-equivalents`.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/data/wof-county-equivalents.run.ts
 *   --state 09 --counties <tl_2024_us_county.shp> [--dry-run]
 */

import { wofReposPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { backfillCountyEquivalents, readTIGERCounties } from "@mailwoman/gazetteer/tools/pipeline/us/county-equivalents"
import {
	CensusGazetteerKind,
	DEFAULT_CENSUS_GAZETTEER_VINTAGE,
	fetchCensusGazetteer,
	readCensusGazetteer,
} from "@mailwoman/tiger/sdk/gazetteer"

const { values } = parseArguments({
	options: {
		state: { type: "string", description: "Two-digit FIPS code of the state, 09 for Connecticut" },
		counties: { type: "string", description: "The TIGER/Line national county shapefile" },
		repos: { type: "string", description: "WOF repos root. Default <cache-root>/sources/wof-repos" },
		report: { type: "string", description: "Write the whole result to this JSON file" },
		"dry-run": { type: "boolean", default: false, description: "Report the records and write no file" },
	},
})

const stateFIPS = requiredArgument("wof-county-equivalents", "state", values.state)
const vintage = DEFAULT_CENSUS_GAZETTEER_VINTAGE
const gazetteer = await fetchCensusGazetteer(CensusGazetteerKind.CountySubdivision, { vintage })
const subdivisions: string[] = []

for await (const row of readCensusGazetteer(gazetteer, CensusGazetteerKind.CountySubdivision)) {
	if (row.geoid.startsWith(stateFIPS)) {
		subdivisions.push(row.geoid)
	}
}

const result = await backfillCountyEquivalents({
	counties: await readTIGERCounties(requiredArgument("wof-county-equivalents", "counties", values.counties), stateFIPS),
	subdivisions,
	stateFIPS,
	vintage,
	reposRoot: values.repos ?? wofReposPath,
	dryRun: values["dry-run"],
	lastModified: Math.floor(Date.now() / 1000),
})

if (values.report) {
	await writeLocalJSONFile(result, values.report)
}

console.log(`${values["dry-run"] ? "dry run" : "applied"}: ${result.repoDir}`)
console.log(`records written: ${result.written.map((row) => `${row.name} (${row.subdivisions})`).join(", ")}`)
console.log(`already held by a county record's GEOID: ${result.alreadyHeld}`)
console.log(
	`with a subdivision the fork holds no record of: ${result.incomplete.map((row) => `${row.name} (${row.absent.join(" ")})`).join(", ") || 0}`
)
