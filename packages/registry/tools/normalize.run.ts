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

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { workspacePath, workspacePathBuilder } from "@mailwoman/core/paths"
import { isoDate } from "@mailwoman/core/utils"
import { stringifyJSON } from "@mailwoman/core/values/json"

import { readSourceLock } from "#sdk/fetch"
import { type GroupingDefinitions, pinnedSourceFile, type SourceID, SOURCES } from "#sdk/sources"
import { formatGroupings, normalizeGroupings } from "#tools/groupings"
import { normalizeSubtags, SUBTAG_TYPES } from "#tools/language-subtags"
import { formatNormalized, normalizeFromLock, type SPARQLResults, sourceDefinition } from "#tools/normalize"

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

const groupingDefinitions = await readLocalJSONFile<GroupingDefinitions>(
	workspacePath("registry", "definitions", "groupings.json")
)

/**
 * The date of a source's stated publication marker, or null when the server stated none.
 */
const publishedOn = (id: SourceID): string | null => {
	const marker = lock.sources[id]?.publication

	return marker && marker !== "unstated" ? isoDate(new Date(marker)) : null
}

const { normalized: groupings, reports } = normalizeGroupings({
	definitions: groupingDefinitions,
	countries: countries.records,
	p463: await readLocalJSONFile<SPARQLResults>(pinnedSourceFile(sourceDefinition("wikidata-memberships-p463"))),
	p527: await readLocalJSONFile<SPARQLResults>(pinnedSourceFile(sourceDefinition("wikidata-memberships-p527"))),
	worldbank: await readLocalJSONFile<unknown>(pinnedSourceFile(sourceDefinition("worldbank-countries"))),
	worldbankAsOf: publishedOn("worldbank-countries"),
	wikitext: await readLocalTextFile(pinnedSourceFile(sourceDefinition("wikipedia-developed-country"))),
	wikitextAsOf: publishedOn("wikipedia-developed-country"),
	profile: lock.profile,
})

coverage.namespaces["country-grouping"] = {
	source: "wikidata-memberships-p463, wikidata-memberships-p527, worldbank-countries, wikipedia-developed-country",
	count: groupings.groupings.length,
	statuses: {
		answering: groupings.groupings.filter((grouping) => !grouping.blockedBy.length).length,
		blocked: groupings.groupings.filter((grouping) => grouping.blockedBy.length).length,
	},
	missMeans: "not-declared: definitions/groupings.json declares no grouping with this id",
}

coverage.groupings = reports

await writeLocalFile(formatGroupings(groupings), data("normalized", "groupings.json"))
await writeLocalFile(formatNormalized(countries), data("normalized", "iso3166-1.json"))
await writeLocalFile(formatNormalized(airports), data("normalized", "iata-airports.json"))
await writeLocalFile(formatNormalized(subtags), data("normalized", "language-subtags.json"))
await writeLocalJSONFile(coverage, data("manifests", "coverage.json"))

console.log(
	`countries: ${countries.records.length} (${stringifyJSON(coverage.namespaces["iso3166-1-alpha2"]!.statuses)})`
)
console.log(`airports: ${airports.records.length} (${stringifyJSON(coverage.namespaces["iata-location"]!.statuses)})`)
console.log(`subtags: ${subtags.records.length} (File-Date ${subtags.fileDate})`)

for (const grouping of groupings.groupings) {
	const members = groupings.records.filter((row) => row.grouping === grouping.id && row.role === "member").length
	const report = reports[grouping.id]!

	console.log(
		`grouping ${grouping.id}: ${grouping.blockedBy.length ? `blocked (${grouping.blockedBy.join("; ")})` : `${members} member rows`}` +
			(report.crossCheck
				? `, ${report.crossCheck.property} states ${report.crossCheck.otherStates}` +
					(report.crossCheck.onlySelected.length
						? `, only selected: ${report.crossCheck.onlySelected.join(" ")}`
						: "") +
					(report.crossCheck.onlyOther.length
						? `, only ${report.crossCheck.property}: ${report.crossCheck.onlyOther.join(" ")}`
						: "")
				: "") +
			(report.uncoded.length ? `, uncoded: ${report.uncoded.join(" ")}` : "")
	)
}

console.log(`country lists:${coverage.namespaces["$countryListComparison"]!.kinds!.join("; ")}`)
