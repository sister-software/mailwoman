// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes `data/normalized/iso3166-1.json`, `data/normalized/iata-airports.json`,
 *   `data/normalized/language-subtags.json` and `data/manifests/coverage.json` from the pinned sources.
 *
 *   Usage: `node packages/registry/tools/normalize.run.ts`
 *
 *   The run refuses a source file whose digest differs from `data/manifests/sources.lock.json`.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { workspacePathBuilder } from "@mailwoman/core/paths"
import { stringifyJSON } from "@mailwoman/core/values/json"

import { readSourceLock } from "#sdk/fetch"
import { pinnedSourceFile, SOURCES } from "#sdk/sources"
import { normalizeSubtags, SUBTAG_TYPES } from "#tools/language-subtags"
import { formatNormalized, normalizeFromLock } from "#tools/normalize"

const lock = await readSourceLock()

if (!lock) throw new Error("no sources.lock.json; run packages/registry/sdk/fetch.run.ts --repin first")

const { countries, airports, coverage } = await normalizeFromLock(lock)
const data = workspacePathBuilder("registry", "data")
const subtagSource = SOURCES.find((source) => source.id === "iana-language-subtags")!

const subtags = normalizeSubtags(await readLocalTextFile(pinnedSourceFile(subtagSource)), lock.profile, subtagSource.id)

for (const type of SUBTAG_TYPES) {
	const records = subtags.records.filter((record) => record.type === type)

	coverage.namespaces[`bcp47-${type}`] = {
		source: subtagSource.id,
		count: records.length,
		statuses: {
			current: records.filter((record) => !record.deprecated).length,
			deprecated: records.filter((record) => record.deprecated).length,
		},
		missMeans: `not-found-in-snapshot: the registry's File-Date ${subtags.fileDate} edition holds no such subtag`,
	}
}

await writeLocalFile(formatNormalized(countries), data("normalized", "iso3166-1.json"))
await writeLocalFile(formatNormalized(airports), data("normalized", "iata-airports.json"))
await writeLocalFile(formatNormalized(subtags), data("normalized", "language-subtags.json"))
await writeLocalJSONFile(coverage, data("manifests", "coverage.json"))

console.log(
	`countries: ${countries.records.length} (${stringifyJSON(coverage.namespaces["iso3166-1-alpha2"]!.statuses)})`
)
console.log(`airports: ${airports.records.length} (${stringifyJSON(coverage.namespaces["iata-location"]!.statuses)})`)
console.log(`subtags: ${subtags.records.length} (File-Date ${subtags.fileDate})`)
console.log(`country lists:${coverage.namespaces["$countryListComparison"]!.kinds!.join("; ")}`)
