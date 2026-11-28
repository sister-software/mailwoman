// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes a ceased `country` record for each former country of a specification
 *   into the `mailwoman` fork of `whosonfirst-data-admin-xy`.
 *
 *   The library is `@mailwoman/gazetteer/tools/pipeline/wof/former-countries`.
 *
 *   The specification is `packages/gazetteer/tools/pipeline/xy/former-countries.json`.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/data/wof/former-countries.run.ts
 *   --spec <file> [--dry-run]
 */

import { wofReposPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { writeFormerCountries, type FormerCountrySpec } from "@mailwoman/gazetteer/tools/pipeline/wof/former-countries"

const { values } = parseArguments({
	options: {
		spec: { type: "string", description: "The former-country specification, a JSON file" },
		repos: { type: "string", description: "WOF repos root. Default <cache-root>/sources/wof-repos" },
		report: { type: "string", description: "Write the whole result to this JSON file" },
		"dry-run": { type: "boolean", default: false, description: "Report the records and write no file" },
	},
})

const result = await writeFormerCountries({
	spec: await readLocalJSONFile<FormerCountrySpec>(requiredArgument("wof-former-countries", "spec", values.spec)),
	reposRoot: values.repos ?? wofReposPath,
	dryRun: values["dry-run"],
	lastModified: Math.floor(Date.now() / 1000),
})

if (values.report) {
	await writeLocalJSONFile(result, values.report)
}

console.log(`${values["dry-run"] ? "dry run" : "applied"}: ${result.repoDir}`)

for (const row of result.written) {
	console.log(
		`${row.id} ${row.name}: superseded by ${row.supersededBy.join(", ") || "-"}; supersedes ${row.supersedes.join(", ") || "-"}`
	)
}

console.log(`already held: ${result.alreadyHeld.map((row) => `${row.name} (${row.id})`).join(", ") || 0}`)
console.log(
	`successors without a record: ${result.unresolved.map((row) => `${row.name} → ${row.successor}`).join(", ") || 0}`
)
