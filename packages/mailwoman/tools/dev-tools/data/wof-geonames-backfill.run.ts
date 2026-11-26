// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes a locality record into a country's `mailwoman` WOF fork for each GeoNames
 *   populated place the fork holds no record of.
 *
 *   The library is `@mailwoman/gazetteer/tools/pipeline/wof/geonames-backfill`.
 *
 *   The places come from `--geonames-id`, given once per place, or from `--candidates`,
 *   the list of unmatched GeoNames places the admin build writes beside its
 *   output (`<admin database>.wof-candidates.jsonl`).
 *   `--min-population` keeps the candidates GeoNames gives at least that population.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/data/wof-geonames-backfill.run.ts
 *   --country BW --geonames-id 933773 [--dry-run]
 */

import { dataRootPath, wofReposPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { backfillGeoNamesPlaces, readGeoNamesPlaces } from "@mailwoman/gazetteer/tools/pipeline/wof/geonames-backfill"
import { JSONSpliterator } from "spliterator"

const { values } = parseArguments({
	options: {
		country: { type: "string", description: "ISO 3166-1 alpha-2 code of the fork to write" },
		"geonames-id": { type: "string", multiple: true, description: "A GeoNames id to write a record for, repeatable" },
		candidates: { type: "string", description: "The admin build's wof-candidates.jsonl" },
		"min-population": { type: "string", description: "Keep candidates with at least this GeoNames population" },
		repos: { type: "string", description: "WOF repos root. Default <cache-root>/sources/wof-repos" },
		report: { type: "string", description: "Write the whole result to this JSON file" },
		"dry-run": { type: "boolean", default: false, description: "Report the records and write no file" },
	},
})

const country = requiredArgument("wof-geonames-backfill", "country", values.country).toUpperCase()
const geonamesDir = dataRootPath("geonames")
const ids = (values["geonames-id"] ?? []).map(Number)

if (values.candidates) {
	const minimum = Number(values["min-population"] ?? 0)
	const places = minimum > 0 ? await readGeoNamesPlaces(geonamesDir, country) : null

	for await (const row of JSONSpliterator.fromAsync<{ country: string; geonamesID?: number }>(values.candidates)) {
		if (row.country !== country || typeof row.geonamesID !== "number") continue

		if (places && (places.get(row.geonamesID)?.population ?? 0) < minimum) continue

		ids.push(row.geonamesID)
	}
}

const result = await backfillGeoNamesPlaces({
	country,
	geonamesIDs: ids,
	reposRoot: values.repos ?? wofReposPath,
	geonamesDir,
	dryRun: values["dry-run"],
	lastModified: Math.floor(Date.now() / 1000),
})

if (values.report) {
	await writeLocalJSONFile(result, values.report)
}

console.log(`${values["dry-run"] ? "dry run" : "applied"}: ${result.repoDir}`)
console.log(`requested: ${new Set(ids).size}`)
console.log(`records written: ${result.written.length}`)
console.log(`already held by a record's gn:id: ${result.alreadyHeld}`)
console.log(`left out by feature code: ${stringifyJSON(result.leftOut)}`)
console.log(`no row in the GeoNames file: ${result.unknown.length}`)
console.log(`inside no boundary of the fork: ${result.unlocated.length}`)
