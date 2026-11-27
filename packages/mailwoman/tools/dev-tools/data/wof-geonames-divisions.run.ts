// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Completes a country's first- and second-level divisions in its `mailwoman` WOF fork from GeoNames.
 *
 *   The library is `@mailwoman/gazetteer/tools/pipeline/wof/geonames-divisions`.
 *
 *   The specification is a JSON file such as `packages/gazetteer/tools/pipeline/mw/division-backfill.json`.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/data/wof-geonames-divisions.run.ts
 *   --spec <file> [--dry-run]
 */

import { dataRootPath, wofReposPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import {
	backfillGeoNamesDivisions,
	type GeoNamesDivisionSpec,
} from "@mailwoman/gazetteer/tools/pipeline/wof/geonames-divisions"

const { values } = parseArguments({
	options: {
		spec: { type: "string", description: "The division specification, a JSON file" },
		repos: { type: "string", description: "WOF repos root. Default <cache-root>/sources/wof-repos" },
		report: { type: "string", description: "Write the whole result to this JSON file" },
		"dry-run": { type: "boolean", default: false, description: "Report the changes and write no record" },
	},
})

const result = await backfillGeoNamesDivisions({
	spec: await readLocalJSONFile<GeoNamesDivisionSpec>(requiredArgument("wof-geonames-divisions", "spec", values.spec)),
	reposRoot: values.repos ?? wofReposPath,
	geonamesDir: dataRootPath("geonames"),
	dryRun: values["dry-run"],
	lastModified: Math.floor(Date.now() / 1000),
})

if (values.report) {
	await writeLocalJSONFile(result, values.report)
}

console.log(`${values["dry-run"] ? "dry run" : "applied"}: ${result.repoDir}`)
console.log(`records written: ${result.written.map((row) => `${row.name} (${row.placetype})`).join(", ") || 0}`)
console.log(`existing records changed: ${result.changed.map((row) => `${row.name} → ${row.parent}`).join(", ") || 0}`)
console.log(`records below a retyped record rewritten: ${result.descendants}`)
console.log(`divisions whose record already states a parent: ${result.kept}`)
