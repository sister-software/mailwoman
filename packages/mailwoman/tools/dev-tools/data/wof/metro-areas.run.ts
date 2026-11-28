// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes a `metroarea` record into a `mailwoman` WOF fork for each core based
 *   statistical area whose counties the fork holds.
 *
 *   The library is `@mailwoman/gazetteer/tools/pipeline/us/metro-areas`.
 *
 *   The areas come from the Census gazetteer file of core based statistical areas, downloaded
 *   when absent, and each area's counties from the TIGER/Line national county shapefile.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/data/wof/metro-areas.run.ts
 *   --country US --counties <tl_2024_us_county.shp> [--dry-run]
 */

import { wofReposPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { backfillMetroAreas, readCBSACounties } from "@mailwoman/gazetteer/tools/pipeline/us/metro-areas"
import {
	CensusGazetteerKind,
	DEFAULT_CENSUS_GAZETTEER_VINTAGE,
	fetchCensusGazetteer,
	readCBSAGazetteer,
} from "@mailwoman/tiger/sdk/gazetteer"

const { values } = parseArguments({
	options: {
		country: {
			type: "string",
			default: "US",
			description: "ISO 3166-1 alpha-2 code of the fork that holds the counties",
		},
		counties: { type: "string", description: "The TIGER/Line national county shapefile" },
		repos: { type: "string", description: "WOF repos root. Default <cache-root>/sources/wof-repos" },
		report: { type: "string", description: "Write the whole result to this JSON file" },
		"dry-run": { type: "boolean", default: false, description: "Report the records and write no file" },
	},
})

const vintage = DEFAULT_CENSUS_GAZETTEER_VINTAGE
const gazetteer = await fetchCensusGazetteer(CensusGazetteerKind.CoreBasedStatisticalArea, { vintage })

const result = await backfillMetroAreas({
	areas: await Array.fromAsync(readCBSAGazetteer(gazetteer)),
	counties: await readCBSACounties(requiredArgument("wof-metro-areas", "counties", values.counties)),
	vintage,
	country: values.country,
	reposRoot: values.repos ?? wofReposPath,
	dryRun: values["dry-run"],
	lastModified: Math.floor(Date.now() / 1000),
})

if (values.report) {
	await writeLocalJSONFile(result, values.report)
}

console.log(`${values["dry-run"] ? "dry run" : "applied"}: ${result.repoDir}`)
console.log(`records written: ${result.written.length}`)
console.log(`already held by a record's CBSA code: ${result.alreadyHeld}`)
console.log(`with a county the fork holds no record of: ${result.incomplete.length}`)
console.log(`with every county in another fork: ${result.elsewhere}`)
