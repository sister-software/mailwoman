// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Applies a reform of a country's first-level divisions to its `mailwoman` fork of
 *   Who's On First (`@mailwoman/gazetteer/tools/pipeline/wof/region-reform`).
 *
 *   The specification is a JSON file that lists the new units, their member records and the
 *   regions they replace, such as `packages/gazetteer/tools/pipeline/ke/region-reform.json`.
 *   The run prints a summary and, with `--report`, writes the whole result as JSON.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/data/wof/region-reform.run.ts --spec <file> [--dry-run]
 */

import { dataRootPath, wofReposPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	applyRegionReform,
	applyRegionRenames,
	type RegionReformSpec,
	type RegionRenameSpec,
} from "@mailwoman/gazetteer/tools/pipeline/wof/region-reform"

const { values } = parseArguments({
	options: {
		spec: { type: "string", description: "The reform or rename specification, a JSON file" },
		repos: { type: "string", description: "WOF repos root. Default <cache-root>/sources/wof-repos" },
		report: { type: "string", description: "Write the whole result to this JSON file" },
		"dry-run": { type: "boolean", default: false, description: "Report the changes and write no record" },
	},
})

if (!values.spec) throw new Error("--spec <file> is required")

const spec = await readLocalJSONFile<RegionReformSpec | RegionRenameSpec>(values.spec)

const options = {
	reposRoot: values.repos ?? wofReposPath,
	geonamesDir: dataRootPath("geonames"),
	dryRun: values["dry-run"] ?? false,
	lastModified: Math.floor(Date.now() / 1000),
}

if ("renames" in spec) {
	for (const rename of await applyRegionRenames(spec, options)) {
		console.log(`${rename.id}: ${rename.from} → ${rename.to}`)
	}

	process.exit(0)
}

const result = await applyRegionReform(spec, options)

if (values.report) {
	await writeLocalJSONFile(result, values.report)
}

const written = result.units.filter((unit) => unit.written).length

console.log(`${values["dry-run"] ? "dry run" : "applied"}: ${result.repoDir}`)
console.log(`units: ${result.units.length} (${written} new records, ${result.units.length - written} existing)`)
console.log(
	`replaced regions marked ceased: ${result.ceased.map((region) => `${region.name} → ${region.supersededBy.length}`).join(", ")}`
)
console.log(
	`records moved: ${result.moved.byGeoNames} by GeoNames first-level code, ${result.moved.byMembership} by member ancestor`
)
console.log(`GeoNames unit differs from the member ancestor's unit: ${result.geonamesOverrides}`)
console.log(`records left unplaced: ${result.unplaced.length}`)
